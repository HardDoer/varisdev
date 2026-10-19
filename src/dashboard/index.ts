import {discoverAgentMentions} from '../agents/mentions.ts';
import {
  sessionEntryToContextMessages,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../agents/team.ts';
import {dispatchAgentMention, type AgentToolsOptions} from '../tools/agents.ts';
import {
  createAgentApprovalRelay,
  showAgentApprovals,
} from '../agents/approval-ui.ts';
import {
  createAgentPolicyExtension,
  decideAgentPermission,
} from '../agents/policy.ts';
import {
  createDefaultAgentProfile,
  ensureAgentProfilePermissions,
  type AgentTemplate,
} from '../agents/templates.ts';
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
import {
  supportedThinkingLevels,
  sessionAgentProfile,
  type SessionFeatures,
} from './features.ts';
import {attachedContextFiles} from './context-files.ts';
import {nativeCommand, parseSlashCommand} from './command-catalog.mjs';
import {runAgentSessionRequest} from './agent-session.ts';

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
  configurations: Set<Promise<void>>;
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
  shared: AgentToolsOptions = {},
): void {
  let binding: FactoryBinding | undefined;
  let generation = 0;
  let cancelBeforeStart = false;
  let approvalController = new AbortController();
  const managedProfiles = new Map<string, AgentTemplate>();
  let nativeSkills: {sessionId: string; skills: readonly Skill[]} | undefined;
  const applyNativePrompt = (
    options: BuildSystemPromptOptions,
    profile: AgentTemplate,
    cwd: string,
  ) => {
    if (profile.instructions.trim())
      options.customPrompt = profile.instructions;
    const skills = options.skills ?? [];
    const visible = skills.filter(
      skill =>
        decideAgentPermission(profile, 'skill', skill.name, undefined, cwd) !==
          'deny' &&
        (profile.context !== 'task' ||
          !skill.sourceInfo ||
          skill.sourceInfo.scope === 'temporary'),
    );
    if (visible.length !== skills.length) options.skills = visible;
  };
  const nativePolicyCleanup: Array<() => void> = [];
  const releaseManaged = pi.events.on(
    'varisdev:agent-profile-managed',
    value => {
      if (!value || typeof value !== 'object') return;
      const managed = value as {sessionId?: string; profile?: AgentTemplate};
      if (managed.sessionId && managed.profile)
        managedProfiles.set(
          managed.sessionId,
          structuredClone(managed.profile),
        );
    },
  );
  const ensureAttached = (current: FactoryBinding) => {
    if (binding !== current)
      throw new Error('This workspace is no longer attached to the app.');
  };
  const maintain = async (
    current: FactoryBinding,
    action: () => Promise<void>,
    allowRunning = false,
  ) => {
    ensureAttached(current);
    const status = current.state.deliverySnapshot().session.status;
    if (
      current.stopping ||
      status === 'closed' ||
      (!allowRunning &&
        (current.maintaining || current.submissions || !current.ctx.isIdle()))
    )
      throw new Error('Wait until this session is idle.');
    if (!allowRunning) current.maintaining = true;
    const epoch = current.epoch;
    const operation = Promise.resolve().then(() => {
      ensureAttached(current);
      if (current.stopping || current.epoch !== epoch)
        throw new Error('This session is stopping.');
      return action();
    });
    current.configurations.add(operation);
    try {
      await operation;
      ensureAttached(current);
    } finally {
      current.configurations.delete(operation);
      if (!allowRunning) current.maintaining = false;
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
  pi.on('session_start', async (_event, ctx) => {
    const version = generation;
    const saved = ctx.sessionManager
      .getEntries()
      .findLast(
        entry =>
          entry.type === 'custom' &&
          entry.customType === 'varisdev.agent-profile',
      );
    const snapshot =
      saved?.type === 'custom'
        ? (saved.data as AgentTemplate | undefined)
        : undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const profile = await ensureAgentProfilePermissions(
      ctx.cwd,
      snapshot ?? managedProfiles.get(sessionId) ?? createDefaultAgentProfile(),
    );
    if (version !== generation) return;
    if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(profile))
      pi.appendEntry('varisdev.agent-profile', structuredClone(profile));
    shared.agentProfile = structuredClone(profile);
    for (const release of nativePolicyCleanup.splice(0)) release();
    if (managedProfiles.has(sessionId)) return;
    approvalController.abort();
    approvalController = new AbortController();
    shared.approval = createAgentApprovalRelay(
      ctx,
      () => approvalController.signal,
    );
    shared.signal = () => approvalController.signal;
    shared.approvalUI = ctx.hasUI ? ctx.ui : undefined;
    if (!profile.permissions.length && profile.steps === undefined) return;
    type Handler = (event: unknown, context: ExtensionContext) => unknown;
    const register = pi.on as unknown as (
      name: string,
      handler: Handler,
    ) => () => void;
    const nativePi: ExtensionAPI = {
      ...pi,
      on: ((name: string, handler: Handler) => {
        const release = register(name, (event, context) => {
          if (
            context.sessionManager.getSessionId() !== sessionId ||
            managedProfiles.has(sessionId)
          )
            return;
          return handler(event, context);
        });
        nativePolicyCleanup.push(release);
        return release;
      }) as ExtensionAPI['on'],
    };
    await createAgentPolicyExtension(profile, {
      label: profile.name,
      approval: shared.approval,
      signal: () => approvalController.signal,
      skills: () => {
        const retained =
          nativeSkills?.sessionId === sessionId ? nativeSkills.skills : [];
        const paths = new Set(retained.map(skill => skill.filePath));
        return [
          ...retained,
          ...pi.getCommands().flatMap(command => {
            if (
              command.source !== 'skill' ||
              !command.name.startsWith('skill:') ||
              !command.sourceInfo.path
            )
              return [];
            if (paths.has(command.sourceInfo.path)) return [];
            return [
              {
                name: command.name.slice('skill:'.length),
                filePath: command.sourceInfo.path,
              },
            ];
          }),
        ];
      },
    })(nativePi);
  });
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
      configurations: new Set(),
      epoch: 0,
      control: {
        async features(): Promise<SessionFeatures> {
          ensureAttached(current);
          const registryError = ctx.modelRegistry.getError();
          const profile = shared.agentProfile;
          const managed = managedProfiles.has(
            ctx.sessionManager.getSessionId(),
          );
          const commands = pi
            .getCommands()
            .filter(
              command =>
                managed ||
                !profile ||
                command.source !== 'skill' ||
                decideAgentPermission(
                  profile,
                  'skill',
                  command.name.replace(/^skill:/, ''),
                  undefined,
                  ctx.cwd,
                ) !== 'deny',
            )
            .map(command => ({
              name: command.name,
              description: command.description ?? '',
              source: command.source,
              path: command.sourceInfo.path,
            }));
          let promptOptions =
            current.getSystemPromptOptions?.() ?? current.systemPromptOptions;
          if (!managed && profile && promptOptions) {
            promptOptions = {...promptOptions};
            applyNativePrompt(promptOptions, profile, ctx.cwd);
          }
          const contextFiles = attachedContextFiles(
            promptOptions,
            commands,
            ctx.sessionManager
              .buildContextEntries?.()
              .flatMap(sessionEntryToContextMessages),
            ctx.cwd,
          );
          return {
            agentProfile: sessionAgentProfile(ctx.sessionManager),
            agentMentions: await discoverAgentMentions(ctx.cwd, profile),
            ...(contextFiles ? {contextFiles} : {}),
            commands,
            models: ctx.modelRegistry.getAvailable().map(model => ({
              id: model.id,
              provider: model.provider,
              name: model.name,
            })),
            scopedModels: ctx.scopedModels.map(({model, thinkingLevel}) => ({
              model: {
                id: model.id,
                provider: model.provider,
                name: model.name,
              },
              ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
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
          if (configuration.persist)
            throw new Error('Save startup defaults in the attached terminal.');
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
            true,
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
          if (
            typeof prompt !== 'string' ||
            !prompt.trim() ||
            prompt.length > 64000
          )
            throw new Error('Prompt must contain 1 to 64000 characters.');
          const parsed = parseSlashCommand(prompt);
          const native = parsed && nativeCommand(parsed.name);
          if (current.stopping || (current.maintaining && !native?.live))
            throw new Error(
              'This session is updating. Try again when it is idle.',
            );
          if (native) {
            if (parsed!.name === 'approvals') {
              if (parsed!.args) throw new Error('Usage: /approvals');
              if (approvalController.signal.aborted)
                approvalController = new AbortController();
              await showAgentApprovals(ctx, {
                signal: approvalController.signal,
              });
              return;
            }
            if (parsed!.name === 'model' && parsed!.args.includes('/')) {
              const separator = parsed!.args.indexOf('/');
              await current.control.configure({
                provider: parsed!.args.slice(0, separator),
                modelId: parsed!.args.slice(separator + 1),
              });
              return;
            }
            if (parsed!.name === 'thinking' && parsed!.args) {
              await current.control.configure({
                thinkingLevel: parsed!.args.toLowerCase(),
              });
              return;
            }
            if (parsed!.name === 'compact') {
              await current.control.compact(parsed!.args || undefined);
              return;
            }
            if (parsed!.name === 'name' && parsed!.args) {
              pi.setSessionName(parsed!.args);
              return;
            }
            throw new Error(`Run /${parsed!.name} in the attached terminal.`);
          }
          const epoch = current.epoch;
          current.submissions++;
          try {
            cancelBeforeStart = false;
            if (approvalController.signal.aborted)
              approvalController = new AbortController();
            const mention = await dispatchAgentMention(
              control,
              {text: prompt.trim()},
              ctx,
              approvalController.signal,
            );
            ensureAttached(current);
            if (current.epoch !== epoch || current.stopping) return;
            if (mention.action === 'handled') {
              state.record('message', prompt.trim());
              return;
            }
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
        async agentSession(request) {
          ensureAttached(current);
          if (!control.snapshot())
            throw new Error('This session has no agent conversations.');
          const result = await runAgentSessionRequest(
            control.getTeam(ctx).getManager(),
            request,
          );
          ensureAttached(current);
          return result;
        },
        async cancelAgent(agentId) {
          ensureAttached(current);
          if (!control.snapshot()) {
            if (agentId === 'all') return;
            throw new Error('This workspace has no additional agents.');
          }
          const manager = control.getTeam(ctx).getManager();
          if (agentId === 'all') {
            for (const agent of manager.list()) manager.cancel(agent.id);
          } else manager.cancel(agentId);
        },
        async abort() {
          if (binding !== current)
            throw new Error('This workspace is no longer attached to the app.');
          current.epoch++;
          current.stopping = true;
          cancelBeforeStart = true;
          approvalController.abort();
          state.record('session', 'Stopping');
          const queued = state.deliverySnapshot().queue ?? {
            steering: [],
            followUp: [],
          };
          ctx.abort();
          try {
            await Promise.allSettled([...current.configurations]);
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
    const sessionId = ctx.sessionManager.getSessionId();
    const profile = shared.agentProfile;
    if (!managedProfiles.has(sessionId) && profile) {
      const skills = event.systemPromptOptions.skills;
      nativeSkills = {sessionId, skills: [...skills]};
      applyNativePrompt(event.systemPromptOptions, profile, ctx.cwd);
    }
    if (
      binding?.ctx.sessionManager.getSessionId() ===
      ctx.sessionManager.getSessionId()
    )
      binding.systemPromptOptions = event.systemPromptOptions;
  });
  pi.on('input', event => {
    if (event.source === 'interactive' || event.source === 'rpc') {
      cancelBeforeStart = false;
      if (approvalController.signal.aborted)
        approvalController = new AbortController();
    }
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
    approvalController.abort();
    for (const release of nativePolicyCleanup.splice(0)) release();
    generation++;
    const current = binding;
    binding = undefined;
    if (current) {
      current.epoch++;
    }
    cancelBeforeStart = false;
    if (current) connection.detach(current.state, event.reason === 'quit');
    releaseManaged();
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
