import {
  getPackageDir,
  type AgentSession,
  type SettingsConfig,
  type SettingsCallbacks,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DesktopExtensionUI} from './extension-ui.ts';
import type {SessionConfiguration} from './features.ts';
import {runAuthCommand} from './native-auth-commands.ts';
import {
  runScopedModelsSettings,
  runTrustSettings,
} from './native-resource-settings.ts';

export interface SettingsCommandContext {
  session: AgentSession;
  ui: DesktopExtensionUI;
  configure(options: SessionConfiguration): Promise<void>;
  signal?: AbortSignal;
}

type Model = NonNullable<AgentSession['model']>;
const stopped = (ctx: SettingsCommandContext) => ctx.signal?.aborted === true;

// Pi's interactive /model command uses these shipped helpers; they are not root exports.
const modelResolver = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/model-resolver.js')).href
)) as {
  findExactModelReferenceMatch(
    text: string,
    models: readonly Model[],
  ): Model | undefined;
};
const modelCatalogs = (await import(
  pathToFileURL(
    join(getPackageDir(), 'dist/modes/interactive/model-catalog-refresh.js'),
  ).href
)) as {
  refreshModelCatalogs(
    runtime: AgentSession['modelRuntime'],
    signal: AbortSignal,
  ): ReturnType<AgentSession['modelRuntime']['refresh']>;
};

const {DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/defaults.js')).href
)) as {
  DEFAULT_THINKING_LEVEL: AgentSession['thinkingLevel'];
  THINKING_LEVEL_OPTIONS: SettingsConfig['availableThinkingLevels'];
};

async function sessionModelSettings(
  ctx: SettingsCommandContext,
  activeTab: 'model' | 'thinking',
  initialSearch?: string,
): Promise<void> {
  const session = ctx.session;
  const levels = session.getAvailableThinkingLevels();
  const defaultProvider = session.settingsManager.getDefaultProvider();
  const defaultModel = session.settingsManager.getDefaultModel();
  const selection = await ctx.ui.selectSessionSettings({
    activeTab,
    model: {
      currentModel: session.model,
      modelRuntime: session.modelRuntime,
      scopedModels: session.scopedModels,
      defaultModel:
        defaultProvider && defaultModel
          ? {provider: defaultProvider, id: defaultModel}
          : undefined,
      initialSearch,
    },
    thinking: {
      currentLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      availableLevels: levels,
      defaultLevel:
        session.settingsManager.getDefaultThinkingLevel() ??
        DEFAULT_THINKING_LEVEL,
    },
  });
  if (stopped(ctx) || !selection) return;
  if (selection.kind === 'thinking') {
    if (!levels.includes(selection.thinkingLevel))
      throw new Error(`Thinking level must be one of: ${levels.join(', ')}.`);
    await ctx.configure({
      thinkingLevel: selection.thinkingLevel,
      persist: selection.persist,
    });
  } else {
    await ctx.configure({
      provider: selection.model.provider,
      modelId: selection.model.id,
      persist: selection.persist,
    });
  }
}

async function thinkingCommand(
  ctx: SettingsCommandContext,
  args: string,
): Promise<void> {
  if (!args) return sessionModelSettings(ctx, 'thinking');
  const levels = ctx.session.getAvailableThinkingLevels();
  const thinkingLevel = args.toLowerCase();
  if (!levels.includes(thinkingLevel as (typeof levels)[number]))
    throw new Error(`Thinking level must be one of: ${levels.join(', ')}.`);
  await ctx.configure({thinkingLevel, persist: false});
}

async function exactModel(
  ctx: SettingsCommandContext,
  args: string,
): Promise<Model | undefined> {
  const session = ctx.session;
  const models = session.scopedModels.length
    ? session.scopedModels.map(scoped => scoped.model)
    : session.modelRuntime.getAvailableSnapshot();
  const match = modelResolver.findExactModelReferenceMatch(args, models);
  if (match || session.scopedModels.length) return match;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const signal = ctx.signal
    ? AbortSignal.any([controller.signal, ctx.signal])
    : controller.signal;
  try {
    const result = await modelCatalogs.refreshModelCatalogs(
      session.modelRuntime,
      signal,
    );
    if (stopped(ctx)) return undefined;
    if (result.aborted || result.errors.size)
      ctx.ui.context.notify(
        result.aborted
          ? 'Model refresh timed out; searching cached models.'
          : `Could not refresh ${[...result.errors.keys()].join(', ')}; searching cached models.`,
        'warning',
      );
  } catch (error) {
    if (stopped(ctx)) return undefined;
    ctx.ui.context.notify(
      controller.signal.aborted
        ? 'Model refresh timed out; searching cached models.'
        : `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
      'warning',
    );
  } finally {
    clearTimeout(timeout);
  }
  return modelResolver.findExactModelReferenceMatch(
    args,
    session.modelRuntime.getAvailableSnapshot(),
  );
}

async function modelCommand(
  ctx: SettingsCommandContext,
  args: string,
): Promise<void> {
  const model = args ? await exactModel(ctx, args) : undefined;
  if (stopped(ctx)) return;
  if (model) {
    await ctx.configure({
      provider: model.provider,
      modelId: model.id,
      persist: false,
    });
    return;
  }
  await sessionModelSettings(ctx, 'model', args || undefined);
}

async function flushSettings(ctx: SettingsCommandContext): Promise<void> {
  await ctx.session.settingsManager.flush();
  const errors = ctx.session.settingsManager.drainErrors();
  if (errors.length)
    throw new Error(
      errors
        .map(({scope, error}) => `${scope} settings: ${error.message}`)
        .join('\n'),
    );
}

const {configureHttpDispatcher} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/http-dispatcher.js')).href
)) as {configureHttpDispatcher(timeoutMs: number): void};

async function settingsCommand(ctx: SettingsCommandContext): Promise<void> {
  const session = ctx.session;
  const settings = session.settingsManager;
  ctx.ui.previewTheme(settings.getThemeSetting() ?? 'system');
  const failures = new AbortController();
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, failures.signal])
    : failures.signal;
  let pending = Promise.resolve();
  const change = (apply: () => void) => {
    if (stopped(ctx) || failures.signal.aborted) return;
    apply();
    pending = pending.then(async () => {
      await flushSettings(ctx);
      if (!stopped(ctx)) await ctx.configure({});
    });
    // Close the selector when persistence fails; the awaiting command reports the error.
    void pending.catch(() => failures.abort());
  };
  const defaultProvider = settings.getDefaultProvider();
  const defaultModel = settings.getDefaultModel();
  const config: SettingsConfig = {
    autoCompact: session.autoCompactionEnabled,
    defaultModel:
      defaultProvider && defaultModel
        ? `${defaultProvider}/${defaultModel}`
        : 'not set',
    currentModel: session.model,
    availableDefaultModels: session.modelRuntime.getAvailableSnapshot(),
    showImages: settings.getShowImages(),
    imageWidthCells: settings.getImageWidthCells(),
    autoResizeImages: settings.getImageAutoResize(),
    blockImages: settings.getBlockImages(),
    enableSkillCommands: settings.getEnableSkillCommands(),
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    transport: settings.getTransport(),
    sessionShareDestination: settings.getSessionShareDestination(),
    httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
    cacheWarmingMode: settings.getCacheWarmingMode(),
    thinkingLevel: settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
    availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
    modelThinkingLevels: settings.getAllModelThinkingLevels(),
    currentTheme: settings.getThemeSetting() ?? 'system',
    terminalTheme: ctx.ui.context.theme.appearance,
    availableThemes: ctx.ui.context.getAllThemes().map(theme => theme.name),
    hideThinkingBlock: settings.getHideThinkingBlock(),
    mermaidRenderingMode: settings.getMermaidRenderingMode(),
    showCacheMissNotices: settings.getShowCacheMissNotices(),
    collapseChangelog: settings.getCollapseChangelog(),
    enableInstallTelemetry: settings.getEnableInstallTelemetry(),
    doubleEscapeAction: settings.getDoubleEscapeAction(),
    treeFilterMode: settings.getTreeFilterMode(),
    showHardwareCursor: settings.getShowHardwareCursor(),
    editorPaddingX: settings.getEditorPaddingX(),
    outputPad: settings.getOutputPad(),
    autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
    quietStartup: settings.getQuietStartup(),
    defaultProjectTrust: settings.getDefaultProjectTrust(),
    clearOnShrink: settings.getClearOnShrink(),
    showTerminalProgress: settings.getShowTerminalProgress(),
    tuiMode: settings.getTuiMode(),
    fullscreenExitOutput: settings.getFullscreenExitOutput(),
    fullscreenScrollbar: settings.getFullscreenScrollbar(),
    fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
    fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
    warnings: settings.getWarnings(),
  };
  const callbacks: Omit<SettingsCallbacks, 'onCancel'> = {
    onAutoCompactChange: value =>
      change(() => session.setAutoCompactionEnabled(value)),
    onShowImagesChange: value => change(() => settings.setShowImages(value)),
    onImageWidthCellsChange: value =>
      change(() => settings.setImageWidthCells(value)),
    onAutoResizeImagesChange: value =>
      change(() => settings.setImageAutoResize(value)),
    onBlockImagesChange: value => change(() => settings.setBlockImages(value)),
    onEnableSkillCommandsChange: value =>
      change(() => settings.setEnableSkillCommands(value)),
    onSteeringModeChange: value => change(() => session.setSteeringMode(value)),
    onFollowUpModeChange: value => change(() => session.setFollowUpMode(value)),
    onTransportChange: value =>
      change(() => {
        settings.setTransport(value);
        session.agent.transport = value;
      }),
    onSessionShareDestinationChange: value =>
      change(() => settings.setSessionShareDestination(value)),
    onHttpIdleTimeoutMsChange: value =>
      change(() => {
        settings.setHttpIdleTimeoutMs(value);
        configureHttpDispatcher(value);
      }),
    onCacheWarmingModeChange: value =>
      change(() => session.setCacheWarmingMode(value)),
    onModelThinkingLevelChange: (provider, modelId, level) =>
      change(() => {
        settings.setModelThinkingLevel(provider, modelId, level);
        if (
          session.model?.provider === provider &&
          session.model.id === modelId
        )
          session.setThinkingLevel(level);
      }),
    onModelThinkingLevelRemove: (provider, modelId) =>
      change(() => {
        settings.removeModelThinkingLevel(provider, modelId);
        if (
          session.model?.provider === provider &&
          session.model.id === modelId
        )
          session.setThinkingLevel(
            settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
          );
      }),
    onThemeChange: value =>
      change(() => {
        settings.setTheme(value);
        ctx.ui.previewTheme(value);
      }),
    onThemePreview: value => ctx.ui.previewTheme(value),
    onHideThinkingBlockChange: value =>
      change(() => settings.setHideThinkingBlock(value)),
    onMermaidRenderingModeChange: value =>
      change(() => settings.setMermaidRenderingMode(value)),
    onShowCacheMissNoticesChange: value =>
      change(() => settings.setShowCacheMissNotices(value)),
    onCollapseChangelogChange: value =>
      change(() => settings.setCollapseChangelog(value)),
    onEnableInstallTelemetryChange: value =>
      change(() => settings.setEnableInstallTelemetry(value)),
    onDoubleEscapeActionChange: value =>
      change(() => settings.setDoubleEscapeAction(value)),
    onTreeFilterModeChange: value =>
      change(() => settings.setTreeFilterMode(value)),
    onShowHardwareCursorChange: value =>
      change(() => settings.setShowHardwareCursor(value)),
    onEditorPaddingXChange: value =>
      change(() => settings.setEditorPaddingX(value)),
    onOutputPadChange: value => change(() => settings.setOutputPad(value)),
    onAutocompleteMaxVisibleChange: value =>
      change(() => settings.setAutocompleteMaxVisible(value)),
    onQuietStartupChange: value =>
      change(() => settings.setQuietStartup(value)),
    onDefaultProjectTrustChange: value =>
      change(() => settings.setDefaultProjectTrust(value)),
    onClearOnShrinkChange: value =>
      change(() => settings.setClearOnShrink(value)),
    onShowTerminalProgressChange: value =>
      change(() => settings.setShowTerminalProgress(value)),
    onTuiModeChange: value => change(() => settings.setTuiMode(value)),
    onFullscreenExitOutputChange: value =>
      change(() => settings.setFullscreenExitOutput(value)),
    onFullscreenScrollbarChange: value =>
      change(() => settings.setFullscreenScrollbar(value)),
    onFullscreenCopyOnSelectChange: value =>
      change(() => settings.setFullscreenCopyOnSelect(value)),
    onFullscreenWheelScrollLinesChange: value =>
      change(() => settings.setFullscreenWheelScrollLines(value)),
    onWarningsChange: value => change(() => settings.setWarnings(value)),
  };
  try {
    await ctx.ui.forCommand(signal).selectSettings(config, callbacks);
  } finally {
    ctx.ui.previewTheme(settings.getThemeSetting() ?? 'system');
    await pending;
  }
}

/** Native Pi session controls. Errors propagate to the host's command error surface. */
export async function runSettingsCommand(
  name: string,
  args: string,
  ctx: SettingsCommandContext,
): Promise<boolean> {
  if (await runAuthCommand(name, args, ctx)) return true;
  if (
    !['thinking', 'model', 'settings', 'scoped-models', 'trust'].includes(name)
  )
    return false;
  if (stopped(ctx)) return true;
  args = args.trim();
  if (name === 'thinking') await thinkingCommand(ctx, args);
  else if (name === 'model') await modelCommand(ctx, args);
  else {
    if (args) throw new Error(`Use /${name} without arguments.`);
    if (name === 'settings') await settingsCommand(ctx);
    else if (name === 'scoped-models') await runScopedModelsSettings(ctx);
    else await runTrustSettings(ctx);
  }
  return true;
}
