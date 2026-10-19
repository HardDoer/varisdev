import {
  getAgentDir,
  type ExtensionContext,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve, win32, posix} from 'node:path';
import {workspaceConfigPaths} from '../dashboard/workspace-config.ts';
import {prepareFileQuery} from '../tools/file-matches.ts';
import {resolveImagePath} from '../image-preview/files.ts';
import {
  resolveInputImagePath,
  resolveOutputDir as resolveImageOutputDir,
} from '../tools/openai-image.ts';
import {
  canonicalApprovalWorkspace,
  defaultAgentApprovalStore,
  snapshotApprovalOperation,
  type AgentApprovalChoice,
  type AgentApprovalDecision,
  type AgentApprovalScope,
  type AgentApprovalStore,
} from './approvals.ts';
import {requestAgentApproval} from './approval-ui.ts';
import {piModuleURL} from '../runtime/pi-paths.ts';

const {resolveReadPath, resolveToCwd} = (await import(
  piModuleURL('core/tools/path-utils.js').href
)) as {
  resolveReadPath(path: string, cwd: string): string;
  resolveToCwd(path: string, cwd: string): string;
};

export type AgentPermissionEffect = 'allow' | 'ask' | 'deny';
export interface AgentPermissionRule {
  action: string;
  resource: string;
  effect: AgentPermissionEffect;
}
export interface AgentPolicyProfile {
  id?: string;
  permissions?: readonly AgentPermissionRule[];
  steps?: number;
}
export interface AgentPermissionRequest {
  action: string;
  resource: string;
  aliases?: readonly string[];
}
export interface AgentApprovalRequest extends AgentPermissionRequest {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  agentId?: string;
  conversationId?: string;
  workspace: string;
  choices: readonly AgentApprovalChoice[];
}
export interface AgentPolicyOptions {
  approvals?: AgentApprovalStore;
  skills?: () => readonly {name: string; filePath: string; baseDir?: string}[];
  signal?: () => AbortSignal | undefined;
  onInputBlocked?: (reason: string) => void;
  approval?:
    | ((
        request: AgentApprovalRequest,
        ctx: ExtensionContext,
      ) => Promise<AgentApprovalDecision>)
    | {
        hasUI: boolean;
        confirm: ExtensionContext['ui']['confirm'];
        select?: (
          request: AgentApprovalRequest,
          ctx: ExtensionContext,
        ) => Promise<AgentApprovalDecision>;
      };
  label?: string;
}

const TOOL_BASELINE_ENTRY = 'varisdev.agent-policy-tools';
export const AGENT_STEP_SUMMARY =
  'This is your final allowed model step. Tools are unavailable. Summarize your progress, results, and any remaining work in text.';

function wildcard(pattern: string, value: string, ignoreCase = false): boolean {
  const expression = pattern
    .split(/([*?])/)
    .map(part =>
      part === '*'
        ? '.*'
        : part === '?'
          ? '.'
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${expression}$`, ignoreCase ? 'is' : 's').test(value);
}

function pathResource(action: string): boolean {
  return (
    action === 'read' || action === 'edit' || action === 'external_directory'
  );
}

function expandRuleHome(value: string): string {
  const home = process.env.HOME || homedir();
  return value.replace(/^(?:~|\$HOME|\$\{HOME\})(?=[/\\]|$)/, () => home);
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? win32.normalize(value).replaceAll('\\', '/')
    : posix.normalize(value);
}

/** Resolve symlinks even when a write's final path does not exist yet. */
function canonicalPath(
  value: string,
  cwd: string,
  platform = process.platform,
): string {
  const paths = platform === 'win32' ? win32 : posix;
  const absolute = paths.resolve(cwd, value);
  if (platform !== process.platform) return normalizedPath(absolute, platform);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      return normalizedPath(join(realpathSync(existing), ...missing), platform);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(existing);
      if (parent === existing) return normalizedPath(absolute, platform);
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

function within(
  path: string,
  directory: string,
  platform = process.platform,
): boolean {
  const paths = platform === 'win32' ? win32 : posix;
  const value = paths.relative(directory, path).replaceAll('\\', '/');
  return value !== '..' && !value.startsWith('../') && !paths.isAbsolute(value);
}

function internalPath(
  path: string,
  cwd: string,
  platform = process.platform,
): boolean {
  if (within(path, canonicalPath(cwd, cwd, platform), platform)) return true;
  if (platform !== process.platform) return false;
  const project = canonicalPath(
    workspaceConfigPaths(cwd).projectDir,
    cwd,
    platform,
  );
  return dirname(project) !== project && within(path, project, platform);
}

function physicalReadPermissions(
  paths: readonly string[],
  cwd: string,
): AgentPermissionRequest[] {
  return paths.flatMap(path => {
    const resource = canonicalPath(path, cwd);
    return [
      {action: 'read', resource},
      ...(!internalPath(resource, cwd)
        ? [{action: 'external_directory', resource}]
        : []),
    ];
  });
}

/** Ordered rules match canonical actions and, optionally, the actual tool name. */
export function decideAgentPermission(
  profile: AgentPolicyProfile,
  action: string,
  resource: string | readonly string[],
  toolName?: string,
  cwd?: string,
  platform = process.platform,
): AgentPermissionEffect {
  let effect: AgentPermissionEffect = 'allow';
  for (const rule of profile.permissions ?? []) {
    if (
      !wildcard(rule.action, action) &&
      !(toolName && wildcard(rule.action, toolName))
    )
      continue;
    for (const candidate of typeof resource === 'string'
      ? [resource]
      : resource) {
      const filesystem = pathResource(action);
      const pathlike = filesystem || action === 'glob' || action === 'list';
      let pattern = filesystem ? expandRuleHome(rule.resource) : rule.resource;
      let target = candidate;
      if (pathlike) {
        pattern = normalizedPath(pattern, platform);
        target = normalizedPath(target, platform);
      }
      if (cwd && filesystem) {
        const paths = platform === 'win32' ? win32 : posix;
        target = canonicalPath(candidate, cwd, platform);
        if (paths.isAbsolute(pattern))
          pattern = canonicalPath(pattern, cwd, platform);
        else if (internalPath(target, cwd, platform))
          target = normalizedPath(
            paths.relative(canonicalPath(cwd, cwd, platform), target) || '.',
            platform,
          );
      }
      const ignoreCase =
        (pathlike && platform === 'win32') ||
        (action === 'shell' && toolName === 'powershell');
      if (
        wildcard(pattern, target, ignoreCase) ||
        (action === 'shell' &&
          pattern.endsWith(' *') &&
          wildcard(pattern.slice(0, -2), target, ignoreCase))
      ) {
        effect = rule.effect;
        break;
      }
    }
  }
  return effect;
}

/** Pure catalog-friendly variant accepting an ordered rule list. */
export function evaluateAgentPermission(
  rules: readonly AgentPermissionRule[] | undefined,
  action: string,
  resource: string,
  cwd?: string,
  platform = process.platform,
): AgentPermissionEffect {
  return decideAgentPermission(
    {permissions: rules},
    action,
    resource,
    undefined,
    cwd,
    platform,
  );
}

function text(
  input: Record<string, unknown>,
  key: string,
  fallback = '*',
): string {
  return typeof input[key] === 'string' ? input[key] : fallback;
}

function templateId(selector: string): string {
  return selector.replace(/^(builtin|global|repository|workspace):/, '');
}

/** Hidden templates are filtered by the catalog owner; ask rules remain discoverable. */
export function agentCatalogAllows(
  profile: AgentPolicyProfile,
  id: string,
): boolean {
  return (
    decideAgentPermission(
      profile,
      'subagent',
      templateId(id),
      'agent_spawn',
    ) !== 'deny'
  );
}

function patchPaths(input: Record<string, unknown>): string[] {
  const patch = text(
    input,
    'patch',
    text(input, 'input', text(input, 'patchText', '')),
  );
  return Array.from(
    patch.matchAll(
      /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
    ),
    match => match[1],
  );
}

function templateMutationPath(
  input: Record<string, unknown>,
  cwd: string,
): string {
  if (typeof input.sourcePath === 'string') return input.sourcePath;
  const agentDir = resolve(getAgentDir());
  const paths = workspaceConfigPaths(cwd, agentDir);
  const directory =
    input.scope === 'global'
      ? agentDir
      : input.scope === 'repository'
        ? paths.repositoryConfigDir
        : input.scope === 'workspace'
          ? paths.workspaceDir
          : undefined;
  return directory && typeof input.id === 'string'
    ? join(directory, 'agents', `${input.id}.md`)
    : '*';
}

/** Map input resources; template gets and file queries also require discovery preflight. */
export function agentToolPermissions(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): AgentPermissionRequest[] {
  const request = (
    action: string,
    resource: string,
  ): AgentPermissionRequest => ({action, resource});
  let requests: AgentPermissionRequest[];
  switch (toolName) {
    case 'bash':
    case 'powershell':
      requests = [request('shell', text(input, 'command'))];
      break;
    case 'read':
    case 'json_query':
    case 'gamemaker_query':
    case 'image_query':
    case 'image_preview':
      requests = [request('read', text(input, 'path'))];
      break;
    case 'write':
    case 'edit':
    case 'download':
      requests = [request('edit', text(input, 'path'))];
      break;
    case 'apply_patch': {
      const paths = patchPaths(input);
      requests = (paths.length ? paths : ['*']).map(path =>
        request('edit', path),
      );
      break;
    }
    case 'find':
      requests = [request('glob', text(input, 'pattern'))];
      break;
    case 'ls':
      requests = [request('list', text(input, 'path', '.'))];
      break;
    case 'grep':
      requests = [request('grep', text(input, 'pattern'))];
      break;
    case 'browse':
      requests = [request('webfetch', text(input, 'url'))];
      break;
    case 'codemode':
      requests = [request('execute', '*')];
      break;
    case 'agent_spawn':
      requests = [
        request('subagent', templateId(text(input, 'template', 'default'))),
      ];
      break;
    case 'agent_templates':
      requests = [
        request(
          input.action === 'save' || input.action === 'delete'
            ? 'edit'
            : 'read',
          input.action === 'save' || input.action === 'delete'
            ? templateMutationPath(input, cwd ?? process.cwd())
            : 'agent_templates',
        ),
      ];
      break;
    case 'openai_image': {
      const paths = Array.isArray(input.inputImagePaths)
        ? input.inputImagePaths
        : [];
      requests = [
        ...paths
          .filter((path): path is string => typeof path === 'string')
          .map(path =>
            request('read', resolveInputImagePath(cwd ?? process.cwd(), path)),
          ),
        request(
          'edit',
          `${resolveImageOutputDir(
            cwd ?? process.cwd(),
            typeof input.outputDir === 'string' ? input.outputDir : undefined,
          )}/**`,
        ),
      ];
      break;
    }
    default:
      requests = [
        request(
          toolName,
          text(
            input,
            'path',
            text(input, 'command', text(input, 'url', text(input, 'id'))),
          ),
        ),
      ];
  }
  const files = requests.filter(
    entry =>
      entry.action === 'edit' ||
      (entry.action === 'read' && toolName !== 'agent_templates'),
  );
  for (const entry of files) {
    if (!cwd) {
      entry.resource = entry.resource.replace(/^@/, '');
      continue;
    }
    if (entry.resource === '*') continue;
    let path = entry.resource;
    if (toolName === 'read') path = resolveReadPath(path, cwd);
    else if (toolName === 'write' || toolName === 'edit')
      path = resolveToCwd(path, cwd);
    else if (toolName === 'image_preview')
      path = resolveImagePath(path, cwd) ?? path;
    else if (
      !['agent_templates', 'apply_patch', 'openai_image'].includes(toolName)
    )
      path = path.trim().replace(/^@/, '');
    entry.resource = canonicalPath(path, cwd);
  }
  if (cwd) {
    const paths = files
      .filter(entry => entry.resource !== '*')
      .map(entry => entry.resource);
    if (toolName === 'find' || toolName === 'grep' || toolName === 'ls')
      paths.push(
        canonicalPath(resolveToCwd(text(input, 'path', '.'), cwd), cwd),
      );
    for (const path of paths)
      if (!internalPath(path, cwd))
        requests.push(request('external_directory', path));
  }
  return requests;
}

function mandatoryActions(toolName: string): string[] {
  // These tools have both read and write operations, so no single denied action
  // makes their entire declaration unavailable.
  if (toolName === 'agent_templates') return [];
  if (toolName === 'openai_image') return ['edit'];
  return agentToolPermissions(toolName, {}).map(request => request.action);
}

/** Conservative: keep declarations whenever a later exception could allow a call. */
export function isAgentToolWhollyDenied(
  profile: AgentPolicyProfile,
  toolName: string,
): boolean {
  const actions = mandatoryActions(toolName);
  if (!actions.length) {
    return ['read', 'edit'].every(action =>
      actionWhollyDenied(profile, action, toolName),
    );
  }
  return actions.some(action => actionWhollyDenied(profile, action, toolName));
}

function actionWhollyDenied(
  profile: AgentPolicyProfile,
  action: string,
  toolName: string,
): boolean {
  let denied = false;
  for (const rule of profile.permissions ?? []) {
    if (!wildcard(rule.action, action) && !wildcard(rule.action, toolName))
      continue;
    if (/^\*+$/.test(rule.resource)) denied = rule.effect === 'deny';
    else if (rule.effect !== 'deny') denied = false;
  }
  return denied;
}

async function withAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Approval cancelled.'));
      signal.addEventListener('abort', abort, {once: true});
    });
    return await Promise.race([cancelled, operation()]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function agentPolicySignal(ctx: ExtensionContext, options: AgentPolicyOptions) {
  const relay = options.signal?.();
  return ctx.signal && relay && ctx.signal !== relay
    ? AbortSignal.any([ctx.signal, relay])
    : (ctx.signal ?? relay);
}

/** Shared policy and approval path for tools and commands that load resources. */
export async function checkAgentPermissions(
  profile: AgentPolicyProfile,
  toolName: string,
  input: Record<string, unknown>,
  requests: readonly AgentPermissionRequest[],
  ctx: ExtensionContext,
  options: AgentPolicyOptions = {},
): Promise<{block: true; reason: string} | undefined> {
  const signal = agentPolicySignal(ctx, options);
  if (signal?.aborted)
    return {block: true, reason: 'Agent permission check cancelled.'};
  const unique = [
    ...new Map(
      requests.map(request => [
        JSON.stringify([request.action, request.resource, request.aliases]),
        request,
      ]),
    ).values(),
  ];
  const decisions = unique.map(request => ({
    ...request,
    effect: decideAgentPermission(
      profile,
      request.action,
      request.aliases?.length
        ? [request.resource, ...request.aliases]
        : request.resource,
      request.action === 'external_directory' ? undefined : toolName,
      ctx.cwd,
    ),
  }));
  const denied = decisions.find(request => request.effect === 'deny');
  if (denied)
    return {
      block: true,
      reason: `Agent permission denied: ${denied.action} ${denied.resource}`,
    };
  const asked = decisions.filter(request => request.effect === 'ask');
  if (!asked.length) return undefined;
  const workspace = canonicalApprovalWorkspace(ctx.cwd);
  const conversationId = ctx.sessionManager?.getSessionId?.();
  const scope: AgentApprovalScope | undefined =
    profile.id && conversationId
      ? {agentId: profile.id, conversationId, workspace}
      : undefined;
  const store = options.approvals ?? defaultAgentApprovalStore();
  for (const request of asked) {
    try {
      signal?.throwIfAborted();
      const operation = snapshotApprovalOperation({
        toolName,
        input,
        ...request,
      });
      if (scope && (await store.allows(scope, operation, signal))) {
        signal?.throwIfAborted();
        continue;
      }
      signal?.throwIfAborted();
      const relay = options.approval;
      if (typeof relay !== 'function' && !(relay?.hasUI ?? ctx.hasUI))
        return {
          block: true,
          reason: `Agent permission requires approval, but approval is unavailable: ${request.action} ${request.resource}`,
        };
      const title = options.label
        ? `Agent permission: ${options.label}`
        : 'Agent permission';
      const approvalRequest: AgentApprovalRequest = {
        ...snapshotApprovalOperation(operation),
        signal,
        workspace,
        agentId: scope?.agentId,
        conversationId: scope?.conversationId,
        choices: scope
          ? ['once', 'conversation', 'agent', 'deny']
          : ['once', 'deny'],
      };
      const approved = await withAbort(
        () =>
          typeof relay === 'function'
            ? relay(approvalRequest, ctx)
            : relay?.select
              ? relay.select(approvalRequest, ctx)
              : relay
                ? relay.confirm(
                    title,
                    `${toolName}: ${request.action} ${request.resource}`,
                    {signal},
                  )
                : requestAgentApproval(approvalRequest, ctx),
        signal,
      );
      signal?.throwIfAborted();
      if (
        approved !== true &&
        approved !== 'once' &&
        approved !== 'conversation' &&
        approved !== 'agent'
      )
        return {
          block: true,
          reason: `Agent permission approval declined: ${request.action} ${request.resource}`,
        };
      if (approved === 'conversation' || approved === 'agent') {
        if (!scope)
          return {
            block: true,
            reason:
              'Remembered approval requires agent and conversation identities.',
          };
        await store.remember(scope, operation, approved, signal);
      }
      signal?.throwIfAborted();
    } catch (error) {
      return {
        block: true,
        reason: `Agent permission approval cancelled: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return undefined;
}

/** Snapshot a conversation's policy and enforce it through Pi's tool pipeline. */
export function createAgentPolicyExtension(
  profile: AgentPolicyProfile,
  options: AgentPolicyOptions = {},
): ExtensionFactory {
  if (
    profile.steps !== undefined &&
    (!Number.isInteger(profile.steps) || profile.steps < 1)
  )
    throw new Error('Agent steps must be a positive integer.');
  const snapshot: AgentPolicyProfile = Object.freeze({
    id: profile.id,
    steps: profile.steps,
    permissions: Object.freeze(
      (profile.permissions ?? []).map(rule => Object.freeze({...rule})),
    ),
  });
  return pi => {
    const signalFor = (ctx: ExtensionContext) =>
      agentPolicySignal(ctx, options);
    const skillRequests = (
      requests: readonly AgentPermissionRequest[],
      cwd: string,
    ): AgentPermissionRequest[] => {
      const skills = options.skills?.() ?? [];
      if (!skills.length) return [];
      const reads = new Set(
        requests
          .filter(request => request.action === 'read')
          .map(request => canonicalPath(request.resource, cwd)),
      );
      return skills
        .filter(skill => reads.has(canonicalPath(skill.filePath, cwd)))
        .map(skill => ({action: 'skill', resource: skill.name}));
    };
    let turns = 0;
    let finalTurn = false;
    let savedTools: string[] | undefined;
    let appliedTools: string[] | undefined;
    let storedTools: string[] | undefined;
    let storedFinalStep = false;
    let initialized = false;
    const persistTools = (tools: string[], finalStep = finalTurn) => {
      if (
        snapshot.steps === undefined ||
        (JSON.stringify(storedTools) === JSON.stringify(tools) &&
          storedFinalStep === finalStep)
      )
        return;
      pi.appendEntry(TOOL_BASELINE_ENTRY, {tools: [...tools], finalStep});
      storedTools = [...tools];
      storedFinalStep = finalStep;
    };
    const initialize = (ctx: ExtensionContext) => {
      const entry = ctx.sessionManager
        .getBranch()
        .findLast(
          entry =>
            entry.type === 'custom' && entry.customType === TOOL_BASELINE_ENTRY,
        );
      const data = entry?.type === 'custom' ? entry.data : undefined;
      const record =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as {tools?: unknown; finalStep?: unknown})
          : undefined;
      const names = record?.tools ?? data;
      storedTools =
        Array.isArray(names) && names.every(name => typeof name === 'string')
          ? [...names]
          : undefined;
      storedFinalStep = record?.finalStep === true;
      // A late registration can leave declarations even on the final step, so
      // recover its saved selection independently of the restored active set.
      const active = pi.getActiveTools();
      if (
        snapshot.steps !== undefined &&
        storedTools &&
        (storedFinalStep || active.length === 0)
      )
        pi.setActiveTools(
          storedTools.length ? [...new Set([...storedTools, ...active])] : [],
        );
      turns = 0;
      savedTools = undefined;
      appliedTools = undefined;
      finalTurn = false;
      initialized = true;
    };
    const captureToolChanges = () => {
      if (!savedTools || !appliedTools) return;
      const active = new Set(pi.getActiveTools());
      const previous = new Set(appliedTools);
      savedTools = savedTools.filter(
        name => !previous.has(name) || active.has(name),
      );
      for (const name of active) {
        if (!previous.has(name) && !savedTools.includes(name))
          savedTools.push(name);
      }
    };
    const applyTools = () => {
      captureToolChanges();
      const tools = savedTools ?? pi.getActiveTools();
      pi.setActiveTools(
        finalTurn
          ? []
          : tools.filter(name => !isAgentToolWhollyDenied(snapshot, name)),
      );
      appliedTools = pi.getActiveTools();
      if (savedTools) persistTools(savedTools);
    };
    const prepareTools = () => {
      finalTurn = snapshot.steps !== undefined && turns + 1 >= snapshot.steps;
      applyTools();
    };
    pi.on('session_start', (_event, ctx) => initialize(ctx));
    pi.on('session_shutdown', () => {
      captureToolChanges();
      persistTools(
        savedTools ?? pi.getActiveTools(),
        savedTools ? finalTurn : storedFinalStep,
      );
    });
    pi.on('before_agent_start', (event, ctx) => {
      if (!initialized) initialize(ctx);
      savedTools = pi.getActiveTools();
      appliedTools = [...savedTools];
      if (event.messageType === 'user') turns = 0;
      prepareTools();
    });
    pi.on('input', async (event, ctx) => {
      const skill = /^\/skill:([^\s]+)/.exec(event.text)?.[1];
      if (skill) {
        const denied = await checkAgentPermissions(
          snapshot,
          `/skill:${skill}`,
          {name: skill},
          [{action: 'skill', resource: skill}],
          ctx,
          options,
        );
        if (denied) {
          options.onInputBlocked?.(denied.reason);
          ctx.ui.notify(denied.reason, 'error');
          return {action: 'handled' as const};
        }
      }
      // Input arrives before the SDK captures the next request's declarations.
      // message_start for a user message runs after turn_start and is too late.
      turns = 0;
      if (savedTools) prepareTools();
      return {action: 'continue' as const};
    });
    pi.on('turn_start', (_event, ctx) => {
      turns++;
      if (snapshot.steps !== undefined && turns > snapshot.steps) ctx.abort();
    });
    // Pi captures schemas for the next request before turn_start.
    pi.on('turn_end', (event, ctx) => {
      if (snapshot.steps !== undefined && turns >= snapshot.steps) {
        // Stop a provider that emits a tool call despite receiving no tools.
        if (
          event.message.role === 'assistant' &&
          event.message.content.some(part => part.type === 'toolCall')
        )
          ctx.abort();
        return;
      }
      prepareTools();
    });
    pi.on('context_with_system', event => {
      if (!savedTools) return;
      // A later extension can activate/register tools after the boundary hook.
      applyTools();
      let changed = false;
      const messages = event.messages.map(message => {
        if (message.role !== 'system' || !message.toolsAdded) return message;
        const toolsAdded = finalTurn
          ? []
          : message.toolsAdded.filter(
              tool => !isAgentToolWhollyDenied(snapshot, tool.name),
            );
        if (toolsAdded.length === message.toolsAdded.length) return message;
        changed = true;
        return {...message, toolsAdded};
      });
      if (finalTurn) {
        messages.push({
          role: 'system',
          content: AGENT_STEP_SUMMARY,
          timestamp: Date.now(),
        });
        changed = true;
      }
      return changed ? {messages} : undefined;
    });
    pi.on('agent_end', () => {
      captureToolChanges();
      if (savedTools) {
        persistTools(savedTools);
        pi.setActiveTools(savedTools);
      }
      savedTools = undefined;
      appliedTools = undefined;
      finalTurn = false;
    });
    pi.on('tool_call', async (event, ctx) => {
      if (finalTurn)
        return {
          block: true,
          terminate: true,
          reason: 'Agent step limit reached; summarize in text.',
        };
      const input = event.input as Record<string, unknown>;
      try {
        let requests = agentToolPermissions(event.toolName, input, ctx.cwd);
        if (event.toolName === 'agent_templates' && input.action === 'get') {
          signalFor(ctx)?.throwIfAborted();
          const {prepareAgentTemplateGet} = await import('./templates.ts');
          const prepared = await prepareAgentTemplateGet(ctx.cwd, input);
          requests = physicalReadPermissions(prepared.sourcePaths, ctx.cwd);
        }
        if (!isAgentToolWhollyDenied(snapshot, event.toolName)) {
          if (
            (event.toolName === 'bash' || event.toolName === 'powershell') &&
            snapshot.permissions?.some(
              rule =>
                rule.effect !== 'allow' &&
                (wildcard(rule.action, 'shell') ||
                  wildcard(rule.action, event.toolName) ||
                  wildcard(rule.action, 'external_directory')),
            )
          ) {
            const {scanAgentShell} = await import('./scanner.ts');
            const scan = await scanAgentShell(
              event.toolName,
              text(input, 'command', ''),
              ctx.cwd,
              signalFor(ctx),
            );
            if (scan.commands.length)
              requests = [
                ...requests.filter(request => request.action !== 'shell'),
                ...scan.commands.map(command => ({
                  action: 'shell',
                  ...command,
                })),
              ];
            for (const path of scan.paths) {
              const resource = canonicalPath(path, ctx.cwd);
              if (!internalPath(resource, ctx.cwd))
                requests.push({action: 'external_directory', resource});
            }
          }
          const paths = await prepareFileQuery(
            event.toolName,
            input,
            ctx.cwd,
            signalFor(ctx),
          );
          if (paths?.length) requests = physicalReadPermissions(paths, ctx.cwd);
        }
        return await checkAgentPermissions(
          snapshot,
          event.toolName,
          input,
          [...requests, ...skillRequests(requests, ctx.cwd)],
          ctx,
          options,
        );
      } catch (error) {
        return {
          block: true,
          reason: `Agent permission check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  };
}
