import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../agents/team.ts';
import {isAgentFinished} from '../agents/orchestrator.ts';
import {
  launchFactory,
  detachFactory,
  factoryIsOpen,
  type FactoryControl,
  type FactoryWindow,
} from '../desktop/launcher.ts';
import {observeDashboardSession} from './observe.ts';
import type {DashboardState} from './state.ts';
import {
  queuedPrompt,
  sessionConfiguration,
  compactionInstructions,
  type QueuedPrompt,
} from './hub.ts';
import {supportedThinkingLevels, type SessionFeatures} from './features.ts';

interface FactoryConnection {
  isOpen(): boolean;
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
  pending: QueuedPrompt[];
  submitting: boolean;
  validating: boolean;
  stopping: boolean;
  maintaining: boolean;
  epoch: number;
}

/** The desktop controls and observes the current interactive Pi conversation. */
export function registerFactory(
  pi: ExtensionAPI,
  control: AgentSessionController,
  connection: FactoryConnection = {
    launch: launchFactory,
    isOpen: factoryIsOpen,
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
  const ensureAttached = (current: FactoryBinding) => {
    if (binding !== current)
      throw new Error('This Pi session is no longer attached to the factory.');
  };
  const maintain = async (
    current: FactoryBinding,
    action: () => Promise<void>,
  ) => {
    ensureAttached(current);
    if (
      current.maintaining ||
      current.stopping ||
      current.submitting ||
      current.pending.length ||
      !current.ctx.isIdle()
    )
      throw new Error(
        'Wait until this session is idle and its queue is empty.',
      );
    current.maintaining = true;
    try {
      await action();
      ensureAttached(current);
    } finally {
      current.maintaining = false;
      setImmediate(() => drain(current));
    }
  };
  const drain = (current: FactoryBinding) => {
    if (
      binding !== current ||
      current.submitting ||
      current.stopping ||
      current.maintaining ||
      !current.pending.length ||
      !current.ctx.isIdle()
    )
      return;
    const prompt = current.pending[0];
    const epoch = current.epoch;
    const commandName = prompt.text.startsWith('/')
      ? prompt.text.split(/\s+/, 1)[0].slice(1)
      : undefined;
    const extensionCommand =
      commandName !== undefined &&
      pi
        .getCommands()
        .some(
          command =>
            command.name === commandName && command.source === 'extension',
        );
    let submitted = false;
    current.submitting = true;
    current.validating = true;
    current.state.record('session', 'Starting a GUI task');
    void (async () => {
      let authError: string | undefined;
      if (!extensionCommand) {
        const model = current.ctx.model;
        if (!model)
          throw new Error(
            'No model selected. Configure your Pi model before sending a task.',
          );
        const auth = await current.ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) authError = auth.error;
      }
      current.validating = false;
      if (
        binding !== current ||
        current.epoch !== epoch ||
        !current.pending.some(item => item.id === prompt.id)
      ) {
        current.submitting = false;
        setImmediate(() => drain(current));
        return;
      }
      if (authError) throw new Error(authError);
      if (!current.ctx.isIdle()) {
        current.submitting = false;
        current.state.record('session', 'GUI task waiting for the current run');
        return;
      }
      cancelBeforeStart = false;
      current.state.updateSession({
        status: extensionCommand ? 'idle' : 'running',
        activity: extensionCommand ? 'Running command' : 'Starting task',
        error: undefined,
      });
      current.pending.splice(
        current.pending.findIndex(item => item.id === prompt.id),
        1,
      );
      submitted = true;
      current.state.record('session', 'GUI task submitted');
      pi.sendUserMessage(prompt.text, {
        deliverAs: 'followUp',
        expandPromptTemplates: true,
      });
      // Handled extension commands do not emit agent_settled. The attached SDK
      // owns their execution after handoff; native desktop parents await them.
      if (extensionCommand) {
        current.submitting = false;
        setImmediate(() => drain(current));
      }
    })().catch(error => {
      current.submitting = false;
      current.validating = false;
      if (binding !== current) return;
      if (
        current.epoch !== epoch ||
        (!submitted && !current.pending.some(item => item.id === prompt.id))
      ) {
        setImmediate(() => drain(current));
        return;
      }
      if (!submitted)
        current.pending.splice(
          current.pending.findIndex(item => item.id === prompt.id),
          1,
        );
      const message = error instanceof Error ? error.message : String(error);
      current.state.updateSession({
        status: 'idle',
        activity: `Error: ${message.slice(0, 1000)}`,
        error: message.slice(0, 4000),
      });
      current.state.record('error', message);
      setImmediate(() => drain(current));
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
      maintaining: false,
      epoch: 0,
      control: {
        async features(): Promise<SessionFeatures> {
          ensureAttached(current);
          const registryError = ctx.modelRegistry.getError();
          return {
            commands: pi.getCommands().map(command => ({
              name: command.name,
              description: command.description ?? '',
              source: command.source,
              path: command.sourceInfo.path,
            })),
            models: ctx.modelRegistry.getAvailable().map(model => ({
              id: model.id,
              provider: model.provider,
              name: model.name,
            })),
            ...(ctx.model
              ? {model: {id: ctx.model.id, provider: ctx.model.provider}}
              : {}),
            thinkingLevel: pi.getThinkingLevel(),
            thinkingLevels: ctx.model
              ? supportedThinkingLevels(ctx.model)
              : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
            tools: pi
              .getAllTools()
              .map(tool => ({name: tool.name, description: tool.description})),
            diagnostics: [
              {
                message:
                  'Reload attached session resources with /reload in its terminal.',
              },

              ...(registryError ? [{message: registryError}] : []),
            ],
          };
        },
        async configure(input) {
          const configuration = sessionConfiguration(input);
          await maintain(current, async () => {
            if (
              configuration.thinkingLevel &&
              !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
                configuration.thinkingLevel,
              )
            )
              throw new Error('Choose a valid thinking level.');
            let model = ctx.model;
            if (configuration.provider && configuration.modelId) {
              model = ctx.modelRegistry
                .getAvailable()
                .find(
                  model =>
                    model.provider === configuration.provider &&
                    model.id === configuration.modelId,
                );
              if (!model)
                throw new Error(
                  'This model is unavailable. Configure its provider credentials first.',
                );
            }
            if (
              configuration.thinkingLevel &&
              model &&
              !supportedThinkingLevels(model).includes(
                configuration.thinkingLevel,
              )
            )
              throw new Error(
                'This thinking level is unavailable for the selected model.',
              );
            if (configuration.provider && model) {
              if (!(await pi.setModel(model)))
                throw new Error(
                  'Authentication is not configured for this model.',
                );
              ensureAttached(current);
            }
            if (configuration.thinkingLevel)
              pi.setThinkingLevel(
                configuration.thinkingLevel as Parameters<
                  ExtensionAPI['setThinkingLevel']
                >[0],
              );
            state.record('session', 'Session configuration updated');
          });
        },
        async compact(input) {
          const instructions = compactionInstructions(input);
          await maintain(
            current,
            () =>
              new Promise<void>((resolve, reject) => {
                ctx.compact({
                  customInstructions: instructions,
                  onComplete: () => resolve(),
                  onError: reject,
                });
              }),
          );
        },
        async reload() {
          ensureAttached(current);
          throw new Error(
            'Reload attached session resources with /reload in its terminal.',
          );
        },
        get queuedPrompts() {
          return structuredClone(current.pending);
        },
        prompt(prompt: string) {
          if (binding !== current)
            throw new Error(
              'This Pi session is no longer attached to the factory.',
            );
          if (current.maintaining)
            throw new Error(
              'This session is updating. Try again when it is idle.',
            );
          if (current.stopping)
            throw new Error(
              'This Pi session is stopping. Try again when it is idle.',
            );
          if (current.pending.length >= 32)
            throw new Error(
              'This Pi session already has 32 queued GUI prompts.',
            );
          if (
            typeof prompt !== 'string' ||
            !prompt.trim() ||
            prompt.length > 64000
          )
            throw new Error('Prompt must contain 1 to 64000 characters.');
          current.pending.push(queuedPrompt(prompt.trim()));
          state.record('message', `GUI prompt queued: ${prompt}`);
          drain(current);
        },
        removeQueuedPrompt(promptId: string) {
          if (binding !== current)
            throw new Error(
              'This Pi session is no longer attached to the factory.',
            );
          const index = current.pending.findIndex(item => item.id === promptId);
          if (index < 0) throw new Error('This prompt is no longer queued.');
          current.pending.splice(index, 1);
          state.record('session', 'Queued GUI prompt removed');
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
    if (ctx.mode === 'tui' && connection.isOpen()) {
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
