import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Type} from 'typebox';
import {
  type AgentOrchestrator,
  isAgentFinished,
  type AgentRecord,
  type AgentMessageSender,
} from '../agents/orchestrator.ts';
import {createSessionWorker} from '../agents/session.ts';
import {assertAgentModelAllowed, readToolSettings} from './settings.ts';
import {observeFileChanges} from '../dashboard/changes.ts';
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
] as const;

const idSchema = Type.String({
  description: 'Agent ID.',
});
const spawnSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: 120,
    description: 'Short name for the assigned work.',
  }),
  task: Type.String({
    minLength: 1,
    maxLength: 64000,
    description: 'Complete task, relevant context, and expected result.',
  }),
  instructions: Type.Optional(
    Type.String({
      maxLength: 16000,
      description: 'Additional system instructions for this agent.',
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
      description: 'Provider/model; defaults to the parent model.',
    }),
  ),
  thinkingLevel: Type.Optional(
    Type.Union(
      allowedEfforts.map(effort => Type.Literal(effort)),
      {
        description: 'Defaults to the parent thinking level.',
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
      ...(record.autoCleanup && record.status === 'completed'
        ? {resumable: false}
        : {}),
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
      ? 'Message a peer or id="parent". Parent messages enter its inbox without waking it; sender identity is attached. Peer messages steer active work or resume completed work. Failed, cancelled, or cleaned-up agents cannot resume.'
      : 'Steer active work at the next turn boundary or resume a completed conversation. Failed, cancelled, or cleaned-up agents require agent_spawn.',
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
      if (recipient.status === 'completed')
        await assertAgentModelAllowed(recipient.model);
      return toolResult(
        [await current.send(params.id, message, identity)],
        'ack',
      );
    },
  });
}

export function registerAgentTools(
  pi: ExtensionAPI,
  createWorker = createSessionWorker,
): AgentSessionController {
  const control = new AgentSessionController(pi);
  const getManager = (ctx: ExtensionContext) =>
    control.getTeam(ctx).getManager();

  const registerSpawn = (allowedModels: string[] | null) =>
    pi.registerTool({
      name: 'agent_spawn',
      label: 'Spawn agent',
      description:
        'Start a background agent with its own conversation; returns an ID immediately. Six run concurrently, others queue. ' +
        (allowedModels === null
          ? 'Accepts any model from the parent model registry. '
          : allowedModels.length === 0
            ? 'No models enabled; configure Menu → Agent models first. '
            : 'Model choices are restricted by Menu → Agent models. ') +
        'Agents share files in cwd. Use agent_wait for results and agent_inbox for messages; completion does not wake the parent.',
      promptSnippet:
        'Start a background agent with its own conversation and return its ID immediately.',
      parameters: {
        ...spawnSchema,
        properties: {
          ...spawnSchema.properties,
          model: {
            ...spawnSchema.properties.model,
            ...(allowedModels?.length ? {enum: allowedModels} : {}),
            description:
              'Provider/model; defaults to the parent model, which must also be allowed.',
          },
        },
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const team = control.getTeam(ctx);
        const cwd = resolve(ctx.cwd, params.cwd ?? '.');
        if (!(await stat(cwd)).isDirectory())
          throw new Error(`Agent cwd is not a directory: ${cwd}`);
        const inheritedModel =
          ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
        const selectedModel = params.model ?? inheritedModel;
        if (selectedModel === undefined)
          throw new Error(
            'Choose a parent model or specify the agent model as provider/model.',
          );
        await assertAgentModelAllowed(selectedModel);
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
        const thinkingLevel = params.thinkingLevel ?? pi.getThinkingLevel();
        if (!allowedEfforts.some(effort => effort === thinkingLevel))
          throw new Error(
            'Agent thinkingLevel must be off, minimal, low, medium, high, or xhigh.',
          );
        const workerOptions = {
          cwd,
          projectTrustOverride:
            cwd === resolve(ctx.cwd) ? ctx.isProjectTrusted() : undefined,
          name: params.name,
          instructions: params.instructions,
          model,
          modelRegistry: ctx.modelRegistry,
          thinkingLevel,
        };
        signal?.throwIfAborted();
        const current = getManager(ctx);
        const record = current.spawn(
          {
            name: params.name,
            task: params.task,
            cwd,
            model: `${model.provider}/${model.id}`,
            timeoutMs: params.timeoutMs,
            autoCleanup: params.autoCleanup,
          },
          async id => {
            await assertAgentModelAllowed(selectedModel);
            const worker = await createWorker({
              ...workerOptions,
              parentSessionId: team.sessionId,
              id,
              agentToolsExtension(workerPi) {
                observeFileChanges(workerPi, change =>
                  team.storeChange({
                    ...change,
                    unitId: id,
                    unitName: params.name,
                  }),
                );
                const getWorkerManager = () => team.getManager();
                registerAgentListTool(workerPi, getWorkerManager, id);
                registerAgentSendTool(workerPi, getWorkerManager, {
                  id,
                  sendToParent: message => team.storeMessage(message),
                });
              },
            });
            return {
              ...worker,
              get usage() {
                return worker.usage;
              },
              get conversation() {
                return worker.conversation;
              },
              steer: (message, starting) => worker.steer(message, starting),
              dispose: () => worker.dispose(),
              async run(...args) {
                await assertAgentModelAllowed(selectedModel);
                args[1].throwIfAborted();
                return worker.run(...args);
              },
            };
          },
        );
        return toolResult([record], 'ack');
      },
    });

  registerSpawn([]);
  let spawnPolicy = JSON.stringify([]);
  const refreshSpawnPolicy = async () => {
    const {allowedModels} = (await readToolSettings()).agents;
    const policy = JSON.stringify(allowedModels);
    if (policy === spawnPolicy) return;
    registerSpawn(allowedModels);
    spawnPolicy = policy;
  };
  pi.on('before_agent_start', refreshSpawnPolicy);
  // before_agent_start runs once per prompt, not for tool continuations or
  // steering within a run. Refresh at the completed-turn boundary, before Pi
  // snapshots the next request's tool declarations and validation schemas.
  // turn_start is too late for those declarations in the current SDK.
  pi.on('turn_end', refreshSpawnPolicy);

  registerAgentListTool(pi, getManager);
  pi.registerTool({
    name: 'agent_inbox',
    label: 'Read worker messages to parent',
    description:
      'Read worker messages without consuming them. For new messages only, start with after=0 and reuse nextAfter. Without after, lists newest-first history. Retains 100 messages; previews are 500 characters.',
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
      const team = control.getTeam(ctx);
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
  registerAgentSendTool(pi, getManager);
  pi.registerTool({
    name: 'agent_wait',
    label: 'Wait for agents',
    description:
      'Wait for completion, failure, or cancellation and return results. Timeout/interruption leaves agents running. Finished agents satisfy the wait; for successive mode="any" waits, pass only unfinished IDs.',
    parameters: waitSchema,
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = getManager(ctx);
      const ids = params.ids ?? current.list().map(record => record.id);
      onUpdate?.(
        toolResult(
          ids.map(id => current.get(id)),
          'progress',
        ),
      );
      return toolResult(await current.wait(ids, {...params, signal}));
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
