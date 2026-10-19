import {discoverAgentMentions, parseAgentMention} from '../agents/mentions.ts';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  parseArgs,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  type CreateAgentSessionOptions,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {registerParentModelProviders} from '../agents/model-runtime.ts';
import {
  createDefaultAgentProfile,
  resolveDefaultAgentTemplate,
  ensureAgentProfilePermissions,
  type AgentTemplate,
} from '../agents/templates.ts';
import {createAgentPolicyExtension} from '../agents/policy.ts';
import {
  createAgentApprovalRelay,
  showAgentApprovals,
} from '../agents/approval-ui.ts';
import {createAgentResourcePolicy} from '../agents/resources.ts';
import type {AgentSessionController} from '../agents/team.ts';
import {registerCommitCommand} from '../commit.ts';
import {registerAgentTools} from '../tools/agents.ts';
import {registerProjectTools} from '../tools/index.ts';
import type {DashboardParent, ParentRequest, StoppedMessages} from './hub.ts';
import {
  sessionFeatures,
  agentProfileSummary,
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
import {createWorkspaceConfiguration} from './workspace-config.ts';
import {projectTrustReloadOptions} from './project-trust.ts';
import {createDesktopModelRuntime, LLAMA_PROVIDER} from '../llama.ts';
import {createLlamaExtension} from './llama.ts';
import {createBuiltinExtensions} from '../builtin-extensions.ts';
import {nativeCommand, parseSlashCommand} from './command-catalog.mjs';
import {runSettingsCommand} from './settings-commands.ts';
import {runSessionCommand} from './session-commands.ts';
import {runReportCommand} from './report-commands.ts';
import {runAgentSessionRequest} from './agent-session.ts';

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
  const agentDir = getAgentDir();
  const args = startup ? parseArgs(startup.argv) : undefined;
  const sessionManager = startup
    ? await restoreDesktopSession(startup, agentDir)
    : request.resume
      ? SessionManager.open(request.resume.path, undefined, request.cwd)
      : SessionManager.create(request.cwd);
  if (request.resume && sessionManager.getSessionId() !== request.resume.id)
    throw new Error('This saved session is no longer available.');
  const savedProfileEntry = sessionManager
    .getEntries()
    .findLast(
      entry =>
        entry.type === 'custom' &&
        entry.customType === 'varisdev.agent-profile',
    );
  const savedProfile =
    savedProfileEntry?.type === 'custom'
      ? (savedProfileEntry.data as AgentTemplate | undefined)
      : undefined;
  const profileSnapshot =
    savedProfile ??
    request.agentProfile ??
    (request.resume || startup
      ? createDefaultAgentProfile()
      : await resolveDefaultAgentTemplate(request.cwd, 'primary'));
  const selectedProfile = await ensureAgentProfilePermissions(
    request.cwd,
    profileSnapshot,
  );
  if (
    !request.resume &&
    !startup &&
    (selectedProfile.disabled || selectedProfile.mode === 'subagent')
  )
    throw new Error(
      'Choose an enabled agent profile that supports primary use.',
    );
  const agentProfile = structuredClone(selectedProfile);
  if (
    !savedProfile ||
    JSON.stringify(savedProfile) !== JSON.stringify(agentProfile)
  )
    sessionManager.appendCustomEntry(
      'varisdev.agent-profile',
      structuredClone(agentProfile),
    );
  const savedContextEntry = sessionManager
    .getEntries()
    .findLast(
      entry =>
        entry.type === 'custom' &&
        entry.customType === 'varisdev.agent-context',
    );
  const savedContext =
    savedContextEntry?.type === 'custom'
      ? (savedContextEntry.data as {scope?: unknown} | undefined)
      : undefined;
  const contextScope =
    savedContext?.scope === 'task' || savedContext?.scope === 'workspace'
      ? savedContext.scope
      : (agentProfile?.context ?? 'workspace');
  if (!savedContextEntry && (agentProfile || (!request.resume && !startup)))
    sessionManager.appendCustomEntry('varisdev.agent-context', {
      scope: contextScope,
    });
  const savedInstructions = request.resume
    ? sessionManager
        .getEntries()
        .findLast(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-template',
        )
    : undefined;
  const savedData =
    savedInstructions?.type === 'custom'
      ? (savedInstructions.data as {instructions?: unknown} | undefined)
      : undefined;
  const instructions =
    request.instructions ??
    (typeof savedData?.instructions === 'string'
      ? savedData.instructions
      : undefined);
  if (request.instructions && !request.resume && !startup)
    sessionManager.appendCustomEntry('varisdev.agent-template', {
      instructions: request.instructions,
    });
  const agentResources = createAgentResourcePolicy(agentProfile);
  const configuration = createWorkspaceConfiguration(request.cwd, agentDir);
  const settingsManager = configuration.settingsManager;
  const resources = createAppResourceFilter(
    configuration.resourceSettingsManager,
    request.cwd,
    agentDir,
  );
  const resourceOptions: Partial<ReturnType<typeof desktopResourceOptions>> =
    args ? desktopResourceOptions(args) : {};
  let state: DashboardState | undefined;
  const ui = new DesktopExtensionUI(() => state?.touch());
  const approval = createAgentApprovalRelay({hasUI: true, ui: ui.context});
  const approvalSignal = () => {
    const signals = [...activePrompts]
      .filter(prompt => prompt.countsAsRun)
      .map(prompt => prompt.controller.signal);
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  let context: ExtensionContext | undefined;
  let control: AgentSessionController | undefined;
  let showCustomMessage: ReturnType<typeof observeDashboardSession> | undefined;
  const diagnostics: SessionFeatures['diagnostics'] = [];
  const report = (message: string, path?: string) => {
    diagnostics.push({message, ...(path ? {path} : {})});
    if (diagnostics.length > 100) diagnostics.shift();
    state?.record('error', message);
  };
  const llama = createLlamaExtension();
  const modelRuntime = await createDesktopModelRuntime({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: !inherited,
  });
  const services = await createAgentSessionServices({
    cwd: request.cwd,
    agentDir,
    settingsManager: resources.settingsManager,
    modelRuntime,
    extensionFlagValues: args?.unknownFlags,
    resourceLoaderReloadOptions: projectTrustReloadOptions(
      request.cwd,
      agentDir,
      settingsManager,
      args?.projectTrustOverride,
      report,
    ),
    resourceLoaderOptions: configuration.resourceOptions(
      agentResources.resourceOptions({
        ...resourceOptions,
        ...(agentProfile?.instructions.trim()
          ? {systemPrompt: agentProfile.instructions}
          : {}),
        ...(instructions
          ? {
              appendSystemPrompt: [
                ...(resourceOptions.appendSystemPrompt ?? []),
                instructions,
              ],
            }
          : {}),
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
        extensionFactories: [
          ...createBuiltinExtensions({mcp: configuration.mcpOptions}),
          {name: LLAMA_PROVIDER, factory: llama.extension, builtin: true},
          pi => {
            pi.events.emit('varisdev:agent-profile-managed', {
              sessionId: sessionManager.getSessionId(),
              profile: agentProfile,
            });
            registerProjectTools(pi);
            control = registerAgentTools(pi, undefined, {
              agentProfile,
              ui,
              approval,
              signal: approvalSignal,
            });
            registerCommitCommand(
              pi,
              (...args) => pi.sendUserMessage(...args),
              {
                approval,
                signal: approvalSignal,
              },
            );
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
          ...(agentProfile.permissions.length ||
          agentProfile.steps !== undefined
            ? [
                createAgentPolicyExtension(agentProfile, {
                  label: agentProfile.name,
                  approval,
                  signal: approvalSignal,
                  skills: agentResources.skills,
                }),
              ]
            : []),
        ],
      }),
      contextScope,
    ),
  });
  services.resourceLoader = configuration.resourceLoader(
    services.resourceLoader,
  );
  const loader = services.resourceLoader;
  // Resource deduplication applies to discovery; the session retains its settings.
  services.settingsManager = settingsManager;
  for (const diagnostic of services.diagnostics) report(diagnostic.message);
  if (inherited) {
    const providers = registerParentModelProviders(
      inherited.modelRegistry,
      modelRuntime,
    );
    if (providers.length)
      await modelRuntime.refresh({allowNetwork: false, providers});
  }
  const startupModel = startup?.model
    ? modelRuntime.getModel(startup.model.provider, startup.model.id)
    : undefined;
  if (startup?.model && !startupModel)
    report(
      `Could not restore model ${startup.model.provider}/${startup.model.id}.`,
    );
  if (args?.apiKey && startupModel)
    await modelRuntime.setRuntimeApiKey(startupModel.provider, args.apiKey);
  const patterns = args?.models ?? settingsManager.getEnabledModels();
  const scope = patterns?.length
    ? await resolveModelScopeWithDiagnostics(patterns, modelRuntime)
    : undefined;
  for (const diagnostic of scope?.diagnostics ?? []) report(diagnostic.message);
  const modelPreference = request.model;
  const modelParts = modelPreference?.match(/^([^/]+)\/(.+?)(?:#([^#]+))?$/);
  const requestedModel = modelPreference
    ? (() => {
        if (!modelParts)
          throw new Error('Specify the model as provider/model.');
        const model = modelRuntime.getModel(modelParts[1], modelParts[2]);
        if (!model) throw new Error(`Model is unavailable: ${modelPreference}`);
        return model;
      })()
    : undefined;
  const requestedThinking = request.thinkingLevel ?? modelParts?.[3];
  const selectedModel =
    requestedModel ??
    startupModel ??
    (!request.resume ? inherited?.model : undefined);
  if (
    requestedThinking !== undefined &&
    !(
      selectedModel
        ? supportedThinkingLevels(selectedModel)
        : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    ).includes(requestedThinking)
  )
    throw new Error(
      'This thinking level is unavailable for the selected model.',
    );
  const {session, modelFallbackMessage} = await createAgentSessionFromServices({
    services,
    model: selectedModel,
    thinkingLevel:
      (requestedThinking as CreateAgentSessionOptions['thinkingLevel']) ??
      startup?.thinkingLevel ??
      (!request.resume ? inherited?.thinkingLevel : undefined),
    scopedModels: scope?.scopedModels,
    tools: startup?.tools,
    excludeTools: args?.excludeTools,
    sessionManager,
  });
  if (modelFallbackMessage) report(modelFallbackMessage);
  // SDK initialization can append model metadata to an otherwise blank branch.
  if (startup?.leafId) sessionManager.branch(startup.leafId);
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
  const unsubscribeSessionEvents = session.subscribe(event => {
    if (event.type === 'queue_update')
      state?.updateQueue(event.steering, event.followUp);
    if (
      event.type === 'entry_appended' &&
      event.entry.type === 'usage' &&
      context
    )
      showCustomMessage?.restoreUsage(context);
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
      onError: error => {
        report(error.error, error.extensionPath);
        ui.context.notify(error.error, 'error');
      },
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
      throw new Error('Main agent observation did not start.');
    state.updateQueue(
      session.getSteeringMessages(),
      session.getFollowUpMessages(),
    );
  } catch (error) {
    try {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
    } finally {
      unsubscribeSessionEvents();
      ui.dispose();
      session.dispose();
    }
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let stopping: Promise<StoppedMessages> | undefined;
  let stoppedMessages: StoppedMessages | undefined;
  interface PromptRun {
    cancelled: boolean;
    controller: AbortController;
    operation: Promise<void>;
    trackExtensionOperations: boolean;
    extensionOperations: Promise<void>[];
    countsAsRun: boolean;
  }
  const activePrompts = new Set<PromptRun>();
  const extensionPrompts = new Set<PromptRun>();
  let maintaining = false;
  // Extension commands can start model turns without returning their promises.
  const sendUserMessage = session.sendUserMessage.bind(session);
  session.sendUserMessage = (...args) => {
    const operation = sendUserMessage(...args);
    for (const prompt of extensionPrompts)
      if (prompt.trackExtensionOperations)
        prompt.extensionOperations.push(operation);
    return operation;
  };
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    const operation = sendCustomMessage(message, options);
    if (options?.triggerTurn)
      for (const prompt of extensionPrompts)
        if (prompt.trackExtensionOperations)
          prompt.extensionOperations.push(operation);
    return operation;
  };
  const preserveQueue = () => {
    const queued = session.clearQueue();
    stoppedMessages?.steering.push(...queued.steering);
    stoppedMessages?.followUp.push(...queued.followUp);
  };
  const stop = () => {
    llama.cancel();
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
    for (const prompt of running) {
      prompt.cancelled = true;
      prompt.controller.abort();
    }
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
    if (closed) throw new Error('This workspace has closed.');
    if (stopping) throw new Error('The main agent is stopping.');
  };
  const requireIdle = () => {
    requireOpen();
    if (activePrompts.size || session.isStreaming || session.isCompacting)
      throw new Error('The main agent is already working.');
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
      await session.setModel(model, {persist: options.persist});
    requireOpen();
    if (options.thinkingLevel !== undefined)
      session.setThinkingLevel(
        options.thinkingLevel as Parameters<typeof session.setThinkingLevel>[0],
        {persist: options.persist},
      );
    state!.updateSession({
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined,
      thinkingLevel: session.thinkingLevel,
    });
    refreshAutocomplete();
  };
  const localCommand = async (
    name: string,
    args: string,
    signal: AbortSignal,
  ) => {
    const commandUI = ui.forCommand(signal);
    const commandContext = {
      session,
      ui: commandUI,
      signal,
      configure: async (options: SessionConfiguration) => {
        if (!signal.aborted) await configurationAction(options);
      },
    };
    if (name === 'approvals') {
      if (args) throw new Error('Usage: /approvals');
      await showAgentApprovals(
        {
          ...session.extensionRunner.createContext(),
          hasUI: true,
          ui: commandUI.context,
        },
        {signal},
      );
      return;
    }
    if (name === 'compact') {
      await session.compact(args || undefined);
      return;
    }
    if (name === 'reload') {
      if (args) throw new Error('Usage: /reload');
      await reload();
      return;
    }
    if (await runSettingsCommand(name, args, commandContext)) return;
    const result = await runSessionCommand(name, args, commandContext);
    if (result) {
      if (signal.aborted) return;
      if (result.kind === 'replace') {
        const replacement = result.replacement;
        const target = SessionManager.open(replacement.sessionFile);
        commandUI.navigate(
          replacement.cwd,
          target.getSessionId(),
          replacement.editorText,
        );
      } else if (result.kind === 'done') {
        showCustomMessage?.restore(context!);
        state!.updateSession({
          name:
            session.sessionManager.getSessionName() ||
            state!.snapshot().session.name,
          model: session.model
            ? `${session.model.provider}/${session.model.id}`
            : undefined,
          thinkingLevel: session.thinkingLevel,
        });
        if (result.message) commandUI.context.notify(result.message);
      }
      return;
    }
    if (await runReportCommand(name, args, commandContext)) return;
    // Never send a known native command to the model as ordinary prompt text.
    throw new Error(`/${name} must be opened from the VarisDev desktop.`);
  };
  const sessionAction = async (
    action: () => Promise<unknown>,
    allowRunning = false,
  ) => {
    requireOpen();
    if (!allowRunning) {
      if (maintaining || session.isCompacting)
        throw new Error('This session is updating. Try again when it is idle.');
      requireIdle();
    }
    const running = {
      cancelled: false,
      controller: new AbortController(),
      operation: Promise.resolve(),
      trackExtensionOperations: false,
      extensionOperations: [] as Promise<void>[],
      countsAsRun: false,
    };
    if (!allowRunning) maintaining = true;
    activePrompts.add(running);
    running.operation = Promise.resolve()
      .then(async () => {
        if (!running.cancelled) await action();
      })
      .finally(() => {
        activePrompts.delete(running);
        if (!allowRunning) maintaining = false;
      });
    await running.operation;
  };
  // Pi applies model and effort changes before the next assistant turn.
  const configurationAction = (options: SessionConfiguration) =>
    sessionAction(() => configure(options), true);
  return {
    state,
    ui,
    features: async () => {
      const result = await modelRuntime.refresh({
        providers: [LLAMA_PROVIDER],
        allowNetwork: true,
        signal: AbortSignal.timeout(5000),
      });
      const failure = result.errors.get(LLAMA_PROVIDER);
      const features = sessionFeatures(session, loader, settingsManager, [
        ...diagnostics,
        ...(failure ? [{message: `llama.cpp: ${failure.message}`}] : []),
      ]);
      features.agentProfile = agentProfileSummary(agentProfile);
      features.agentMentions = await discoverAgentMentions(
        sessionManager.getCwd(),
        agentProfile,
      );
      return features;
    },
    configure: configurationAction,
    lastAssistantText: () => session.getLastAssistantText(),
    compact: instructions =>
      sessionAction(() => session.compact(instructions), true),
    reload: () => sessionAction(reload),
    async prompt(text, images) {
      requireOpen();
      const parsed = parseSlashCommand(text);
      const name = parsed?.name;
      const args = parsed?.args ?? '';
      const local = name ? nativeCommand(name) : undefined;
      const extension = name && session.extensionRunner.getCommand(name);
      if (maintaining && !local?.live && !extension)
        throw new Error('This session is updating. Try again when it is idle.');
      const steering = [...activePrompts].some(prompt => prompt.countsAsRun);
      const running: PromptRun = {
        cancelled: false,
        controller: new AbortController(),
        operation: Promise.resolve(),
        trackExtensionOperations: false,
        extensionOperations: [],
        countsAsRun: !local,
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
            if (
              name?.startsWith('skill:') &&
              !settingsManager.getEnableSkillCommands()
            )
              throw new Error('Skill commands are disabled in settings.');
            if (local) {
              if (
                !local.live &&
                (steering || session.isStreaming || session.isCompacting)
              )
                throw new Error(
                  'Wait until this session is idle to run this command.',
                );
              await localCommand(name!, args, running.controller.signal);
              return;
            }
            if (!session.model && !extension && !parseAgentMention(text))
              throw new Error(
                'Choose a model in Menu → Model before sending a prompt.',
              );
            if (extension) {
              extensionPrompts.add(running);
              running.trackExtensionOperations = true;
            }
            if (steering && !session.isStreaming && !extension) {
              // A prompt can arrive while the first request is still in SDK preflight.
              // Put it directly into Pi's steering queue instead of starting a second run.
              await session.steer(text, images);
            } else {
              const leafBeforePrompt = session.sessionManager.getLeafId();
              let rewindCancelledPreflight = false;
              try {
                await session.prompt(
                  extension ? '/' + name + (args ? ' ' + args : '') : text,
                  {
                    expandPromptTemplates: true,
                    streamingBehavior: 'steer',
                    images,
                    preflightResult: disposition => {
                      if (
                        disposition === 'started' &&
                        running.cancelled &&
                        !aborting
                      ) {
                        rewindCancelledPreflight = true;
                        aborting = stop().catch(() => {});
                      }
                    },
                  },
                );
              } finally {
                await aborting;
                if (rewindCancelledPreflight) {
                  // Pi 1.2+ accepts the run only after credential preflight. Rewind
                  // the immediately-aborted branch so cancellation stays invisible.
                  if (leafBeforePrompt)
                    session.sessionManager.branch(leafBeforePrompt);
                  else session.sessionManager.resetLeaf();
                  // Make the restored leaf the final persisted path too. Otherwise
                  // reopening the JSONL file would select the abandoned abort again.
                  session.sessionManager.appendCustomEntry(
                    'varisdev.cancelled-preflight',
                  );
                  session.refreshContext();
                  showCustomMessage!.restore(context!);
                }
              }
            }
            for (const operation of running.extensionOperations)
              await operation;
          } catch (error) {
            if (!running.cancelled) throw error;
          } finally {
            unsubscribe();
            await aborting;
            extensionPrompts.delete(running);
          }
        })
        .finally(() => activePrompts.delete(running));
      await running.operation;
    },
    abort,
    restartSnapshot() {
      requireIdle();
      if (maintaining || !session.isIdle)
        throw new Error('The main agent is already working.');
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
        argv: [
          ...(startup?.argv ?? []),
          ...(instructions ? ['--append-system-prompt', instructions] : []),
        ],
      });
    },
    async agentSession(request) {
      if (closed) throw new Error('This workspace has closed.');
      if (!control!.snapshot())
        throw new Error('This session has no agent conversations.');
      return runAgentSessionRequest(
        control!.getTeam(context!).getManager(),
        request,
      );
    },
    async cancelAgent(agentId) {
      if (closed) throw new Error('This workspace has closed.');
      if (!control!.snapshot()) {
        if (agentId === 'all') return;
        throw new Error('This workspace has no additional agents.');
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
