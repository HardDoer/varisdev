import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionContext,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {registerProjectTools} from '../tools/index.ts';
import {createBuiltinExtensions} from '../builtin-extensions.ts';
import {createAppResourceFilter} from '../dashboard/resources.ts';
import {createWorkspaceConfiguration} from '../dashboard/workspace-config.ts';
import type {AgentWorker} from './orchestrator.ts';
import {registerParentModelProviders} from './model-runtime.ts';
import {projectTrustReloadOptions} from '../dashboard/project-trust.ts';
import {runSessionCommand} from '../dashboard/session-commands.ts';
import {runSettingsCommand} from '../dashboard/settings-commands.ts';
import type {DesktopExtensionUI} from '../dashboard/extension-ui.ts';
import {
  nativeCommand,
  parseSlashCommand,
} from '../dashboard/command-catalog.mjs';
import {WorkerConversation} from './conversation.ts';
import {registerCommitCommand} from '../commit.ts';
import {
  createDefaultAgentProfile,
  ensureAgentProfilePermissions,
  resolveDefaultAgentTemplate,
  type AgentContextScope,
  type AgentTemplate,
} from './templates.ts';
import {createAgentPolicyExtension, type AgentPolicyOptions} from './policy.ts';
import {showAgentApprovals} from './approval-ui.ts';
import {createAgentResourcePolicy} from './resources.ts';
import {
  sessionFeatures,
  supportedThinkingLevels,
  type SessionConfiguration,
} from '../dashboard/features.ts';
import {assertAgentModelAllowed, readToolSettings} from '../tools/settings.ts';
import {
  modelUsage,
  sessionUsageCalls,
  ModelUsageTracker,
  type ModelUsage,
} from '../usage.ts';

export interface WorkerOptions {
  id: string;
  parentSessionId: string;
  cwd: string;
  name: string;
  instructions?: string;
  context?: AgentContextScope;
  agentProfile?: AgentTemplate;
  approval?: AgentPolicyOptions['approval'];
  approvalUI?: ExtensionContext['ui'];
  model: NonNullable<CreateAgentSessionOptions['model']>;
  modelRegistry: ExtensionContext['modelRegistry'];
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel'];
  ui?: DesktopExtensionUI;
  projectTrustOverride?: boolean;
  agentToolsExtension: ExtensionFactory;
}

interface WorkerPromptState {
  signal?: AbortSignal;
  blocked?: string;
}

/** Adapt an already configured Pi session; factories resolve profile permissions first. */
export function sessionWorker(
  session: AgentSession,
  resultFile: string,
  profile: AgentTemplate = createDefaultAgentProfile(),
  promptState: WorkerPromptState = {},
  ui?: DesktopExtensionUI,
  approvalUI?: ExtensionContext['ui'],
): AgentWorker {
  const agentProfile = structuredClone(profile);
  if (
    !session.sessionManager
      .getBranch?.()
      .some(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      )
  )
    session.sessionManager.appendCustomEntry?.(
      'varisdev.agent-profile',
      structuredClone(agentProfile),
    );
  const usage = new ModelUsageTracker();
  const conversation = new WorkerConversation(
    session.sessionManager.getBranch?.() ?? [],
    session.sessionManager.getCwd?.(),
  );
  let commandController: AbortController | undefined;
  let finishing = false;
  let closing: Promise<void> | undefined;
  let publishUsage: ((usage: ModelUsage) => void) | undefined;
  function restoreUsage(): void {
    const branch = session.sessionManager.getBranch?.();
    if (branch) usage.replace(sessionUsageCalls(branch));
  }
  restoreUsage();
  const features = async () => {
    const result = sessionFeatures(
      session,
      session.resourceLoader,
      session.settingsManager,
    );
    result.agentProfile = {
      id: agentProfile.id,
      name: agentProfile.name,
      mode: agentProfile.mode,
      ...(agentProfile.color ? {color: agentProfile.color} : {}),
    };
    const allowedModels = agentProfile.model
      ? [agentProfile.model]
      : (await readToolSettings()).agents.allowedModels;
    if (allowedModels !== null) {
      const allowed = (model: {provider: string; id: string}) =>
        allowedModels.includes(`${model.provider}/${model.id}`);
      result.models = result.models.filter(allowed);
      result.scopedModels = result.scopedModels?.filter(item =>
        allowed(item.model),
      );
    }
    return result;
  };
  // Idle cache warming can append usage between runs. Keep this subscription
  // for the worker lifetime so the orchestrator's cached record stays current.
  const unsubscribeUsage = session.subscribe(event => {
    if (event.type !== 'entry_appended' || event.entry.type !== 'usage') return;
    restoreUsage();
    publishUsage?.(usage.snapshot());
  });
  const worker: AgentWorker = {
    sessionFile: session.sessionManager.getSessionFile(),
    resultFile,
    get usage() {
      restoreUsage();
      return usage.snapshot();
    },
    get context() {
      const context = session.getContextUsage?.();
      return context
        ? {
            tokens: context.tokens,
            window: context.contextWindow,
            percent: context.percent,
          }
        : undefined;
    },
    get conversation() {
      return conversation.snapshot();
    },
    features,
    async configure(input: SessionConfiguration) {
      let model = session.model;
      if (input.provider !== undefined || input.modelId !== undefined) {
        const provider = input.provider ?? model?.provider;
        const id = input.modelId ?? model?.id;
        if (!provider || !id) throw new Error('Specify a provider and model.');
        model = session.extensionRunner.getModelRegistry().find(provider, id);
        if (!model) throw new Error(`Model is unavailable: ${provider}/${id}`);
        await assertAgentModelAllowed(
          `${provider}/${id}`,
          undefined,
          agentProfile.model,
        );
      }
      const levels = model
        ? supportedThinkingLevels(model)
        : session.getAvailableThinkingLevels();
      if (
        input.thinkingLevel !== undefined &&
        !levels.includes(input.thinkingLevel)
      )
        throw new Error(`Thinking level must be one of: ${levels.join(', ')}.`);
      if (model && (input.modelId !== undefined || model !== session.model))
        await session.setModel(model, {persist: input.persist});
      if (input.thinkingLevel !== undefined)
        session.setThinkingLevel(
          input.thinkingLevel as Parameters<typeof session.setThinkingLevel>[0],
          {persist: input.persist},
        );
      return features();
    },
    async command(command) {
      const parsed = parseSlashCommand(command);
      if (
        !parsed ||
        ![
          'model',
          'thinking',
          'settings',
          'scoped-models',
          'session',
          'approvals',
        ].includes(parsed.name)
      )
        throw new Error(
          `Native command is unavailable in worker conversations: ${command}`,
        );
      if (!ui && !(parsed.name === 'approvals' && approvalUI))
        throw new Error('Worker native commands require an interactive UI.');
      const controller = new AbortController();
      commandController = controller;
      try {
        if (parsed.name === 'approvals') {
          if (parsed.args) throw new Error('Usage: /approvals');
          await showAgentApprovals(
            {
              ...session.extensionRunner.createContext(),
              hasUI: true,
              ui: ui?.forCommand(controller.signal).context ?? approvalUI!,
            },
            {signal: controller.signal},
          );
        } else if (parsed.name === 'session')
          await runSessionCommand(parsed.name, parsed.args, {
            session,
            ui: ui!.forCommand(controller.signal),
            signal: controller.signal,
          });
        else
          await runSettingsCommand(parsed.name, parsed.args, {
            session,
            ui: ui!.forCommand(controller.signal),
            signal: controller.signal,
            configure: async input => {
              await worker.configure!(input);
            },
          });
        return await features();
      } finally {
        if (commandController === controller) commandController = undefined;
      }
    },
    async compact(instructions) {
      await session.compact(instructions);
      restoreUsage();
      publishUsage?.(usage.snapshot());
    },
    async reload() {
      await session.reload();
    },
    clearQueue() {
      commandController?.abort();
      return session.clearQueue();
    },
    async steer(message, starting) {
      if (finishing && !starting) return false;
      await session.steer(message);
      return true;
    },
    async run(message, signal, onActivity, onUsage, onConversation) {
      signal.throwIfAborted();
      const parsed = parseSlashCommand(message);
      if (parsed && nativeCommand(parsed.name)) {
        const stopCommand = () => commandController?.abort();
        signal.addEventListener('abort', stopCommand, {once: true});
        try {
          await worker.command!(message);
          signal.throwIfAborted();
          return '';
        } finally {
          signal.removeEventListener('abort', stopCommand);
        }
      }
      if (agentProfile.model) {
        const activeModel = session.model
          ? `${session.model.provider}/${session.model.id}`
          : '';
        await assertAgentModelAllowed(
          activeModel,
          undefined,
          agentProfile.model,
        );
        signal.throwIfAborted();
      }
      promptState.signal = signal;
      promptState.blocked = undefined;
      if (onUsage) publishUsage = onUsage;
      finishing = false;
      conversation.begin();
      let aborting: Promise<void> | undefined;
      const abort = () => {
        finishing = true;
        commandController?.abort();
        session.clearQueue();
        session.abortCompaction();
        session.abortBash();
        aborting = session.abort().catch(() => {});
      };
      const unsubscribe = session.subscribe(event => {
        if (conversation.record(event))
          onConversation?.(conversation.snapshot());
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant'
        ) {
          let sequence = 0;
          let found = false;
          for (const entry of session.sessionManager.getBranch?.() ?? []) {
            if (entry.type !== 'message') continue;
            if (
              entry.message.role !== 'user' &&
              entry.message.role !== 'assistant'
            )
              continue;
            sequence++;
            if (entry.message === event.message) {
              found = true;
              break;
            }
          }
          // SDK listeners run before this assistant message is appended to history.
          if (!found) sequence++;
          const call = modelUsage(event.message, {
            id: `message-assistant-${event.message.timestamp}-${sequence}`,
            at: new Date(event.message.timestamp).toISOString(),
          });
          if (call && usage.record(call, sequence)) onUsage?.(usage.snapshot());
        }
        if (event.type === 'compaction_end' && event.result && !event.aborted) {
          restoreUsage();
          onUsage?.(usage.snapshot());
        }
        // Abort again if cancellation happened during prompt preflight.
        if (signal.aborted) {
          if (event.type === 'agent_start') abort();
          return;
        }
        if (event.type === 'tool_execution_start') {
          onActivity(`Using ${event.toolName}`);
        } else if (
          (event.type === 'message_start' || event.type === 'message_update') &&
          event.message.role === 'assistant'
        ) {
          const writing = event.message.content.some(
            part => part.type === 'text' && part.text,
          );
          onActivity(writing ? 'Responding' : 'Thinking');
        } else if (event.type === 'auto_retry_start') {
          onActivity(`Retrying (attempt ${event.attempt})`);
        } else if (event.type === 'compaction_start') {
          onActivity('Compacting conversation');
        }
      });
      signal.addEventListener('abort', abort, {once: true});
      let failure: unknown;
      try {
        await session.prompt(message, {expandPromptTemplates: true});
        finishing = true;
        signal.throwIfAborted();
        if (promptState.blocked) throw new Error(promptState.blocked);
        const lastAssistant = session.messages.findLast(
          item => item.role === 'assistant',
        );
        if (!lastAssistant || lastAssistant.role !== 'assistant') {
          throw new Error('Agent finished without an assistant response.');
        }
        if (
          lastAssistant.stopReason !== 'stop' ||
          lastAssistant.content.some(part => part.type === 'toolCall')
        ) {
          throw new Error(
            lastAssistant.errorMessage || `Agent ${lastAssistant.stopReason}.`,
          );
        }
        const output = lastAssistant.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n');
        await writeFile(resultFile, output, 'utf8');
        return output;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        finishing = true;
        signal.removeEventListener('abort', abort);
        try {
          await aborting;
          const cause = signal.aborted ? signal.reason : failure;
          conversation.settle(
            signal.aborted,
            cause instanceof Error
              ? cause.message
              : cause === undefined
                ? undefined
                : String(cause),
          );
          onConversation?.(conversation.snapshot());
          restoreUsage();
          onUsage?.(usage.snapshot());
        } finally {
          unsubscribe();
          promptState.signal = undefined;
        }
      }
    },
    dispose() {
      if (closing) return closing;
      commandController?.abort();
      publishUsage = undefined;
      unsubscribeUsage();
      closing = (async () => {
        try {
          await session.extensionRunner.emit({
            type: 'session_shutdown',
            reason: 'quit',
          });
        } finally {
          session.dispose();
        }
      })();
      return closing;
    },
  };
  return worker;
}

export async function createSessionWorker(
  options: WorkerOptions,
): Promise<AgentWorker> {
  const selectedProfile = options.agentProfile
    ? structuredClone(options.agentProfile)
    : await resolveDefaultAgentTemplate(options.cwd, 'subagent');
  const agentProfile = await ensureAgentProfilePermissions(
    options.cwd,
    selectedProfile,
  );
  let selectedModel = options.model;
  if (agentProfile.model) {
    await assertAgentModelAllowed(
      agentProfile.model,
      undefined,
      agentProfile.model,
    );
    const separator = agentProfile.model.indexOf('/');
    const pinnedModel = options.modelRegistry.find(
      agentProfile.model.slice(0, separator),
      agentProfile.model.slice(separator + 1),
    );
    if (!pinnedModel)
      throw new Error(
        `Configured agent model is unavailable: ${agentProfile.model}`,
      );
    selectedModel = pinnedModel;
  }
  const profileResources = createAgentResourcePolicy(agentProfile);
  const promptState: WorkerPromptState = {};
  const contextScope = options.context ?? agentProfile?.context ?? 'workspace';
  const agentDir = getAgentDir();
  const directory = join(
    agentDir,
    'varisdev',
    'agents',
    options.parentSessionId,
    options.id,
  );
  await mkdir(directory, {recursive: true});
  const configuration = createWorkspaceConfiguration(options.cwd, agentDir);
  const settingsManager = configuration.settingsManager;
  const resources = createAppResourceFilter(
    configuration.resourceSettingsManager,
    options.cwd,
    agentDir,
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const sessionManager = SessionManager.create(options.cwd, directory);
  sessionManager.appendCustomEntry('varisdev.agent-context', {
    scope: contextScope,
  });
  sessionManager.appendCustomEntry('varisdev.agent-profile', agentProfile);
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    settingsManager: resources.settingsManager,
    modelRuntime,
    resourceLoaderReloadOptions: projectTrustReloadOptions(
      options.cwd,
      agentDir,
      settingsManager,
      options.projectTrustOverride,
    ),
    resourceLoaderOptions: configuration.resourceOptions(
      profileResources.resourceOptions({
        noThemes: true,
        ...(agentProfile?.instructions.trim()
          ? {systemPrompt: agentProfile.instructions}
          : {}),
        extensionFactories: [
          pi => {
            pi.events.emit('varisdev:agent-profile-managed', {
              sessionId: sessionManager.getSessionId(),
              profile: agentProfile,
            });
          },
          ...createBuiltinExtensions({mcp: configuration.mcpOptions}),
          registerProjectTools,
          pi =>
            registerCommitCommand(
              pi,
              (text, options) => session.sendUserMessage(text, options),
              {approval: options.approval, signal: () => promptState.signal},
            ),
          options.agentToolsExtension,
          ...(agentProfile.permissions.length ||
          agentProfile.steps !== undefined
            ? [
                createAgentPolicyExtension(agentProfile, {
                  approval: options.approval,
                  label: options.name,
                  skills: profileResources.skills,
                  signal: () => promptState.signal,
                  onInputBlocked: reason => {
                    promptState.blocked = reason;
                  },
                }),
              ]
            : []),
        ],
        appendSystemPrompt: [
          ...(options.instructions ? [options.instructions] : []),
        ],
      }),
      contextScope,
    ),
  });
  services.settingsManager = settingsManager;
  services.resourceLoader = configuration.resourceLoader(
    services.resourceLoader,
  );
  const errors = services.diagnostics.filter(item => item.type === 'error');
  if (errors.length)
    throw new Error(errors.map(item => item.message).join('\n'));
  // Bind physical providers after the worker's extension registrations so their
  // requests retain the parent's runtime credentials. Virtual routes stay local.
  const providers = registerParentModelProviders(
    options.modelRegistry,
    modelRuntime,
  );
  if (
    selectedModel.api !== 'pi-virtual' &&
    !providers.includes(selectedModel.provider)
  )
    throw new Error(
      `Current agent model provider is unavailable: ${selectedModel.provider}`,
    );
  if (providers.length)
    await modelRuntime.refresh({allowNetwork: false, providers});
  if (
    selectedModel.api === 'pi-virtual' &&
    !modelRuntime.getModel(selectedModel.provider, selectedModel.id)
  )
    throw new Error(
      `Virtual model ${selectedModel.provider}/${selectedModel.id} is not registered in this worker. Load its extension in the worker's project or global settings.`,
    );
  const patterns = settingsManager.getEnabledModels();
  const scope = patterns?.length
    ? await resolveModelScopeWithDiagnostics(patterns, modelRuntime)
    : undefined;
  const {session} = await createAgentSessionFromServices({
    services,
    scopedModels: scope?.scopedModels,
    model: selectedModel,
    thinkingLevel: options.thinkingLevel,
    sessionManager,
  });
  const worker = sessionWorker(
    session,
    join(directory, 'result.txt'),
    agentProfile,
    promptState,
    options.ui,
    options.approvalUI,
  );
  try {
    await session.bindExtensions({
      mode: 'rpc',
      ...((options.ui?.context ?? options.approvalUI)
        ? {uiContext: options.ui?.context ?? options.approvalUI}
        : {}),
    });
    return worker;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}
