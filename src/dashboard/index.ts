import {
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../agents/team.ts';
import {
  launchFactory,
  detachFactory,
  factoryIsOpen,
  type FactoryControl,
  type FactoryWindow,
} from '../desktop/launcher.ts';
import {observeDashboardSession} from './observe.ts';
import type {DashboardState} from './state.ts';
import {sessionConfiguration, compactionInstructions} from './hub.ts';
import {supportedThinkingLevels, type SessionFeatures} from './features.ts';
import {attachedContextFiles} from './context-files.ts';

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
  getSystemPromptOptions?: ExtensionCommandContext['getSystemPromptOptions'];
  systemPromptOptions?: BuildSystemPromptOptions;
  control: FactoryControl;
  submissions: number;
  stopping: boolean;
  maintaining: boolean;
  configuration?: Promise<void>;
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
  const ensureAttached = (current: FactoryBinding) => {
    if (binding !== current)
      throw new Error('This parent session is no longer attached to the app.');
  };
  const maintain = async (
    current: FactoryBinding,
    action: () => Promise<void>,
    allowRunning = false,
  ) => {
    ensureAttached(current);
    const status = current.state.snapshot().session.status;
    if (
      current.maintaining ||
      current.stopping ||
      status === 'compacting' ||
      status === 'closed' ||
      (!allowRunning && (current.submissions || !current.ctx.isIdle()))
    )
      throw new Error('Wait until this session is idle.');
    current.maintaining = true;
    const epoch = current.epoch;
    const operation = Promise.resolve().then(() => {
      ensureAttached(current);
      if (current.stopping || current.epoch !== epoch)
        throw new Error('This session is stopping.');
      return action();
    });
    if (allowRunning) current.configuration = operation;
    try {
      await operation;
      ensureAttached(current);
    } finally {
      if (allowRunning) current.configuration = undefined;
      current.maintaining = false;
    }
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
      getSystemPromptOptions:
        binding?.ctx.sessionManager.getSessionId() ===
        ctx.sessionManager.getSessionId()
          ? binding?.getSystemPromptOptions
          : undefined,
      submissions: 0,
      stopping: false,
      maintaining: false,
      epoch: 0,
      control: {
        async features(): Promise<SessionFeatures> {
          ensureAttached(current);
          const registryError = ctx.modelRegistry.getError();
          const commands = pi.getCommands().map(command => ({
            name: command.name,
            description: command.description ?? '',
            source: command.source,
            path: command.sourceInfo.path,
          }));
          const contextFiles = attachedContextFiles(
            current.getSystemPromptOptions?.() ?? current.systemPromptOptions,
            commands,
            ctx.sessionManager
              .buildContextEntries?.()
              .flatMap(sessionEntryToContextMessages),
            ctx.cwd,
          );
          return {
            ...(contextFiles ? {contextFiles} : {}),
            commands,
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
          const epoch = current.epoch;
          await maintain(
            current,
            async () => {
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
                if (current.stopping || current.epoch !== epoch)
                  throw new Error('This session is stopping.');
              }
              if (configuration.thinkingLevel)
                pi.setThinkingLevel(
                  configuration.thinkingLevel as Parameters<
                    ExtensionAPI['setThinkingLevel']
                  >[0],
                );
              state.record('session', 'Session configuration updated');
            },
            true,
          );
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
        async prompt(prompt: string) {
          ensureAttached(current);
          if (current.maintaining || current.stopping)
            throw new Error(
              'This session is updating. Try again when it is idle.',
            );
          if (
            typeof prompt !== 'string' ||
            !prompt.trim() ||
            prompt.length > 64000
          )
            throw new Error('Prompt must contain 1 to 64000 characters.');
          const epoch = current.epoch;
          current.submissions++;
          try {
            const commandName = prompt.startsWith('/')
              ? prompt.split(/\s+/, 1)[0].slice(1)
              : undefined;
            const extensionCommand =
              commandName !== undefined &&
              pi
                .getCommands()
                .some(
                  command =>
                    command.name === commandName &&
                    command.source === 'extension',
                );
            if (!extensionCommand) {
              if (!ctx.model)
                throw new Error('Choose a model before sending a task.');
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
                ctx.model,
              );
              if (!auth.ok) throw new Error(auth.error);
            }
            ensureAttached(current);
            if (current.epoch !== epoch || current.stopping) return;
            cancelBeforeStart = false;
            pi.sendUserMessage(prompt.trim(), {
              deliverAs: 'steer',
              expandPromptTemplates: true,
            });
            state.record('message', prompt.trim());
          } finally {
            current.submissions--;
          }
        },
        async cancelAgent(agentId) {
          ensureAttached(current);
          if (!control.snapshot()) {
            if (agentId === 'all') return;
            throw new Error('This parent session has no agents.');
          }
          const manager = control.getTeam(ctx).getManager();
          if (agentId === 'all') {
            for (const agent of manager.list()) manager.cancel(agent.id);
          } else manager.cancel(agentId);
        },
        async abort() {
          if (binding !== current)
            throw new Error(
              'This parent session is no longer attached to the app.',
            );
          current.epoch++;
          current.stopping = true;
          cancelBeforeStart = true;
          state.record('session', 'Stopping');
          const queued = state.snapshot().queue ?? {steering: [], followUp: []};
          ctx.abort();
          try {
            if (current.configuration)
              await Promise.allSettled([current.configuration]);
            return queued;
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
  pi.on('before_agent_start', (event, ctx) => {
    if (
      binding?.ctx.sessionManager.getSessionId() ===
      ctx.sessionManager.getSessionId()
    )
      binding.systemPromptOptions = event.systemPromptOptions;
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
      ctx.abort();
    }
  });
  pi.on('session_shutdown', event => {
    generation++;
    const current = binding;
    binding = undefined;
    if (current) {
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
      if (binding) {
        binding.getSystemPromptOptions = ctx.getSystemPromptOptions
          ? () => ctx.getSystemPromptOptions()
          : undefined;
      }
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
