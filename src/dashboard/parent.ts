import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  ModelRegistry,
  parseArgs,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {mkdir} from 'node:fs/promises';

import {join} from 'node:path';
import {createWorkerModelRuntime} from '../agents/model-runtime.ts';
import type {AgentSessionController} from '../agents/team.ts';
import {registerCommitCommand} from '../commit.ts';
import {registerAgentTools} from '../tools/agents.ts';
import {registerProjectTools} from '../tools/index.ts';
import type {DashboardParent, ParentRequest, StoppedMessages} from './hub.ts';
import {
  desktopCommands,
  sessionFeatures,
  supportedThinkingLevels,
  type SessionConfiguration,
  type SessionFeatures,
} from './features.ts';
import {DesktopExtensionUI} from './extension-ui.ts';
import {observeDashboardSession} from './observe.ts';
import type {DashboardState} from './state.ts';
import type {DesktopStartup} from '../desktop/startup.ts';
import {desktopResourceOptions, restoreDesktopSession} from './startup.ts';
import {createAppResourceFilter} from './resources.ts';

export interface ParentModel {
  model: NonNullable<CreateAgentSessionOptions['model']>;
  modelRegistry: ExtensionContext['modelRegistry'];
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel'];
}

export interface DesktopDashboardParent extends DashboardParent {
  ui: DesktopExtensionUI;
  features(): Promise<SessionFeatures>;
  configure(options: SessionConfiguration): Promise<void>;
  compact(instructions?: string): Promise<void>;
  reload(): Promise<void>;
}

/** A full parent conversation with its own folder, history, tools and workers. */
export async function createDashboardParent(
  request: ParentRequest,
  inherited?: ParentModel,
  startup?: DesktopStartup,
): Promise<DesktopDashboardParent> {
  const agentDir = startup?.agentDir ?? getAgentDir();
  const args = startup ? parseArgs(startup.argv) : undefined;
  const sessionManager = startup
    ? await restoreDesktopSession(startup)
    : SessionManager.create(request.cwd);
  const directory = join(
    agentDir,
    'varisdev',
    'dashboard',
    sessionManager.getSessionId(),
  );
  await mkdir(directory, {recursive: true});
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
  const resources = createAppResourceFilter(
    settingsManager,
    request.cwd,
    agentDir,
  );
  const resourceOptions: Partial<ReturnType<typeof desktopResourceOptions>> =
    args ? desktopResourceOptions(args) : {};
  let state: DashboardState | undefined;
  const ui = new DesktopExtensionUI(() => state?.updateSession({}));
  let context: ExtensionContext | undefined;
  let control: AgentSessionController | undefined;
  let showCustomMessage: ReturnType<typeof observeDashboardSession> | undefined;
  const diagnostics: SessionFeatures['diagnostics'] = [];
  const report = (message: string, path?: string) => {
    diagnostics.push({message, ...(path ? {path} : {})});
    if (diagnostics.length > 100) diagnostics.shift();
    state?.record('error', message);
  };
  const loader = new DefaultResourceLoader({
    ...resourceOptions,
    additionalExtensionPaths: resources.paths(
      resourceOptions.additionalExtensionPaths ?? [],
    ),
    additionalSkillPaths: resources.paths(
      resourceOptions.additionalSkillPaths ?? [],
    ),
    additionalPromptTemplatePaths: resources.paths(
      resourceOptions.additionalPromptTemplatePaths ?? [],
    ),
    additionalThemePaths: resources.paths(
      resourceOptions.additionalThemePaths ?? [],
    ),
    cwd: request.cwd,
    agentDir,
    settingsManager: resources.settingsManager,
    extensionFactories: [
      pi => {
        registerProjectTools(pi);
        control = registerAgentTools(pi);
        registerCommitCommand(pi);
        showCustomMessage = observeDashboardSession(
          pi,
          control,
          (current, ctx) => {
            state = current;
            context = ctx;
          },
          state,
        );
      },
    ],
  });
  await loader.reload();
  for (const [name, value] of args?.unknownFlags ?? [])
    loader.getExtensions().runtime.flagValues.set(name, value);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: !inherited,
  });
  if (inherited && modelRuntime) {
    const delegated = await createWorkerModelRuntime(
      inherited.modelRegistry,
      inherited.model,
      directory,
    );
    modelRuntime.registerNativeProvider(
      delegated.getProvider(inherited.model.provider)!,
    );
  }
  if (startup && modelRuntime) {
    const runtime = loader.getExtensions().runtime;
    for (const {name, config} of runtime.pendingProviderRegistrations)
      modelRuntime.registerProvider(name, config);
    runtime.pendingProviderRegistrations = [];
    for (const {provider} of runtime.pendingNativeProviderRegistrations)
      modelRuntime.registerNativeProvider(provider);
    runtime.pendingNativeProviderRegistrations = [];
  }
  const startupModel =
    startup?.model && modelRuntime
      ? new ModelRegistry(modelRuntime).find(
          startup.model.provider,
          startup.model.id,
        )
      : undefined;
  if (startup?.model && !startupModel)
    throw new Error(
      `Could not restore model ${startup.model.provider}/${startup.model.id}.`,
    );
  if (args?.apiKey && startupModel)
    await modelRuntime!.setRuntimeApiKey(startupModel.provider, args.apiKey);
  const savedProvider = settingsManager.getDefaultProvider();
  const savedModelId = settingsManager.getDefaultModel();
  const savedModel =
    savedProvider && savedModelId
      ? modelRuntime.getModel(savedProvider, savedModelId)
      : undefined;
  // Pi otherwise picks a provider's preset or its first authenticated model.
  // Suppress that fallback only during creation; saved/user choices still work.
  const availableModels = modelRuntime.getAvailableSnapshot;
  modelRuntime.getAvailableSnapshot = () => [];
  let created: Awaited<ReturnType<typeof createAgentSession>>;
  try {
    created = await createAgentSession({
      cwd: request.cwd,
      agentDir,
      model: inherited?.model ?? startupModel ?? savedModel,
      modelRuntime,
      thinkingLevel: inherited?.thinkingLevel ?? startup?.thinkingLevel,
      tools: startup?.tools,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
    });
  } finally {
    modelRuntime.getAvailableSnapshot = availableModels;
  }
  const {session} = created;
  // Agent core supplies an unknown/unknown placeholder when no model was chosen.
  if (session.model?.provider === 'unknown' && session.model.id === 'unknown')
    Reflect.set(session.agent.state, 'model', undefined);
  // SDK initialization can append model metadata to an otherwise blank branch.
  if (startup?.leafId) sessionManager.branch(startup.leafId);
  // Deliver every desktop correction together at the next model turn.
  // Keep this policy local to the session rather than changing Pi settings.
  session.agent.steeringMode = 'all';
  const refreshAutocomplete = () =>
    ui.configureBaseAutocomplete(
      request.cwd,
      sessionFeatures(session, loader, settingsManager).commands,
    );
  const reload = async () => {
    diagnostics.length = 0;
    await session.reload({
      beforeSessionStart: async () => {
        session.agent.steeringMode = 'all';
        ui.resetExtensions();
        refreshAutocomplete();
      },
    });
    refreshAutocomplete();
  };
  const unsubscribeSessionEvents = session.subscribe(event => {
    if (event.type === 'queue_update')
      state?.updateQueue(event.steering, event.followUp);
    if (
      event.type === 'message_end' &&
      event.message.role === 'custom' &&
      context
    )
      showCustomMessage?.(event.message, context);
  });
  try {
    if (request.name) session.setSessionName(request.name);
    refreshAutocomplete();
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: ui.context,
      onError: error => report(error.error, error.extensionPath),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        reload,
        newSession: async () => {
          throw new Error('Open a new conversation from the desktop.');
        },
        fork: async () => {
          throw new Error(
            'Forking conversations is unavailable in the desktop.',
          );
        },
        navigateTree: async () => {
          throw new Error(
            'Conversation tree navigation is unavailable in the desktop.',
          );
        },
        switchSession: async () => {
          throw new Error('Select a conversation from the desktop.');
        },
      },
    });
    refreshAutocomplete();
    if (!state || !context || !control)
      throw new Error('Parent session observation did not start.');
    state.updateQueue(
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
    );
  } catch (error) {
    unsubscribeSessionEvents();
    ui.dispose();
    session.dispose();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let stopping: Promise<StoppedMessages> | undefined;
  let stoppedMessages: StoppedMessages | undefined;
  interface PromptRun {
    cancelled: boolean;
    operation: Promise<void>;
    trackExtensionOperations: boolean;
    extensionOperations: Promise<void>[];
  }
  const activePrompts = new Set<PromptRun>();
  let extensionPrompt: PromptRun | undefined;
  let maintaining = false;
  // Extension commands can start model turns without returning their promises.
  const sendUserMessage = session.sendUserMessage.bind(session);
  session.sendUserMessage = (...args) => {
    const operation = sendUserMessage(...args);
    if (extensionPrompt?.trackExtensionOperations)
      extensionPrompt.extensionOperations.push(operation);
    return operation;
  };
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    const operation = sendCustomMessage(message, options);
    if (options?.triggerTurn && extensionPrompt?.trackExtensionOperations)
      extensionPrompt.extensionOperations.push(operation);
    return operation;
  };
  const preserveQueue = () => {
    const queued = session.clearQueue();
    stoppedMessages?.steering.push(...queued.steering);
    stoppedMessages?.followUp.push(...queued.followUp);
  };
  const stop = () => {
    ui.cancelDialogs();
    preserveQueue();
    session.abortRetry();
    session.abortCompaction();
    session.abortBash();
    return session.abort();
  };
  const abort = () => {
    if (stopping) return stopping;
    const running = [...activePrompts];
    const recovered: StoppedMessages = {steering: [], followUp: []};
    stoppedMessages = recovered;
    for (const prompt of running) prompt.cancelled = true;
    stopping = Promise.resolve()
      .then(async () => {
        try {
          await stop();
        } finally {
          // SDK preflight and model changes may still be waiting for credentials.
          await Promise.allSettled(running.map(prompt => prompt.operation));
          // Preserve anything queued during prompt preflight before stopping settled.
          preserveQueue();
        }
        return recovered;
      })
      .finally(() => {
        stopping = undefined;
        stoppedMessages = undefined;
      });
    return stopping;
  };
  const requireOpen = () => {
    if (closed) throw new Error('This parent session has closed.');
    if (stopping) throw new Error('This parent session is stopping.');
  };
  const requireIdle = () => {
    requireOpen();
    if (activePrompts.size || session.isStreaming || session.isCompacting)
      throw new Error('This parent session is already working.');
  };
  const configure = async (options: SessionConfiguration) => {
    let model = session.model;
    if (options.provider !== undefined || options.modelId !== undefined) {
      const provider = options.provider ?? model?.provider;
      const modelId = options.modelId ?? model?.id;
      if (!provider || !modelId)
        throw new Error('Specify a provider and model.');
      model = session.extensionRunner
        .getModelRegistry()
        .find(provider, modelId);
      if (!model)
        throw new Error(`Model is unavailable: ${provider}/${modelId}`);
    }
    const levels = model
      ? supportedThinkingLevels(model)
      : session.getAvailableThinkingLevels();
    if (
      options.thinkingLevel !== undefined &&
      !levels.includes(options.thinkingLevel as (typeof levels)[number])
    )
      throw new Error(`Thinking level must be one of: ${levels.join(', ')}.`);
    if (model && (options.modelId !== undefined || model !== session.model))
      await session.setModel(model, {persist: true});
    requireOpen();
    if (options.thinkingLevel !== undefined)
      session.setThinkingLevel(
        options.thinkingLevel as Parameters<typeof session.setThinkingLevel>[0],
      );
    state!.updateSession({
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined,
      thinkingLevel: session.thinkingLevel,
    });
  };
  const localCommand = async (name: string, args: string) => {
    switch (name) {
      case 'compact':
        await session.compact(args || undefined);
        break;
      case 'reload':
        await reload();
        break;
      case 'model': {
        const slash = args.indexOf('/');
        if (slash < 1 || slash === args.length - 1)
          throw new Error('Use /model provider/model.');
        await configurationAction({
          provider: args.slice(0, slash),
          modelId: args.slice(slash + 1),
        });
        break;
      }
      case 'thinking':
        await configurationAction({thinkingLevel: args});
        break;
      case 'name':
        if (!args)
          throw new Error('Use /name followed by a conversation name.');
        session.setSessionName(args);
        state!.updateSession({name: args});
        break;
      case 'session': {
        const model = session.model;
        const content = [
          `Session: ${session.sessionManager.getSessionName() ?? session.sessionId}`,
          `Directory: ${request.cwd}`,
          `Model: ${model ? `${model.provider}/${model.id}` : 'none'}`,
          `Thinking: ${session.thinkingLevel}`,
          `History: ${session.sessionManager.getSessionFile() ?? 'in memory'}`,
        ].join('\n');
        await session.sendCustomMessage(
          {customType: 'desktop-session', content, display: true},
          {triggerTurn: false},
        );
        state!.record('session', content);
        break;
      }
    }
  };
  const sessionAction = async (
    action: () => Promise<unknown>,
    allowRunning = false,
  ) => {
    requireOpen();
    if (maintaining || session.isCompacting)
      throw new Error('This session is updating. Try again when it is idle.');
    if (!allowRunning) requireIdle();
    const running = {
      cancelled: false,
      operation: Promise.resolve(),
      trackExtensionOperations: false,
      extensionOperations: [] as Promise<void>[],
    };
    maintaining = true;
    activePrompts.add(running);
    running.operation = Promise.resolve()
      .then(async () => {
        if (!running.cancelled) await action();
      })
      .finally(() => {
        activePrompts.delete(running);
        maintaining = false;
      });
    await running.operation;
  };
  // Pi refreshes model and effort before the next assistant turn. Its setters
  // leave an active provider request alone and persist the new session settings.
  const configurationAction = (options: SessionConfiguration) =>
    sessionAction(() => configure(options), true);
  return {
    state,
    ui,
    features: async () =>
      sessionFeatures(session, loader, settingsManager, diagnostics),
    configure: configurationAction,
    compact: instructions => sessionAction(() => session.compact(instructions)),
    reload: () => sessionAction(reload),
    async prompt(text, images) {
      requireOpen();
      if (maintaining || session.isCompacting)
        throw new Error('This session is updating. Try again when it is idle.');
      const steering = activePrompts.size > 0;
      const running: PromptRun = {
        cancelled: false,
        operation: Promise.resolve(),
        trackExtensionOperations: false,
        extensionOperations: [],
      };
      activePrompts.add(running);
      running.operation = Promise.resolve()
        .then(async () => {
          if (running.cancelled) return;
          let aborting: Promise<void> | undefined;
          const unsubscribe = session.subscribe(event => {
            if (running.cancelled && event.type === 'agent_start')
              aborting = stop().catch(() => {});
          });
          try {
            const commandMatch = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
            const name = commandMatch?.[1];
            const args = commandMatch?.[2]?.trim() ?? '';
            if (
              name?.startsWith('skill:') &&
              !settingsManager.getEnableSkillCommands()
            )
              throw new Error('Skill commands are disabled in settings.');
            const local =
              name && desktopCommands.some(command => command.name === name);
            const extension = name && session.extensionRunner.getCommand(name);
            if (local) {
              if (steering && name !== 'model' && name !== 'thinking')
                throw new Error(
                  'Wait until this session is idle to run this command.',
                );
              await localCommand(name!, args);
              return;
            }
            if (!session.model && !extension)
              throw new Error(
                'Choose a model in Menu → Model & settings before sending a prompt.',
              );
            if (extension) {
              if (extensionPrompt)
                throw new Error('An extension command is already running.');
              extensionPrompt = running;
              running.trackExtensionOperations = true;
            }
            if (steering && !session.isStreaming && !extension) {
              // A prompt can arrive while the first request is still in SDK preflight.
              // Put it directly into Pi's steering queue instead of starting a second run.
              await session.steer(text, images);
            } else {
              await session.prompt(
                extension ? '/' + name + (args ? ' ' + args : '') : text,
                {
                  expandPromptTemplates: true,
                  streamingBehavior: 'steer',
                  images,
                  preflightResult: accepted => {
                    if (accepted && running.cancelled)
                      throw new Error('Prompt cancelled.');
                  },
                },
              );
            }
            for (const operation of running.extensionOperations)
              await operation;
          } catch (error) {
            if (!running.cancelled) throw error;
          } finally {
            unsubscribe();
            await aborting;
            if (extensionPrompt === running) extensionPrompt = undefined;
          }
        })
        .finally(() => activePrompts.delete(running));
      await running.operation;
    },
    abort,
    restartSnapshot() {
      requireIdle();
      if (maintaining || !session.isIdle)
        throw new Error('This parent session is already working.');
      const manager = session.sessionManager;
      const header = manager.getHeader();
      return structuredClone({
        cwd: request.cwd,
        agentDir,
        sessionFile: manager.getSessionFile(),
        sessionDir: manager.getSessionDir(),
        entries: [...(header ? [header] : []), ...manager.getEntries()],
        leafId: manager.getLeafId(),
        model: session.model
          ? {provider: session.model.provider, id: session.model.id}
          : undefined,
        thinkingLevel: session.thinkingLevel,
        tools: session.getActiveToolNames(),
        argv: [...(startup?.argv ?? [])],
      });
    },
    async cancelAgent(agentId) {
      if (closed) throw new Error('This parent session has closed.');
      if (!control!.snapshot()) {
        if (agentId === 'all') return;
        throw new Error('This parent session has no agents.');
      }
      const manager = control!.getTeam(context!).getManager();
      if (agentId === 'all') {
        for (const agent of manager.list()) manager.cancel(agent.id);
      } else manager.cancel(agentId);
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          await abort();
          await session.extensionRunner.emit({
            type: 'session_shutdown',
            reason: 'quit',
          });
        } finally {
          unsubscribeSessionEvents();
          ui.dispose();
          session.dispose();
        }
      })();
      return closing;
    },
  };
}
