import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Type, type Static} from 'typebox';
import {
  type AgentOrchestrator,
  isAgentFinished,
  type AgentRecord,
  type AgentMessageSender,
} from '../agents/orchestrator.ts';
import {createSessionWorker} from '../agents/session.ts';
import {
  listAgentTemplates,
  prepareAgentTemplateGet,
  resolveAgentTemplate,
  resolveDefaultAgentTemplate,
  saveAgentTemplate,
  deleteAgentTemplate,
  type AgentTemplate,
} from '../agents/templates.ts';
import {
  agentCatalogAllows,
  agentToolPermissions,
  checkAgentPermissions,
  type AgentPolicyOptions,
} from '../agents/policy.ts';
import {createAgentApprovalRelay} from '../agents/approval-ui.ts';
import {
  agentMentionAutocomplete,
  discoverAgentMentions,
  parseAgentMention,
} from '../agents/mentions.ts';
import {assertAgentModelAllowed, readToolSettings} from './settings.ts';
import {observeFileChanges} from '../dashboard/changes.ts';
import type {DesktopExtensionUI} from '../dashboard/extension-ui.ts';
import {
  AgentSessionController,
  type AgentMessage,
  type ParentMessage,
} from '../agents/team.ts';

const allowedEfforts = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const idSchema = Type.String({
  description: 'Agent ID.',
});
const spawnSchema = Type.Object({
  name: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description: 'Conversation name; defaults to the selected agent name.',
    }),
  ),
  template: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        'Agent ID from agent_templates; defaults to Default. Workspace settings override repository, global, and built-in settings.',
    }),
  ),
  context: Type.Optional(
    Type.Union([Type.Literal('workspace'), Type.Literal('task')], {
      description:
        'Context scope. Workspace loads applicable instructions and skill listings; task omits automatic instruction files and skill listings. Neither copies the caller conversation. Defaults to the configuration or workspace.',
    }),
  ),
  task: Type.String({
    minLength: 1,
    maxLength: 64000,
    description:
      'Concise task, expected result, and only the context needed. Reference files instead of copying large contents.',
  }),
  instructions: Type.Optional(
    Type.String({
      maxLength: 16000,
      description:
        'Task-specific instructions that add to the selected profile.',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        'Working directory relative to the current project; defaults to it.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      pattern: '^[^/]+/.+$',
      description:
        'Provider/model for configurations that inherit. An explicit configuration model always takes precedence.',
    }),
  ),
  thinkingLevel: Type.Optional(
    Type.Union(
      allowedEfforts.map(effort => Type.Literal(effort)),
      {
        description:
          'Defaults to the template reasoning level or current agent reasoning level.',
      },
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      maximum: 3600000,
      description:
        'Execution deadline, excluding queue time. Resets on resume; no deadline by default.',
    }),
  ),
  autoCleanup: Type.Optional(
    Type.Boolean({
      description:
        'Dispose after completion. Results stay readable, but the agent cannot resume. Default false.',
    }),
  ),
});
const waitSchema = Type.Object({
  ids: Type.Optional(
    Type.Array(idSchema, {
      minItems: 1,
      maxItems: 64,
      description:
        'Defaults to all agents, including history. Pass specific IDs to avoid repeated results.',
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal('all'), Type.Literal('any')], {
      description:
        'Wait for all selected agents or any one to finish. Defaults to all.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 120000,
      description:
        'Maximum wait in milliseconds; default 60000. Timeout leaves agents running.',
    }),
  ),
});

type AgentListView = 'active' | 'history' | 'all';

function selectAgents(records: AgentRecord[], view: AgentListView) {
  const active = records.filter(record => !isAgentFinished(record.status));
  if (view === 'active') return active;
  const history = records
    .filter(record => isAgentFinished(record.status))
    .sort((a, b) =>
      (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt),
    );
  return view === 'history' ? history : [...active, ...history];
}

function agentListResult(
  records: AgentRecord[],
  view: AgentListView,
  selfId?: string,
) {
  const summary = {
    running: 0,
    queued: 0,
    cancelling: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const record of records) summary[record.status]++;
  const selected = selectAgents(records, view);
  const agents = selected.map(record => ({
    id: record.id,
    name: record.name,
    status: record.status,
    ...(record.activity.toLowerCase() !== record.status
      ? {
          activity:
            record.activity.length > 240
              ? `${record.activity.slice(0, 237)}...`
              : record.activity,
        }
      : {}),
  }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          view,
          summary,
          agents,
          ...(selfId ? {selfId} : {}),
        }),
      },
    ],
    details: {view, summary, agents: selected, ...(selfId ? {selfId} : {})},
  };
}

function toolResult(
  records: AgentRecord[],
  view: 'ack' | 'progress' | 'result' | 'details' = 'result',
) {
  const budget = Math.min(
    12000,
    Math.floor(20000 / Math.max(1, records.length)),
  );
  const agents = records.map(record => {
    const includeOutput = view === 'result' || view === 'details';
    const truncated =
      includeOutput &&
      record.output !== undefined &&
      (record.outputTruncated || record.output.length > budget);
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      ...(view !== 'ack' && !isAgentFinished(record.status)
        ? {activity: record.activity}
        : {}),
      ...(record.error ? {error: record.error.slice(0, 2000)} : {}),
      ...(record.resumable === false ? {resumable: false} : {}),
      ...(includeOutput && record.output !== undefined
        ? {output: record.output.slice(0, budget)}
        : {}),
      ...(truncated
        ? {outputTruncated: true, resultFile: record.resultFile}
        : {}),
      ...(view === 'details'
        ? {
            cwd: record.cwd,
            model: record.model,
            autoCleanup: record.autoCleanup,
            createdAt: record.createdAt,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            sessionFile: record.sessionFile,
            resultFile: record.resultFile,
          }
        : {}),
    };
  });
  return {
    content: [{type: 'text' as const, text: JSON.stringify({agents})}],
    details: {agents: records},
  };
}

type GetManager = (ctx: ExtensionContext) => AgentOrchestrator;

function registerAgentListTool(
  pi: ExtensionAPI,
  getManager: GetManager,
  selfId?: string,
): void {
  pi.registerTool({
    name: 'agent_list',
    label: 'List agents',
    description:
      'List agent IDs and progress. Defaults to active; history is newest first.' +
      (selfId
        ? ' Includes your selfId; agent_send accepts peer IDs or "parent".'
        : ' Use agent_status for results and errors.'),
    parameters: Type.Object({
      view: Type.Optional(
        Type.Union(
          [
            Type.Literal('active'),
            Type.Literal('history'),
            Type.Literal('all'),
          ],
          {
            description:
              'Active: queued, running, cancelling. History: completed, failed, cancelled.',
          },
        ),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return agentListResult(
        getManager(ctx).list(),
        params.view ?? 'active',
        selfId,
      );
    },
  });
}

function messagePreview(message: ParentMessage) {
  const {message: text, ...metadata} = message;
  return {...metadata, length: text.length, preview: text.slice(0, 500)};
}

function registerAgentSendTool(
  pi: ExtensionAPI,
  getManager: GetManager,
  sender?: {id: string; sendToParent: (message: AgentMessage) => ParentMessage},
): void {
  pi.registerTool({
    name: 'agent_send',
    label: 'Send to agent',
    description: sender
      ? 'Message another agent, or use id="parent" for the initiating agent’s inbox. Inbox messages do not start a turn. Other messages steer active work or continue a retained conversation, including stopped or failed work.'
      : 'Steer active work at the next turn boundary or continue a retained conversation, including stopped or failed work. Closed or cleaned-up agents require agent_spawn.',
    executionMode: 'sequential',
    parameters: Type.Object({
      id: sender
        ? Type.String({
            description: 'Peer agent ID from agent_list, or "parent".',
          })
        : idSchema,
      message: Type.String({minLength: 1, maxLength: 64000}),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = getManager(ctx);
      const message = params.message;
      let identity: AgentMessageSender = {
        kind: 'parent',
        id: ctx.sessionManager.getSessionId(),
      };
      if (sender) {
        const from = current.get(sender.id);
        if (from.status !== 'running') {
          throw new Error('Only running agents can send messages.');
        }
        if (params.id === sender.id) {
          throw new Error('An agent cannot send a message to itself.');
        }
        if (!message.trim()) throw new Error('Agent message cannot be empty.');
        const attributed = {from: {id: from.id, name: from.name}, message};
        identity = {kind: 'agent', id: from.id, name: from.name};
        if (params.id === 'parent') {
          const stored = sender.sendToParent(attributed);
          const data = {
            recipient: 'parent',
            stored: true,
            messageId: stored.id,
          };
          return {
            content: [{type: 'text' as const, text: JSON.stringify(data)}],
            details: data,
          };
        }
      }
      const recipient = current.get(params.id);
      if (isAgentFinished(recipient.status))
        await assertAgentModelAllowed(
          recipient.model,
          undefined,
          recipient.pinnedModel,
        );
      return toolResult(
        [await current.send(params.id, message, identity)],
        'ack',
      );
    },
  });
}

function registerAgentTemplateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'agent_templates',
    label: 'Agent configurations',
    exposure: 'deferred',
    description:
      'List, read, save, or delete optional agent configurations in global, repository, or workspace scopes. Matching fields merge in that order. Spawning requires subagent or all mode.',
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          ['list', 'get', 'save', 'delete'].map(value => Type.Literal(value)),
        ),
      ),
      id: Type.Optional(Type.String({minLength: 1, maxLength: 256})),
      offset: Type.Optional(
        Type.Integer({minimum: 0, description: 'List offset; defaults to 0.'}),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description: 'List size; defaults to 20.',
        }),
      ),
      context: Type.Optional(
        Type.Union([Type.Literal('workspace'), Type.Literal('task')]),
      ),
      scope: Type.Optional(
        Type.Union([
          Type.Literal('global'),
          Type.Literal('repository'),
          Type.Literal('workspace'),
          Type.Literal('builtin'),
        ]),
      ),
      sourcePath: Type.Optional(
        Type.String({
          description:
            'Exact existing definition path for get, save, or delete.',
        }),
      ),
      name: Type.Optional(Type.String({maxLength: 120})),
      description: Type.Optional(Type.String({maxLength: 500})),
      mode: Type.Optional(
        Type.Union(
          ['primary', 'subagent', 'all'].map(value => Type.Literal(value)),
        ),
      ),
      hidden: Type.Optional(Type.Boolean()),
      disabled: Type.Optional(Type.Boolean()),
      color: Type.Optional(Type.String({pattern: '^#[0-9a-fA-F]{6}$'})),
      steps: Type.Optional(Type.Integer({minimum: 1})),
      permissions: Type.Optional(
        Type.Array(
          Type.Object({
            action: Type.String({minLength: 1, maxLength: 256}),
            resource: Type.String({minLength: 1, maxLength: 4096}),
            effect: Type.Union(
              ['allow', 'ask', 'deny'].map(value => Type.Literal(value)),
            ),
          }),
        ),
      ),
      instructions: Type.Optional(Type.String({maxLength: 64000})),
      model: Type.Optional(
        Type.String({
          maxLength: 512,
          description:
            'Pinned delegated model as provider/model, overriding launch arguments and Tool models. Omit to inherit.',
        }),
      ),
      thinkingLevel: Type.Optional(
        Type.Union(allowedEfforts.map(value => Type.Literal(value))),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      let result: unknown;
      const action = params.action ?? 'list';
      if (action === 'list') {
        const listing = await listAgentTemplates(ctx.cwd);
        const visible = listing.templates.filter(template => !template.hidden);
        const offset = params.offset ?? 0;
        const selected = visible.slice(offset, offset + (params.limit ?? 20));
        const nextOffset = offset + selected.length;
        result = {
          templates: selected.map(
            ({
              id,
              name,
              description,
              model,
              thinkingLevel,
              scope,
              mode,
              context,
              color,
              steps,
            }) => ({
              id,
              name,
              description: description?.slice(0, 180),
              model,
              thinkingLevel,
              scope,
              mode,
              context,
              color,
              steps,
            }),
          ),
          total: visible.length,
          ...(nextOffset < visible.length ? {nextOffset} : {}),
          defaultAgentId: listing.defaultAgentId,
          sources: listing.sources.map(({scope, directory}) => ({
            scope,
            directory,
          })),
          diagnostics: listing.diagnostics,
        };
      } else if (action === 'get') {
        result = (await prepareAgentTemplateGet(ctx.cwd, params)).value;
      } else if (action === 'save') {
        const saved = await saveAgentTemplate(ctx.cwd, {
          id: params.id,
          scope: params.scope,
          sourcePath: params.sourcePath,
          name: params.name,
          description: params.description,
          instructions: params.instructions,
          model: params.model,
          thinkingLevel: params.thinkingLevel,
          mode: params.mode,
          hidden: params.hidden,
          disabled: params.disabled,
          color: params.color,
          steps: params.steps,
          permissions: params.permissions,
          context: params.context,
        });
        result = {
          id: saved.id,
          key: saved.key,
          scope: saved.scope,
          sourcePath: saved.sourcePath,
          saved: true,
        };
      } else {
        await deleteAgentTemplate(ctx.cwd, {
          id: params.id,
          scope: params.scope,
          sourcePath: params.sourcePath,
        });
        result = {id: params.id, scope: params.scope, deleted: true};
      }
      return {
        content: [{type: 'text', text: JSON.stringify(result)}],
        details: result,
      };
    },
  });
}

export interface AgentToolsOptions {
  agentProfile?: AgentTemplate;
  ui?: DesktopExtensionUI;
  approval?: AgentPolicyOptions['approval'];
  approvalUI?: ExtensionContext['ui'];
  signal?: AgentPolicyOptions['signal'];
  control?: AgentSessionController;
  team?: ReturnType<AgentSessionController['getTeam']>;
  id?: string;
}

export function registerAgentTools(
  pi: ExtensionAPI,
  createWorker = createSessionWorker,
  shared?: AgentToolsOptions,
): AgentSessionController {
  if (!shared?.id) {
    pi.on('session_start', (_event, ctx) => {
      if (!ctx.hasUI || !ctx.ui.addAutocompleteProvider) return;
      ctx.ui.addAutocompleteProvider(current =>
        agentMentionAutocomplete(current, () =>
          discoverAgentMentions(ctx.cwd, shared?.agentProfile),
        ),
      );
    });
  }
  const control = shared?.control ?? new AgentSessionController(pi);
  const getTeam = (ctx: ExtensionContext) =>
    shared?.team ?? control.getTeam(ctx);
  const getManager = (ctx: ExtensionContext) => getTeam(ctx).getManager();
  registerAgentTemplateTool(pi);

  const launchAgent = async (
    params: Static<typeof spawnSchema>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    signal?.throwIfAborted();
    const team = getTeam(ctx);
    const cwd = resolve(ctx.cwd, params.cwd ?? '.');
    if (!(await stat(cwd)).isDirectory())
      throw new Error(`Agent cwd is not a directory: ${cwd}`);
    const template = params.template
      ? await resolveAgentTemplate(cwd, params.template)
      : await resolveDefaultAgentTemplate(cwd, 'subagent');
    if (!template)
      throw new Error(`Unknown agent configuration: ${params.template}`);
    if (template.disabled)
      throw new Error(`Agent configuration is disabled: ${template.id}`);
    if (template.mode === 'primary')
      throw new Error(
        `Agent configuration ${template.id} only supports primary conversations.`,
      );
    if (!agentCatalogAllows(shared?.agentProfile ?? {}, template.id))
      throw new Error(
        'This agent configuration does not allow launching the requested agent.',
      );
    const name = params.name ?? template.name;
    if (!name?.trim())
      throw new Error('Choose an agent name or a saved configuration.');
    const agentProfile = structuredClone(template);
    const approval = shared?.approval ?? createAgentApprovalRelay(ctx);
    const instructions = params.instructions || undefined;
    const inheritedModel = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const pinnedModel = agentProfile.model;
    const selectedModel = pinnedModel ?? params.model ?? inheritedModel;
    if (selectedModel === undefined)
      throw new Error(
        'Choose a model or specify the agent model as provider/model.',
      );
    await assertAgentModelAllowed(selectedModel, undefined, pinnedModel);
    const separator = selectedModel.indexOf('/');
    const model =
      selectedModel === inheritedModel
        ? ctx.model
        : ctx.modelRegistry.find(
            selectedModel.slice(0, separator),
            selectedModel.slice(separator + 1),
          );
    if (!model || `${model.provider}/${model.id}` !== selectedModel)
      throw new Error(`Agent model is unavailable: ${selectedModel}.`);
    const thinkingLevel =
      params.thinkingLevel ?? template?.thinkingLevel ?? pi.getThinkingLevel();
    if (!allowedEfforts.some(effort => effort === thinkingLevel))
      throw new Error(
        'Agent thinkingLevel must be off, minimal, low, medium, high, xhigh, or max.',
      );
    const workerOptions = {
      cwd,
      projectTrustOverride:
        cwd === resolve(ctx.cwd) ? ctx.isProjectTrusted() : undefined,
      name,
      instructions,
      agentProfile,
      approval,
      approvalUI: shared?.approvalUI ?? (ctx.hasUI ? ctx.ui : undefined),
      ui: shared?.ui,
      context: params.context ?? agentProfile?.context ?? 'workspace',
      model,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel,
    };
    signal?.throwIfAborted();
    const current = getManager(ctx);
    const record = current.spawn(
      {
        name,
        task: params.task,
        cwd,
        model: `${model.provider}/${model.id}`,
        pinnedModel,
        agentMode: agentProfile.mode,
        thinkingLevel,
        timeoutMs: params.timeoutMs,
        autoCleanup: params.autoCleanup,
      },
      async id => {
        await assertAgentModelAllowed(selectedModel, undefined, pinnedModel);
        const worker = await createWorker({
          ...workerOptions,
          parentSessionId: team.sessionId,
          id,
          agentToolsExtension(workerPi) {
            observeFileChanges(workerPi, change =>
              team.storeChange({
                ...change,
                unitId: id,
                unitName: name,
              }),
            );
            registerAgentTools(workerPi, createWorker, {
              control,
              team,
              id,
              agentProfile,
              approval,
              approvalUI: workerOptions.approvalUI,
              ui: shared?.ui,
            });
          },
        });
        return {
          ...worker,
          get usage() {
            return worker.usage;
          },
          get context() {
            return worker.context;
          },
          get conversation() {
            return worker.conversation;
          },
          steer: (message, starting) => worker.steer(message, starting),
          dispose: () => worker.dispose(),
          async run(...args) {
            const record = current.get(id);
            await assertAgentModelAllowed(
              record.model,
              undefined,
              record.pinnedModel,
            );
            args[1].throwIfAborted();
            return worker.run(...args);
          },
        };
      },
    );
    return toolResult([record], 'ack');
  };

  // Only main user input invokes configurations. Retained workers continue to
  // receive tasks through the parent's agent tools.
  if (!shared?.id) {
    pi.on('input', async (event, ctx) => {
      if (
        event.source === 'extension' ||
        shared?.agentProfile?.mode === 'subagent'
      )
        return {action: 'continue' as const};
      const mention = parseAgentMention(event.text);
      if (!mention) return {action: 'continue' as const};
      try {
        const parentSignal = shared?.signal?.();
        const signal =
          parentSignal && ctx.signal
            ? AbortSignal.any([parentSignal, ctx.signal])
            : (parentSignal ?? ctx.signal);
        const template = await resolveAgentTemplate(ctx.cwd, mention.id);
        if (!template) return {action: 'continue' as const};
        if (mention.task.length > 64000)
          throw new Error('Agent tasks cannot exceed 64000 characters.');
        if (event.images?.length)
          throw new Error(
            'Agent mentions accept text tasks. Reference image files in the task.',
          );
        const params = {template: mention.id, task: mention.task};
        const denied = await checkAgentPermissions(
          shared?.agentProfile ?? {id: 'default'},
          'agent_spawn',
          params,
          agentToolPermissions('agent_spawn', params, ctx.cwd),
          ctx,
          {
            approval: shared?.approval ?? createAgentApprovalRelay(ctx),
            signal: () => signal,
          },
        );
        if (denied) throw new Error(denied.reason);
        const result = await launchAgent(params, signal, ctx);
        pi.sendMessage({
          customType: 'varisdev.agent-mention',
          content: `${event.text}\n\n${result.content[0].text}`,
          details: result.details,
          display: true,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(reason, 'error');
        pi.sendMessage({
          customType: 'varisdev.agent-mention',
          content: `${event.text}\n\n${reason}`,
          details: {error: reason},
          display: true,
        });
      }
      return {action: 'handled' as const};
    });
  }

  const registerSpawn = (
    allowedModels: string[] | null,
    catalog: Array<
      Pick<AgentTemplate, 'id' | 'name' | 'description' | 'model'>
    > = [],
  ) =>
    pi.registerTool({
      name: 'agent_spawn',
      label: 'Spawn agent',
      description:
        'Start an agent with its own promptable conversation, using Default or a specified configuration; returns an ID immediately. Six run concurrently, others queue. ' +
        'An explicit configuration model is pinned and overrides the model argument and Tool models. ' +
        (allowedModels === null
          ? 'Inheriting configurations accept any model from the current model registry. '
          : allowedModels.length === 0
            ? 'No models enabled for inheriting configurations; configure Menu → Tool models first. '
            : 'Inheriting configurations use models allowed by Menu → Tool models. ') +
        'Agents share files in cwd. Use agent_wait for results and agent_inbox for messages; completion does not start another turn.',
      promptSnippet:
        'Start a background agent with its own conversation and return its ID immediately.',
      parameters: {
        ...spawnSchema,
        properties: {
          ...spawnSchema.properties,
          template: {
            ...spawnSchema.properties.template,
            description:
              'Configuration ID with subagent or all mode. ' +
              (catalog.length
                ? 'Available: ' +
                  catalog
                    .slice(0, 16)
                    .map(
                      profile =>
                        `${profile.id}: ${(profile.description || profile.name).slice(0, 120)}${profile.model ? ` (pinned model: ${profile.model})` : ''}`,
                    )
                    .join('; ') +
                  '. '
                : '') +
              'Find agent_templates with tool_search for configuration details.',
          },
          model: {
            ...spawnSchema.properties.model,
            description:
              'Provider/model for configurations that inherit; defaults to the current agent model. An explicit configuration model always takes precedence. ' +
              (allowedModels === null
                ? 'Any registered model is allowed when inheriting.'
                : allowedModels.length
                  ? `Allowed when inheriting: ${allowedModels.join(', ')}.`
                  : 'Inheriting configurations have no allowed models.'),
          },
        },
      },
      execute(_toolCallId, params, signal, _onUpdate, ctx) {
        return launchAgent(params, signal, ctx);
      },
    });

  registerSpawn([]);
  let spawnPolicy = '';
  const refreshSpawnPolicy = async (_event: unknown, ctx: ExtensionContext) => {
    const [
      {
        agents: {allowedModels},
      },
      listing,
    ] = await Promise.all([readToolSettings(), listAgentTemplates(ctx.cwd)]);
    const catalog = listing.templates
      .filter(
        profile =>
          !profile.hidden &&
          profile.mode !== 'primary' &&
          agentCatalogAllows(shared?.agentProfile ?? {}, profile.id),
      )
      .map(({id, name, description, model}) => ({
        id,
        name,
        description,
        model,
      }));
    const policy = JSON.stringify({allowedModels, catalog});
    if (policy === spawnPolicy) return;
    registerSpawn(allowedModels, catalog);
    spawnPolicy = policy;
  };
  pi.on('before_agent_start', refreshSpawnPolicy);
  // before_agent_start runs once per prompt, not for tool continuations or
  // steering within a run. Refresh at the completed-turn boundary, before Pi
  // snapshots the next request's tool declarations and validation schemas.
  // turn_start is too late for those declarations in the current SDK.
  pi.on('turn_end', refreshSpawnPolicy);

  registerAgentListTool(pi, getManager, shared?.id);
  pi.registerTool({
    name: 'agent_inbox',
    label: 'Read agent messages',
    description:
      'Read agent messages without consuming them. For new messages only, start with after=0 and reuse nextAfter. Without after, lists newest-first history. Retains 100 messages; previews are 500 characters.',
    parameters: Type.Object({
      messageId: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Retrieve this message in full. Takes precedence over list options.',
        }),
      ),
      after: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            'Inbox cursor for this session. Returns newer messages oldest first; cannot combine with offset.',
        }),
      ),
      offset: Type.Optional(
        Type.Integer({minimum: 0, description: 'History offset; default 0.'}),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: 'Maximum previews. Defaults to 10.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const team = getTeam(ctx);
      const listing = params.messageId ? undefined : team.listMessages(params);
      const data = listing
        ? {...listing, messages: listing.messages.map(messagePreview)}
        : {message: team.getMessage(params.messageId!)};
      return {
        content: [{type: 'text', text: JSON.stringify(data)}],
        details: data,
      };
    },
  });
  pi.registerTool({
    name: 'agent_status',
    label: 'Agent status',
    description:
      'Get progress, result, or error. Truncated results include their full resultFile path.',
    parameters: Type.Object({
      id: idSchema,
      details: Type.Optional(
        Type.Boolean({
          description:
            'Include model, cwd, timestamps, and transcript/result paths. Default false.',
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult(
        [getManager(ctx).get(params.id)],
        params.details ? 'details' : 'result',
      );
    },
  });
  registerAgentSendTool(
    pi,
    getManager,
    shared?.id && shared.team
      ? {
          id: shared.id,
          sendToParent: message => shared.team!.storeMessage(message),
        }
      : undefined,
  );
  pi.registerTool({
    name: 'agent_wait',
    label: 'Wait for agents',
    description:
      'Wait for completion, failure, or cancellation and return results. Timeout/interruption leaves agents running. Finished agents satisfy the wait; for successive mode="any" waits, pass only unfinished IDs.',
    parameters: waitSchema,
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = getManager(ctx);
      const ids =
        params.ids ??
        current
          .list()
          .filter(record => record.id !== shared?.id)
          .map(record => record.id);
      if (shared?.id && ids.includes(shared.id))
        throw new Error('An agent cannot wait for itself.');
      onUpdate?.(
        toolResult(
          ids.map(id => current.get(id)),
          'progress',
        ),
      );
      return toolResult(
        await current.wait(ids, {...params, signal, callerId: shared?.id}),
      );
    },
  });
  pi.registerTool({
    name: 'agent_cancel',
    label: 'Cancel agent',
    description:
      'Cancel an agent and queued messages. Reports cancelling until active tools stop; finished agents are unchanged.',
    parameters: Type.Object({id: idSchema}),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult([getManager(ctx).cancel(params.id)], 'ack');
    },
  });

  pi.registerCommand('agents', {
    description:
      'List active agents. Use /agents history, /agents all, or /agents cancel <id|all>.',
    handler: async (args, ctx) => {
      const current = getManager(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let view: AgentListView = 'active';
      if (parts.length === 1 && ['history', 'all'].includes(parts[0])) {
        view = parts[0] as AgentListView;
      } else if (parts.length === 2 && parts[0] === 'cancel') {
        const ids =
          parts[1] === 'all'
            ? selectAgents(current.list(), 'active').map(record => record.id)
            : [parts[1]];
        for (const id of ids) current.cancel(id);
      } else if (parts.length > 0) {
        ctx.ui.notify(
          'Usage: /agents [history|all] or /agents cancel <id|all>',
          'info',
        );
        return;
      }
      const records = current.list();
      const selected = selectAgents(records, view);
      const lines = selected.map(record => {
        const activity = record.activity.replace(/\s+/g, ' ').trim();
        const preview =
          activity.length > 240 ? `${activity.slice(0, 237)}...` : activity;
        const detail =
          activity.toLowerCase() === record.status
            ? record.status
            : `${record.status} — ${preview}`;
        return `${record.name}: ${detail}\n  ${record.id}`;
      });
      if (lines.length === 0) {
        lines.push(
          view === 'active'
            ? 'No active agents.'
            : view === 'history'
              ? 'No finished agents in this session.'
              : 'No agents in this session.',
        );
      }
      const historyCount = records.filter(record =>
        isAgentFinished(record.status),
      ).length;
      if (view === 'active' && historyCount > 0) {
        lines.push(
          `\n${historyCount} finished agent${historyCount === 1 ? '' : 's'}. Use /agents history to view them.`,
        );
      }
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
  return control;
}
