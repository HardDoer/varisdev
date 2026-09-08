import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Type} from 'typebox';
import {
  AgentOrchestrator,
  isAgentFinished,
  type AgentRecord,
} from '../agents/orchestrator.ts';
import {createSessionWorker} from '../agents/session.ts';

const idSchema = Type.String({
  description: 'Agent ID returned by agent_spawn.',
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
        'Working directory, relative to the current project. Defaults to the current directory.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: 'Model as provider/model-id. Defaults to the parent model.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      maximum: 3600000,
      description:
        'Execution timeout, excluding time in the queue. Defaults to 600000 ms; resets when a completed agent receives new work or an agent starts a fresh session.',
    }),
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        'Send a completion message to the parent and trigger a follow-up turn. Defaults to true.',
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

function toolResult(records: AgentRecord[], includeOutput = true) {
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
    pendingMessages: record.pendingMessages,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    sessionFile: record.sessionFile,
    resultFile: record.resultFile,
    sessionCount: record.sessionCount,
    previousSessionFile: record.previousSessionFile,
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
    content: [{type: 'text' as const, text: JSON.stringify({agents}, null, 2)}],
    details: {agents: records},
  };
}

type GetManager = (ctx: ExtensionContext) => AgentOrchestrator;

interface AgentMessage {
  from: {id: string; name: string};
  message: string;
}

function formatAgentMessage({from, message}: AgentMessage): string {
  return `Message from agent ${JSON.stringify(from.name)} (${from.id}):\n${message}`;
}

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

function registerAgentSendTool(
  pi: ExtensionAPI,
  getManager: GetManager,
  sender?: {id: string; sendToParent: (message: AgentMessage) => void},
): void {
  pi.registerTool({
    name: 'agent_send',
    label: 'Send to agent',
    description: sender
      ? 'Send a message directly to another agent in this parent session, or use id="parent" to message the parent. Your name and ID are attached automatically. Peer messages queue after the current task and resume completed conversations. Failed or cancelled agents cannot receive messages.'
      : 'Queue follow-up instructions for an agent after its current task. A completed agent resumes with its existing conversation. Failed or cancelled agents must be replaced with agent_spawn.',
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
      let message = params.message;
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
        if (params.id === 'parent') {
          sender.sendToParent(attributed);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({recipient: 'parent', delivered: true}),
              },
            ],
            details: {recipient: 'parent', delivered: true},
          };
        }
        message = formatAgentMessage(attributed);
      }
      return toolResult([current.send(params.id, message)], false);
    },
  });
}

function registerAgentNewSessionTool(
  pi: ExtensionAPI,
  getManager: GetManager,
  selfId?: string,
): void {
  const handoverSchema = Type.String({
    minLength: 1,
    maxLength: 64000,
    description:
      'Self-contained handover: the task, user instructions, progress, decisions, relevant files, checks, and next steps. This becomes the first prompt in the new conversation.',
  });
  const definition = {
    name: 'agent_new_session',
    label: 'Start fresh agent session',
    description: selfId
      ? 'Start a fresh conversation for yourself and continue automatically from a handover. Use for requested session changes or ongoing workflows with automatic handovers. Complete ordinary tasks in the current session. Your agent ID and pending messages are retained; the old transcript is saved. A fresh execution timeout starts after the current tools stop.'
      : 'Start a fresh conversation for a background agent and continue automatically from a handover. Use for requested session changes or ongoing workflows with automatic handovers. Complete ordinary tasks in the current session. The agent keeps its ID and pending messages; the old transcript is saved. A fresh execution timeout starts after the current tools stop.',
    promptGuidelines: [
      'Use agent_new_session when the user requests a fresh session or has enabled an ongoing workflow with automatic handovers. Complete ordinary tasks in the current session.',
      'Include the task, user instructions, progress, decisions, relevant files, checks, and concrete next steps in the handover. The new conversation starts from the handover and project instructions.',
      ...(selfId
        ? [
            'Make this your last tool call in the current conversation. Work resumes automatically in the new conversation.',
          ]
        : []),
    ],
    executionMode: 'sequential' as const,
  };
  const request = (
    id: string,
    handover: string,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) => {
    signal?.throwIfAborted();
    const current = getManager(ctx);
    if (selfId && current.get(selfId).status !== 'running') {
      throw new Error('Only running agents can restart their own session.');
    }
    return toolResult([current.newSession(id, handover)], false);
  };
  if (selfId) {
    pi.registerTool({
      ...definition,
      parameters: Type.Object({handover: handoverSchema}),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return request(selfId, params.handover, signal, ctx);
      },
    });
  } else {
    pi.registerTool({
      ...definition,
      parameters: Type.Object({id: idSchema, handover: handoverSchema}),
      async execute(_id, params, signal, _onUpdate, ctx) {
        return request(params.id, params.handover, signal, ctx);
      },
    });
  }
}

export function registerAgentTools(
  pi: ExtensionAPI,
  createWorker = createSessionWorker,
): void {
  let manager: AgentOrchestrator | undefined;
  let context: ExtensionContext | undefined;
  let shuttingDown = false;

  function getManager(ctx: ExtensionContext): AgentOrchestrator {
    if (shuttingDown) throw new Error('The parent session is shutting down.');
    context = ctx;
    if (manager) return manager;
    const current = new AgentOrchestrator();
    manager = current;
    const notified = new Set<string>();
    current.subscribe(() => {
      if (shuttingDown || manager !== current) return;
      const records = current.list();
      try {
        if (context?.hasUI) {
          const active = records.filter(
            record => !isAgentFinished(record.status),
          );
          context.ui.setStatus(
            'varisdev-agents',
            active.length > 0
              ? `Agents: ${active.filter(record => record.status === 'running').length} running, ${active.filter(record => record.status === 'queued').length} queued, ${active.filter(record => record.status === 'cancelling').length} cancelling`
              : undefined,
          );
        }
        for (const record of records) {
          if (!isAgentFinished(record.status)) {
            notified.delete(record.id);
            continue;
          }
          if (notified.has(record.id)) continue;
          notified.add(record.id);
          if (record.notify) {
            pi.sendMessage(
              {
                customType: 'agent_result',
                content: `Agent ${JSON.stringify(record.name)} (${record.id}) ${record.status}.\n${record.error ?? record.output?.slice(0, 2000) ?? ''}\nUse agent_status for the result and transcript paths.`,
                display: true,
                details: {agent: record},
              },
              {deliverAs: 'followUp', triggerTurn: true},
            );
          }
        }
      } catch (error) {
        // A stale UI or notification must not interrupt worker cleanup.
        console.error('Agent notification failed:', error);
      }
    });
    return current;
  }

  pi.registerTool({
    name: 'agent_spawn',
    label: 'Spawn agent',
    description:
      'Start a background agent with its own conversation. Returns an ID immediately; up to four agents run concurrently and additional agents queue. Agents can edit files in their working directory.',
    promptSnippet:
      'Delegate work to background agents and return their IDs immediately.',
    promptGuidelines: [
      'Use agent_spawn for independent tasks. Include the necessary context, file ownership, and expected result in each task; agents receive their task, project instructions, project tools, agent_list and agent_send for direct communication, and agent_new_session for workflows with handovers.',
      'Coordinate agents working in the same directory so their edits do not conflict. Use separate working directories when needed.',
      'Use agent_status or agent_wait to collect delegated results before reporting completion. Use agent_send for follow-up work in the same agent conversation.',
    ],
    parameters: spawnSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = getManager(ctx);
      const cwd = resolve(ctx.cwd, params.cwd ?? '.');
      if (!(await stat(cwd)).isDirectory())
        throw new Error(`Agent cwd is not a directory: ${cwd}`);
      let model = ctx.model;
      if (params.model) {
        const slash = params.model.indexOf('/');
        if (slash < 1 || slash === params.model.length - 1) {
          throw new Error('Use provider/model-id for the agent model.');
        }
        model = ctx.modelRegistry.find(
          params.model.slice(0, slash),
          params.model.slice(slash + 1),
        );
      }
      if (!model)
        throw new Error(
          'Agent model is unavailable. Select a model or pass provider/model-id.',
        );
      const workerOptions = {
        cwd,
        name: params.name,
        instructions: params.instructions,
        model,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel: pi.getThinkingLevel(),
        parentSessionId: ctx.sessionManager.getSessionId(),
      };
      signal?.throwIfAborted();
      const record = current.spawn(
        {
          name: params.name,
          task: params.task,
          cwd,
          model: `${model.provider}/${model.id}`,
          timeoutMs: params.timeoutMs ?? 600000,
          notify: params.notify ?? true,
        },
        (id, previousSessionFile) =>
          createWorker({
            ...workerOptions,
            id,
            previousSessionFile,
            agentToolsExtension(workerPi) {
              const getWorkerManager = () => {
                if (shuttingDown || manager !== current) {
                  throw new Error('This agent session has closed.');
                }
                return current;
              };
              registerAgentListTool(workerPi, getWorkerManager, id);
              registerAgentSendTool(workerPi, getWorkerManager, {
                id,
                sendToParent(message) {
                  pi.sendMessage(
                    {
                      customType: 'agent_message',
                      content: formatAgentMessage(message),
                      display: true,
                      details: message,
                    },
                    {deliverAs: 'followUp', triggerTurn: true},
                  );
                },
              });
              registerAgentNewSessionTool(workerPi, getWorkerManager, id);
            },
          }),
      );
      return toolResult([record], false);
    },
  });

  registerAgentListTool(pi, getManager);
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
  registerAgentNewSessionTool(pi, getManager);
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
  pi.on('session_start', () => {
    shuttingDown = false;
  });
  pi.on('session_shutdown', async () => {
    shuttingDown = true;
    await manager?.close();
    if (context?.hasUI) context.ui.setStatus('varisdev-agents', undefined);
    manager = undefined;
    context = undefined;
  });
}
