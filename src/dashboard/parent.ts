import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
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
import type {DashboardParent, ParentRequest} from './hub.ts';
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
): Promise<DesktopDashboardParent> {
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(request.cwd);
  const directory = join(
    agentDir,
    'varisdev',
    'dashboard',
    sessionManager.getSessionId(),
  );
  await mkdir(directory, {recursive: true});
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
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
    cwd: request.cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      pi => {
        const existing: {control?: AgentSessionController} = {};
        pi.events.emit('varisdev:dashboard-controller', existing);
        control = existing.control;
        if (!control) {
          registerProjectTools(pi);
          control = registerAgentTools(pi);
          registerCommitCommand(pi);
        }
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
  const modelRuntime = inherited
    ? await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: join(agentDir, 'models.json'),
        refreshOnCreate: false,
      })
    : undefined;
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
  const {session} = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    model: inherited?.model,
    modelRuntime,
    thinkingLevel: inherited?.thinkingLevel,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  const refreshAutocomplete = () =>
    ui.configureBaseAutocomplete(
      request.cwd,
      sessionFeatures(session, loader, settingsManager).commands,
    );
  const reload = async () => {
    diagnostics.length = 0;
    await session.reload({
      beforeSessionStart: async () => {
        ui.resetExtensions();
        refreshAutocomplete();
      },
    });
    refreshAutocomplete();
  };
  const unsubscribeCustomMessages = session.subscribe(event => {
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
  } catch (error) {
    unsubscribeCustomMessages();
    ui.dispose();
    session.dispose();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let activePrompt:
    | {
        cancelled: boolean;
        operation: Promise<void>;
        trackExtensionOperations: boolean;
        extensionOperations: Promise<void>[];
      }
    | undefined;
  // SDK extension messaging starts an async turn without returning its promise
  // to the command handler. Keep that turn inside the desktop queue operation.
  const sendUserMessage = session.sendUserMessage.bind(session);
  session.sendUserMessage = (...args) => {
    const operation = sendUserMessage(...args);
    if (activePrompt?.trackExtensionOperations)
      activePrompt.extensionOperations.push(operation);
    return operation;
  };
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    const operation = sendCustomMessage(message, options);
    if (options?.triggerTurn && activePrompt?.trackExtensionOperations)
      activePrompt.extensionOperations.push(operation);
    return operation;
  };
  const cancelWorkers = () => {
    if (!control!.snapshot()) return;
    const manager = control!.getTeam(context!).getManager();
    for (const agent of manager.list()) manager.cancel(agent.id);
  };
  const stop = () => {
    ui.cancelDialogs();
    session.clearQueue();
    session.abortRetry();
    session.abortCompaction();
    session.abortBash();
    cancelWorkers();
    return session.abort();
  };
  const abort = async () => {
    const running = activePrompt;
    if (running) running.cancelled = true;
    try {
      await stop();
    } finally {
      // SDK preflight can still be waiting for credentials before agent_start.
      await running?.operation.catch(() => {});
      // A tool may have spawned a worker just before the parent's abort settled.
      cancelWorkers();
    }
  };
  const requireIdle = () => {
    if (closed) throw new Error('This parent session has closed.');
    if (activePrompt || session.isStreaming || session.isCompacting)
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
    if (model && model !== session.model) await session.setModel(model);
    if (options.thinkingLevel !== undefined)
      session.setThinkingLevel(
        options.thinkingLevel as Parameters<typeof session.setThinkingLevel>[0],
      );
    state!.updateSession({
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined,
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
        await configure({
          provider: args.slice(0, slash),
          modelId: args.slice(slash + 1),
        });
        break;
      }
      case 'thinking':
        await configure({thinkingLevel: args});
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
  const idleAction = async (action: () => Promise<unknown>) => {
    requireIdle();
    const running = {
      cancelled: false,
      operation: Promise.resolve(),
      trackExtensionOperations: false,
      extensionOperations: [] as Promise<void>[],
    };
    activePrompt = running;
    running.operation = Promise.resolve()
      .then(async () => {
        if (!running.cancelled) await action();
      })
      .finally(() => {
        if (activePrompt === running) activePrompt = undefined;
      });
    await running.operation;
  };
  return {
    state,
    ui,
    features: async () =>
      sessionFeatures(session, loader, settingsManager, diagnostics),
    configure: options => idleAction(() => configure(options)),
    compact: instructions => idleAction(() => session.compact(instructions)),
    reload: () => idleAction(reload),
    async prompt(text, delivery) {
      requireIdle();
      const running = {
        cancelled: false,
        operation: Promise.resolve(),
        trackExtensionOperations: false,
        extensionOperations: [] as Promise<void>[],
      };
      activePrompt = running;
      running.operation = Promise.resolve()
        .then(async () => {
          if (running.cancelled || !delivery.isQueued()) return;
          let aborting: Promise<void> | undefined;
          let submitted = false;
          const unsubscribe = session.subscribe(event => {
            if (running.cancelled && event.type === 'agent_start') {
              aborting = stop().catch(() => {});
            }
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
            // The SDK acknowledges extension commands after their handler returns.
            // Remove their queue entry immediately before dispatch so it cannot be
            // deleted while the command is already executing.
            if (local || extension) {
              if (running.cancelled || !delivery.isQueued()) return;
              delivery.submitted();
              submitted = true;
            }
            if (local) {
              await localCommand(name!, args);
              return;
            }
            running.trackExtensionOperations = !!extension;
            await session.prompt(
              extension ? `/${name}${args ? ` ${args}` : ''}` : text,
              {
                expandPromptTemplates: true,
                preflightResult: accepted => {
                  if (!accepted || submitted) return;
                  if (running.cancelled || !delivery.isQueued())
                    throw new Error('This prompt is no longer queued.');
                  delivery.submitted();
                  submitted = true;
                },
              },
            );
            for (const operation of running.extensionOperations)
              await operation;
          } catch (error) {
            if (!running.cancelled && (submitted || delivery.isQueued()))
              throw error;
          } finally {
            unsubscribe();
            await aborting;
          }
        })
        .finally(() => {
          if (activePrompt === running) activePrompt = undefined;
        });
      await running.operation;
    },
    abort,
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
          unsubscribeCustomMessages();
          ui.dispose();
          session.dispose();
        }
      })();
      return closing;
    },
  };
}
