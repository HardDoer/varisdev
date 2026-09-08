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
        'Execution timeout, excluding time in the queue. Defaults to 600000 ms; resets when a completed agent receives new work.',
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
      'Use agent_spawn for independent tasks. Include the necessary context, file ownership, and expected result in each task; agents receive their task, project instructions, and project tools.',
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
        id => createWorker({...workerOptions, id}),
      );
      return toolResult([record], false);
    },
  });

  pi.registerTool({
    name: 'agent_list',
    label: 'List agents',
    description:
      'List agents and their progress in the current parent session.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return toolResult(getManager(ctx).list(), false);
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
  pi.registerTool({
    name: 'agent_send',
    label: 'Send to agent',
    description:
      'Queue follow-up instructions for an agent after its current task. A completed agent resumes with its existing conversation. Failed or cancelled agents must be replaced with agent_spawn.',
    parameters: Type.Object({
      id: idSchema,
      message: Type.String({minLength: 1, maxLength: 64000}),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      return toolResult(
        [getManager(ctx).send(params.id, params.message)],
        false,
      );
    },
  });
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
      'List background agents, or cancel them with /agents cancel <id|all>.',
    handler: async (args, ctx) => {
      const current = getManager(ctx);
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 0) {
        if (parts[0] !== 'cancel' || parts.length !== 2) {
          ctx.ui.notify('Usage: /agents or /agents cancel <id|all>', 'info');
          return;
        }
        const ids =
          parts[1] === 'all'
            ? current.list().map(record => record.id)
            : [parts[1]];
        for (const id of ids) current.cancel(id);
      }
      const records = current.list();
      ctx.ui.notify(
        records.length === 0
          ? 'No agents in this session.'
          : records
              .map(
                record =>
                  `${record.id}  ${record.name}: ${record.status} — ${record.activity}`,
              )
              .join('\n'),
        'info',
      );
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
