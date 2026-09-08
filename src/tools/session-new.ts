import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {Type} from 'typebox';
import type {AgentHandover, AgentSessionControl} from '../agents/team.ts';

interface HandoverRequest {
  token: string;
  handover: string;
  sourceSessionId: string;
  sourceSessionFile?: string;
  model: {provider: string; id: string};
  thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']>;
  activeTools: string[];
  signal?: AbortSignal;
  dispatched: boolean;
  targetSessionId?: string;
  resumed: boolean;
  error?: unknown;
}

// Extension modules can be loaded again during replacement. Only requests that
// are currently switching sessions live here; their tool/command owns cleanup.
const requestsKey = Symbol.for('varisdev.parentSessionHandovers');
const shared = globalThis as typeof globalThis & {
  [requestsKey]?: Map<string, HandoverRequest>;
};
const requests = (shared[requestsKey] ??= new Map());

function handoverPrompt(request: HandoverRequest): string {
  return [
    'Continue working from this handover in your fresh parent session.',
    'Your background agents remain attached. Use agent_list to discover their IDs and progress, and agent_status or agent_wait to collect their results.',
    ...(request.sourceSessionFile
      ? [`Previous parent transcript: ${request.sourceSessionFile}`]
      : []),
    `Handover:\n${request.handover}`,
  ].join('\n\n');
}

/** Replace the parent runtime using Pi's command context, then resume work. */
export function registerSessionNewTool(
  pi: ExtensionAPI,
  agents: AgentSessionControl,
): void {
  let pending: HandoverRequest | undefined;

  pi.registerTool({
    name: 'session_new',
    label: 'Start fresh parent session',
    description:
      'Clear the parent conversation by starting a new session, then continue automatically from a handover. Running background agents, their IDs, and queued work remain attached. Use for requested session changes or ongoing workflows with automatic handovers. Complete ordinary tasks in the current session.',
    promptGuidelines: [
      'Use session_new when the user requests a fresh parent session or has enabled an ongoing workflow with automatic handovers, including an instructed context usage threshold. A standing workflow instruction covers repeated handovers. Complete ordinary tasks in the current session.',
      'Write a self-contained handover with the task, user instructions, progress, decisions, files, checks, agent assignments, and concrete next steps. Only the handover and normal system/project instructions carry into the fresh parent context.',
      'Make session_new your last tool call in this conversation and finish the current turn. The parent starts a fresh session and resumes automatically after this turn settles.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      handover: Type.String({
        minLength: 1,
        maxLength: 64000,
        description:
          'Complete handover for the fresh parent: task, user instructions for the ongoing workflow, progress, decisions, files, checks, agent assignments, and next steps.',
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!params.handover.trim()) throw new Error('Handover cannot be empty.');
      if (params.handover.length > 64000) {
        throw new Error('Handover cannot exceed 64000 characters.');
      }
      if (pending)
        throw new Error('A parent session handover is already pending.');
      if (!ctx.model)
        throw new Error('Select a model before starting a new session.');
      const request: HandoverRequest = {
        token: randomUUID(),
        handover: params.handover,
        sourceSessionId: ctx.sessionManager.getSessionId(),
        sourceSessionFile: ctx.sessionManager.getSessionFile(),
        model: {provider: ctx.model.provider, id: ctx.model.id},
        thinkingLevel: pi.getThinkingLevel(),
        activeTools: pi.getActiveTools(),
        signal: ctx.signal ?? signal,
        dispatched: false,
        resumed: false,
      };
      pending = request;
      try {
        // Commands are dispatched immediately, even during tool execution. The
        // command waits for idle; the tool returns so its own turn can settle.
        pi.sendUserMessage(`/varisdev-new-session ${request.token}`, {
          expandPromptTemplates: true,
        });
        if (!request.dispatched) {
          throw new Error(
            'Pi did not dispatch the session handover command. Use Pi 0.85.1 or newer.',
          );
        }
      } catch (error) {
        if (pending === request) pending = undefined;
        throw error;
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Parent session handover scheduled. Finish this turn now. A fresh parent context will continue from the handover automatically, with your background agents attached.',
          },
        ],
        details: {
          status: 'scheduled',
          previousSessionId: request.sourceSessionId,
          previousSessionFile: request.sourceSessionFile,
        },
      };
    },
  });

  pi.registerCommand('varisdev-new-session', {
    description:
      'Internal command used by session_new to replace the parent after its turn settles.',
    handler: async (args, ctx) => {
      const request = pending;
      if (!request || args.trim() !== request.token || request.dispatched) {
        throw new Error('No matching parent session handover request.');
      }
      request.dispatched = true;
      let lease: AgentHandover | undefined;
      let replacement: ExtensionContext | undefined;
      try {
        await ctx.waitForIdle();
        if (pending !== request || request.signal?.aborted) return;
        lease = agents.prepareHandover(ctx);
        requests.set(request.token, request);
        const result = await ctx.newSession({
          parentSession: request.sourceSessionFile,
          setup: async manager => {
            request.targetSessionId = manager.getSessionId();
            lease!.transfer(request.targetSessionId);
          },
          withSession: async next => {
            replacement = next;
            await next.sendUserMessage(
              `/varisdev-resume-parent ${request.token}`,
              {
                expandPromptTemplates: true,
              },
            );
            if (!request.resumed) {
              throw (
                request.error ??
                new Error('The fresh parent did not accept its handover.')
              );
            }
          },
        });
        if (result.cancelled) {
          lease.cancel();
          ctx.ui.notify('Parent session handover cancelled.', 'info');
        } else if (!request.resumed) {
          throw new Error('The session host did not start the fresh parent.');
        }
      } catch (error) {
        let sourceIsActive = false;
        try {
          sourceIsActive =
            ctx.sessionManager.getSessionId() === request.sourceSessionId;
        } catch {
          // Session replacement invalidates the old context.
        }
        if (sourceIsActive) lease?.cancel();
        else await lease?.close();
        const message = `Parent session handover failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(message);
        // The old extension context is invalid after replacement. Report using
        // the replacement context when one exists, and tolerate host shutdown.
        try {
          (replacement ?? ctx).ui.notify(message, 'error');
        } catch {
          // The host's session failure handling owns an already disposed UI.
        }
      } finally {
        requests.delete(request.token);
        if (pending === request) pending = undefined;
      }
    },
  });

  pi.registerCommand('varisdev-resume-parent', {
    description:
      'Internal command used by session_new to attach agents and resume a fresh parent.',
    handler: async (args, ctx) => {
      const request = requests.get(args.trim());
      if (
        !request ||
        request.resumed ||
        request.targetSessionId !== ctx.sessionManager.getSessionId()
      ) {
        throw new Error('No handover is waiting for this parent session.');
      }
      try {
        agents.attach(ctx);
        const model = ctx.modelRegistry.find(
          request.model.provider,
          request.model.id,
        );
        if (!model || !(await pi.setModel(model))) {
          throw new Error(
            `The handover model is unavailable: ${request.model.provider}/${request.model.id}`,
          );
        }
        pi.setThinkingLevel(request.thinkingLevel);
        pi.setActiveTools(request.activeTools);
        // sendUserMessage starts the handover but returns immediately. Awaiting
        // its entire run would keep every previous parent handover on the stack.
        pi.sendUserMessage(handoverPrompt(request));
        request.resumed = true;
      } catch (error) {
        request.error = error;
        throw error;
      }
    },
  });

  pi.on('session_shutdown', () => {
    pending = undefined;
  });
}
