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
  type QueuedAgentMessage,
  type AgentMessageChange,
  type AgentMessageSender,
} from '../agents/orchestrator.ts';
import {createSessionWorker} from '../agents/session.ts';
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
const defaultModel = 'openai-codex/gpt-5.6-sol';

const idSchema = Type.String({
  description: 'Agent ID returned by agent_spawn.',
});
const messageIdsSchema = Type.Array(Type.String({minLength: 1}), {
  minItems: 1,
  maxItems: 32,
  uniqueItems: true,
  description:
    'Message IDs from agent_messages or agent_send. Every selected message must still be pending; otherwise the entire edit is rejected.',
});
const referenceSchema = Type.Optional(
  Type.String({
    minLength: 1,
    maxLength: 1000,
    description:
      'Task or artifact reference, such as an issue ID or file path.',
  }),
);
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
        'Working directory, relative to the current project. Defaults to the current directory.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      pattern: '^[^/]+/.+$',
      description:
        'Model in provider/model format from the parent model registry. Defaults to the parent model, or openai-codex/gpt-5.6-sol when no parent model is set.',
    }),
  ),
  thinkingLevel: Type.Optional(
    Type.Union(
      allowedEfforts.map(effort => Type.Literal(effort)),
      {
        description:
          'Reasoning effort for the worker, up to xhigh. Defaults to the parent thinking level.',
      },
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      maximum: 3600000,
      description:
        'Optional execution timeout. No deadline when omitted. Queue time is excluded. If set, resets when a completed agent receives new work.',
    }),
  ),
  autoCleanup: Type.Optional(
    Type.Boolean({
      description:
        'Dispose the worker session after all queued work finishes, including failure or cancellation. Results stay available, but a finished agent cannot resume. Defaults to false.',
    }),
  ),
});
const waitSchema = Type.Object({
  ids: Type.Optional(
    Type.Array(idSchema, {
      minItems: 1,
      maxItems: 64,
      description:
        'Agents to wait for. Defaults to all agents in this session.',
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
        'Maximum wait time. Defaults to 60000 ms. A timeout leaves agents running.',
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
    activity: record.activity,
    pendingMessages: record.pendingMessages,
    finishedAt: record.finishedAt,
  }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {view, summary, agents, ...(selfId ? {selfId} : {})},
          null,
          2,
        ),
      },
    ],
    details: {view, summary, agents: selected, ...(selfId ? {selfId} : {})},
  };
}

function toolResult(
  records: AgentRecord[],
  includeOutput = true,
  extra: Record<string, unknown> = {},
) {
  const budget = Math.min(
    12000,
    Math.floor(20000 / Math.max(1, records.length)),
  );
  const agents = records.map(record => ({
    id: record.id,
    name: record.name,
    status: record.status,
    activity: record.activity,
    cwd: record.cwd,
    model: record.model,
    autoCleanup: record.autoCleanup,
    pendingMessages: record.pendingMessages,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    sessionFile: record.sessionFile,
    resultFile: record.resultFile,
    error: record.error?.slice(0, 2000),
    ...(includeOutput && record.output !== undefined
      ? {
          output:
            record.output.length > budget
              ? `${record.output.slice(0, budget)}\n[Read resultFile for the full result.]`
              : record.output,
        }
      : {}),
  }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({agents, ...extra}, null, 2),
      },
    ],
    details: {agents: records, ...extra},
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
      'List active agents and their progress in the current parent session, with counts for every status. Use view="history" for finished agents or view="all" for both. History is newest first.' +
      (selfId
        ? ' Includes your own selfId. Use agent_send with a listed ID to message a peer, or id="parent" to message the parent.'
        : ' Use agent_status for full results and transcript paths.'),
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
              'Defaults to active (queued, running, or cancelling). History includes completed, failed, and cancelled agents.',
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

function messagePreview(message: QueuedAgentMessage | ParentMessage) {
  const {message: text, ...metadata} = message;
  return {...metadata, length: text.length, preview: text.slice(0, 500)};
}

function messageChangeResult(change: AgentMessageChange) {
  return toolResult([change.agent], false, {
    outcome: change.outcome,
    message: change.message && messagePreview(change.message),
    affected: change.affected.map(messagePreview),
  });
}

function registerAgentMessageTools(
  pi: ExtensionAPI,
  getManager: GetManager,
  selfId?: string,
): void {
  pi.registerTool({
    name: 'agent_messages',
    label: 'Inspect agent messages',
    description:
      'Inspect an agent’s queued instructions with IDs, sender, timestamps, reference, and 500-character previews. Defaults to pending messages in delivery order; history contains delivered, removed, superseded, and discarded entries. Pass messageId to retrieve one full message and its current state.',
    parameters: Type.Object({
      id: idSchema,
      messageId: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Retrieve this message in full. Takes precedence over list options.',
        }),
      ),
      view: Type.Optional(
        Type.Union([
          Type.Literal('pending'),
          Type.Literal('history'),
          Type.Literal('all'),
        ]),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'List offset. Defaults to 0; the queue may change between calls.',
        }),
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
      const manager = getManager(ctx);
      const listing = params.messageId
        ? undefined
        : manager.listMessages(params.id, params);
      const data = listing
        ? {
            id: params.id,
            ...listing,
            messages: listing.messages.map(messagePreview),
          }
        : {
            id: params.id,
            message: manager.getMessage(params.id, params.messageId!),
          };
      return {
        content: [{type: 'text', text: JSON.stringify(data, null, 2)}],
        details: data,
      };
    },
  });
  pi.registerTool({
    name: 'agent_message_remove',
    label: 'Remove pending agent messages',
    description:
      'Remove selected pending instructions without interrupting the active task or clearing the agent conversation. The edit is atomic: if any entry has already been delivered or removed, returns not_pending with current states and changes nothing. Delivered instructions may already have started work.',
    executionMode: 'sequential',
    parameters: Type.Object({id: idSchema, messageIds: messageIdsSchema}),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = getManager(ctx);
      if (selfId && current.get(selfId).status !== 'running') {
        throw new Error('Only running agents can remove messages.');
      }
      return messageChangeResult(
        current.removeMessages(params.id, params.messageIds),
      );
    },
  });
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
      ? 'Send a message to another agent in this parent session, or use id="parent" to store a message in the parent inbox. Parent messages never trigger turns; the parent reads them with agent_inbox. Your name and ID are attached automatically. Peer messages queue after the current task and resume completed conversations. Failed or cancelled agents cannot receive messages.'
      : 'Queue follow-up instructions for an agent after its current task. A completed agent resumes with its existing conversation. Failed or cancelled agents must be replaced with agent_spawn.',
    executionMode: 'sequential',
    promptGuidelines: [
      'Use agent_messages to inspect stale queued instructions. To replace or consolidate them, pass their IDs in supersedes. The replacement occupies the earliest selected position and preserves unrelated messages. Supersession works at the queue limit; if any selected message is no longer pending, nothing is queued or replaced. Work already delivered is never undone.',
    ],
    parameters: Type.Object({
      id: sender
        ? Type.String({
            description: 'Peer agent ID from agent_list, or "parent".',
          })
        : idSchema,
      message: Type.String({minLength: 1, maxLength: 64000}),
      reference: referenceSchema,
      supersedes: Type.Optional(messageIdsSchema),
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
          if (
            params.supersedes !== undefined ||
            params.reference !== undefined
          ) {
            throw new Error(
              'Queue references and supersession require an agent recipient.',
            );
          }
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
      return messageChangeResult(
        current.send(params.id, message, {
          sender: identity,
          reference: params.reference,
          supersedes: params.supersedes,
        }),
      );
    },
  });
}

export function registerAgentTools(
  pi: ExtensionAPI,
  createWorker = createSessionWorker,
): void {
  const control = new AgentSessionController(pi);
  const getManager = (ctx: ExtensionContext) =>
    control.getTeam(ctx).getManager();

  pi.registerTool({
    name: 'agent_spawn',
    label: 'Spawn agent',
    description:
      'Start a background agent with its own conversation. Accepts any model from the parent model registry in provider/model format. Defaults to the parent model, or openai-codex/gpt-5.6-sol when no parent model is set. Maximum thinkingLevel: xhigh. Returns an ID immediately; up to four agents run concurrently and additional agents queue. Agents can edit files in their working directory. Collect results with agent_status or agent_wait and worker messages with agent_inbox. Workers never add parent prompts or trigger parent turns.',
    promptSnippet:
      'Start a background agent with its own conversation and return its ID immediately.',
    parameters: spawnSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const team = control.getTeam(ctx);
      const cwd = resolve(ctx.cwd, params.cwd ?? '.');
      if (!(await stat(cwd)).isDirectory())
        throw new Error(`Agent cwd is not a directory: ${cwd}`);
      const inheritedModel =
        ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
      const selectedModel = params.model ?? inheritedModel ?? defaultModel;
      const separator = selectedModel.indexOf('/');
      if (separator <= 0 || separator === selectedModel.length - 1)
        throw new Error('Agent model must use provider/model format.');
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
        id =>
          createWorker({
            ...workerOptions,
            parentSessionId: team.sessionId,
            id,
            agentToolsExtension(workerPi) {
              const getWorkerManager = () => team.getManager();
              registerAgentListTool(workerPi, getWorkerManager, id);
              registerAgentSendTool(workerPi, getWorkerManager, {
                id,
                sendToParent: message => team.storeMessage(message),
              });
              registerAgentMessageTools(workerPi, getWorkerManager, id);
            },
          }),
        {kind: 'parent', id: ctx.sessionManager.getSessionId()},
      );
      return toolResult([record], false);
    },
  });

  registerAgentListTool(pi, getManager);
  pi.registerTool({
    name: 'agent_inbox',
    label: 'Read worker messages to parent',
    description:
      'Read messages workers explicitly sent to the parent. Messages are stored without adding prompts or triggering turns. Lists the latest 100 retained messages, newest first, with sender, timestamp, and 500-character previews. Pass messageId for full text. Reading does not remove messages.',
    parameters: Type.Object({
      messageId: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            'Retrieve this message in full. Takes precedence over list options.',
        }),
      ),
      offset: Type.Optional(
        Type.Integer({minimum: 0, description: 'List offset. Defaults to 0.'}),
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
        content: [{type: 'text', text: JSON.stringify(data, null, 2)}],
        details: data,
      };
    },
  });
  pi.registerTool({
    name: 'agent_status',
    label: 'Agent status',
    description:
      'Get one agent’s progress, latest result, error, and saved transcript and result paths.',
    parameters: Type.Object({id: idSchema}),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult([getManager(ctx).get(params.id)]);
    },
  });
  registerAgentSendTool(pi, getManager);
  registerAgentMessageTools(pi, getManager);
  pi.registerTool({
    name: 'agent_wait',
    label: 'Wait for agents',
    description:
      'Wait for agents to complete, fail, or be cancelled, then return their current results. A timeout or interrupted wait leaves agents running. Already finished agents satisfy the requested wait mode.',
    parameters: waitSchema,
    async execute(_id, params, signal, onUpdate, ctx) {
      const current = getManager(ctx);
      const ids = params.ids ?? current.list().map(record => record.id);
      onUpdate?.(
        toolResult(
          ids.map(id => current.get(id)),
          false,
        ),
      );
      return toolResult(await current.wait(ids, {...params, signal}));
    },
  });
  pi.registerTool({
    name: 'agent_cancel',
    label: 'Cancel agent',
    description:
      'Cancel a queued or running agent and discard its pending messages. Running agents report cancelling until their tools stop. Finished agents are returned as they are.',
    parameters: Type.Object({id: idSchema}),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return toolResult([getManager(ctx).cancel(params.id)], false);
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
}
