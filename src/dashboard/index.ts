import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../agents/team.ts';
import {isAgentFinished} from '../agents/orchestrator.ts';
import {
  launchFactory,
  detachFactory,
  type FactoryControl,
  type FactoryWindow,
} from '../desktop/launcher.ts';
import {observeDashboardSession} from './observe.ts';
import type {DashboardState} from './state.ts';

interface FactoryConnection {
  launch(
    state: DashboardState,
    control: FactoryControl,
  ): Promise<FactoryWindow>;
  detach(state: DashboardState, quit?: boolean): void;
}

interface FactoryBinding {
  state: DashboardState;
  ctx: ExtensionContext;
  control: FactoryControl;
  pending: string[];
  submitting: boolean;
  validating: boolean;
  stopping: boolean;
  epoch: number;
}

/** The desktop controls and observes the current interactive Pi conversation. */
export function registerFactory(
  pi: ExtensionAPI,
  control: AgentSessionController,
  connection: FactoryConnection = {
    launch: launchFactory,
    detach: detachFactory,
  },
): void {
  let binding: FactoryBinding | undefined;
  let generation = 0;
  let cancelBeforeStart = false;
  const cancelWorkers = (ctx: ExtensionContext) => {
    if (!control.snapshot()) return;
    const manager = control.getTeam(ctx).getManager();
    for (const agent of manager.list()) manager.cancel(agent.id);
    return manager;
  };
  const drain = (current: FactoryBinding) => {
    if (
      binding !== current ||
      current.submitting ||
      current.stopping ||
      !current.pending.length ||
      !current.ctx.isIdle()
    )
      return;
    const prompt = current.pending.shift()!;
    const epoch = current.epoch;
    current.submitting = true;
    current.validating = true;
    current.state.record('session', 'Starting a GUI task');
    void (async () => {
      const model = current.ctx.model;
      if (!model)
        throw new Error(
          'No model selected. Configure your Pi model before sending a task.',
        );
      const auth = await current.ctx.modelRegistry.getApiKeyAndHeaders(model);
      current.validating = false;
      if (binding !== current || current.epoch !== epoch) {
        current.submitting = false;
        setImmediate(() => drain(current));
        return;
      }
      if (!auth.ok) throw new Error(auth.error);
      if (!current.ctx.isIdle()) {
        current.pending.unshift(prompt);
        current.submitting = false;
        current.state.record('session', 'GUI task waiting for the current run');
        return;
      }
      cancelBeforeStart = false;
      current.state.updateSession({
        status: 'running',
        activity: 'Starting task',
        error: undefined,
      });
      pi.sendUserMessage(prompt, {
        deliverAs: 'followUp',
        expandPromptTemplates: false,
      });
    })().catch(error => {
      current.submitting = false;
      current.validating = false;
      if (binding !== current) return;
      if (current.epoch !== epoch) {
        setImmediate(() => drain(current));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      current.state.updateSession({
        status: 'idle',
        activity: `Error: ${message.slice(0, 1000)}`,
        error: message.slice(0, 4000),
      });
      current.state.record('error', message);
    });
  };
  const open = async (show: boolean) => {
    const current = binding;
    const version = generation;
    if (!current) throw new Error('The session has not started yet.');
    const window = await connection.launch(current.state, current.control);
    if (version !== generation || binding !== current) {
      connection.detach(current.state);
      return;
    }
    if (show) window.show();
  };
  observeDashboardSession(pi, control, (state, ctx) => {
    const current: FactoryBinding = {
      state,
      ctx,
      pending: [],
      submitting: false,
      validating: false,
      stopping: false,
      epoch: 0,
      control: {
        get pendingPrompts() {
          return current.pending.length;
        },
        prompt(prompt: string) {
          if (binding !== current)
            throw new Error(
              'This Pi session is no longer attached to the factory.',
            );
          if (current.stopping)
            throw new Error(
              'This Pi session is stopping. Try again when it is idle.',
            );
          if (current.pending.length >= 32)
            throw new Error(
              'This Pi session already has 32 queued GUI prompts.',
            );
          current.pending.push(prompt);
          state.record('message', `GUI prompt queued: ${prompt}`);
          drain(current);
        },
        async abort() {
          if (binding !== current)
            throw new Error(
              'This Pi session is no longer attached to the factory.',
            );
          current.pending.length = 0;
          current.epoch++;
          current.stopping = true;
          cancelBeforeStart = true;
          state.record('session', 'Stopping; queued GUI prompts cleared');
          const manager = cancelWorkers(ctx);
          ctx.abort();
          try {
            if (manager) {
              // Wait for cancelled worker requests and SDK setup to finish.
              await new Promise<void>(resolve => {
                const done = () =>
                  manager.list().every(agent => isAgentFinished(agent.status));
                if (done()) {
                  resolve();
                  return;
                }
                const unsubscribe = manager.subscribe(() => {
                  if (done()) {
                    unsubscribe();
                    resolve();
                  }
                });
                if (done()) {
                  unsubscribe();
                  resolve();
                }
              });
            }
            if (binding === current) cancelWorkers(ctx);
          } finally {
            current.stopping = false;
            if (binding === current)
              state.record('session', 'GUI stop request completed');
          }
        },
      },
    };
    binding = current;
    if (ctx.mode === 'tui') {
      void open(false).catch(error => {
        if (binding === current)
          ctx.ui.notify(
            `Factory: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
      });
    }
  });
  pi.on('input', event => {
    if (event.source === 'interactive' || event.source === 'rpc')
      cancelBeforeStart = false;
  });
  pi.on('agent_start', (_event, ctx) => {
    if (
      binding?.ctx !== ctx &&
      binding?.ctx.sessionManager.getSessionId() !==
        ctx.sessionManager.getSessionId()
    )
      return;
    if (cancelBeforeStart) {
      cancelWorkers(ctx);
      ctx.abort();
    }
  });
  pi.on('agent_settled', (_event, ctx) => {
    const current = binding;
    if (
      !current ||
      current.ctx.sessionManager.getSessionId() !==
        ctx.sessionManager.getSessionId()
    )
      return;
    if (!current.validating) current.submitting = false;
    setImmediate(() => drain(current));
  });
  pi.on('session_shutdown', event => {
    generation++;
    const current = binding;
    binding = undefined;
    if (current) {
      current.pending.length = 0;
      current.epoch++;
    }
    cancelBeforeStart = false;
    if (current) connection.detach(current.state, event.reason === 'quit');
  });
  pi.registerCommand('factory', {
    description: 'Show or reopen the VarisDev desktop factory.',
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('Usage: /factory', 'info');
        return;
      }
      const version = generation;
      try {
        await open(true);
      } catch (error) {
        if (version === generation)
          ctx.ui.notify(
            `Factory: ${error instanceof Error ? error.message : String(error)}`,
            'error',
          );
      }
    },
  });
}
