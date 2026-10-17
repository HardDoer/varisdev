import {
  getAgentDir,
  getPackageDir,
  ProjectTrustStore,
  resolveModelScopeWithDiagnostics,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DesktopExtensionUI} from './extension-ui.ts';
import type {SessionConfiguration} from './features.ts';

export interface SettingsCommandContext {
  session: AgentSession;
  ui: DesktopExtensionUI;
  configure(options: SessionConfiguration): Promise<void>;
  signal?: AbortSignal;
}

type Model = NonNullable<AgentSession['model']>;
type ScopedModel = AgentSession['scopedModels'][number];
type SelectOptions = {
  selected?: string;
  message?: string;
  searchable?: boolean;
};
const reference = (model: Model) => `${model.provider}/${model.id}`;
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

const {DEFAULT_THINKING_LEVEL} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/defaults.js')).href
)) as {DEFAULT_THINKING_LEVEL: AgentSession['thinkingLevel']};

/** Validate even mocked/custom UIs; never interpret an arbitrary response as a setting. */
async function select(
  ctx: SettingsCommandContext,
  title: string,
  options: string[],
  config: SelectOptions = {},
): Promise<string | undefined> {
  if (stopped(ctx)) return undefined;
  const result = await ctx.ui.select(title, options, config);
  if (stopped(ctx) || result === undefined) return undefined;
  if (!options.includes(result)) throw new Error('Invalid settings selection.');
  return result;
}

/** Bound both item count and serialized bytes, including very large provider catalogs. */
async function pagedSelect(
  ctx: SettingsCommandContext,
  title: string,
  items: string[],
  config: SelectOptions = {},
): Promise<string | undefined> {
  const pages: string[][] = [];
  let page: string[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (size > 512 * 1024)
      throw new Error('A model catalog entry is too large to display.');
    if (page.length && (page.length >= 200 || bytes + size > 512 * 1024)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  if (page.length) pages.push(page);
  if (!pages.length) return undefined;
  let index = Math.max(
    0,
    pages.findIndex(p => p.includes(config.selected ?? '')),
  );
  // Catalog IDs are arbitrary strings; navigation must not shadow a real entry.
  let previous = '← Previous page';
  let next = 'Next page →';
  const ids = new Set(items);
  while (ids.has(previous)) previous += ' ←';
  while (ids.has(next)) next += ' →';
  while (!stopped(ctx)) {
    const options = [...pages[index]];
    if (index > 0) options.push(previous);
    if (index + 1 < pages.length) options.push(next);
    const value = await select(
      ctx,
      pages.length > 1 ? `${title} (${index + 1}/${pages.length})` : title,
      options,
      {
        ...config,
        selected: pages[index].includes(config.selected ?? '')
          ? config.selected
          : undefined,
        searchable: true,
      },
    );
    if (value === undefined) return undefined;
    if (value === previous) index--;
    else if (value === next) index++;
    else return value;
  }
  return undefined;
}

async function availableModels(ctx: SettingsCommandContext): Promise<Model[]> {
  if (stopped(ctx)) return [];
  // Re-read models.json and cached catalogs, without initiating a network refresh.
  const result = await ctx.session.modelRuntime.refresh({
    allowNetwork: false,
    signal: ctx.signal,
  });
  if (stopped(ctx)) return [];
  const error = ctx.session.modelRuntime.getError();
  const errors = [...result.errors.values()].map(error => error.message);
  if (error) errors.push(error);
  if (errors.length) ctx.ui.context.notify(errors.join('\n'), 'warning');
  const models = [...ctx.session.modelRuntime.getAvailableSnapshot()];
  return [...new Map(models.map(model => [reference(model), model])).values()];
}

async function pickModel(
  ctx: SettingsCommandContext,
  models: Model[],
  title: string,
  label: (model: Model) => string = reference,
): Promise<Model | undefined> {
  if (stopped(ctx)) return undefined;
  if (!models.length) {
    await ctx.ui.show(
      title,
      'No authenticated chat models are available. Use /login to configure a provider.',
    );
    return undefined;
  }
  const current = ctx.session.model;
  const provider = await pagedSelect(
    ctx,
    `${title}: provider`,
    [...new Set(models.map(model => model.provider))].sort(),
    {
      selected: current?.provider,
      message: 'Choose a provider, then search its models.',
    },
  );
  if (provider === undefined) return undefined;
  const candidates = models
    .filter(model => model.provider === provider)
    .sort((a, b) => a.id.localeCompare(b.id));
  const labels = candidates.map(label);
  const selected = await pagedSelect(ctx, title, labels, {
    selected:
      current &&
      candidates.some(model => reference(model) === reference(current))
        ? label(
            candidates.find(model => reference(model) === reference(current))!,
          )
        : undefined,
    message:
      'Changes affect this session only; startup model defaults are unchanged.',
  });
  return selected === undefined
    ? undefined
    : candidates[labels.indexOf(selected)];
}

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

async function scopedModelsCommand(ctx: SettingsCommandContext): Promise<void> {
  const available = await availableModels(ctx);
  if (stopped(ctx)) return;
  const originals = ctx.session.scopedModels;
  const patterns = ctx.session.settingsManager.getEnabledModels();
  const resolved = patterns?.length
    ? await resolveModelScopeWithDiagnostics(
        patterns,
        ctx.session.modelRuntime,
        {signal: ctx.signal},
      )
    : undefined;
  if (stopped(ctx)) return;
  const configured = originals.length
    ? [...originals]
    : (resolved?.scopedModels ?? []);
  let unavailablePatterns =
    resolved?.diagnostics
      .filter(diagnostic => diagnostic.code === 'no-match')
      .map(diagnostic => diagnostic.pattern) ?? [];
  if (resolved?.diagnostics.length)
    ctx.ui.context.notify(
      resolved.diagnostics.map(diagnostic => diagnostic.message).join('\n'),
      'warning',
    );
  const known = new Map<string, ScopedModel>(
    configured.map(scoped => [reference(scoped.model), scoped]),
  );
  // Keep temporarily unavailable scoped entries rather than silently dropping them.
  const models = [
    ...new Map(
      [...available, ...configured.map(scoped => scoped.model)].map(model => [
        reference(model),
        model,
      ]),
    ).values(),
  ];
  let enabled: Set<string> | null = new Set(
    configured.map(scoped => reference(scoped.model)),
  );
  let dirty = false;
  while (!stopped(ctx)) {
    const action = await select(
      ctx,
      'Scoped models',
      [
        'Toggle a model',
        'Enable all models',
        'Enable only current model',
        'Apply to this session',
        'Apply and save to Pi settings',
        'Cancel',
      ],
      {
        message: `${enabled === null ? 'All available models' : `${enabled.size} models`} selected${unavailablePatterns.length ? `, plus ${unavailablePatterns.length} unavailable saved patterns` : ''}. Edits are a draft until Apply. Save writes Pi enabledModels (not worker permissions).`,
      },
    );
    if (action === undefined || action === 'Cancel') return;
    if (action === 'Toggle a model') {
      const model = await pickModel(
        ctx,
        models,
        'Toggle scoped model',
        model =>
          `${enabled === null || enabled.has(reference(model)) ? '[✓]' : '[ ]'} ${reference(model)}`,
      );
      if (stopped(ctx)) return;
      if (!model) continue;
      enabled ??= new Set(models.map(reference));
      const id = reference(model);
      if (!enabled.delete(id)) enabled.add(id);
      dirty = true;
    } else if (action === 'Enable all models') {
      enabled = null;
      unavailablePatterns = [];
      dirty = true;
    } else if (action === 'Enable only current model') {
      if (!ctx.session.model)
        throw new Error('Select a current model first with /model.');
      const model = ctx.session.model;
      if (!models.some(candidate => reference(candidate) === reference(model)))
        models.push(model);
      enabled = new Set([reference(model)]);
      unavailablePatterns = [];
      dirty = true;
    } else {
      if (stopped(ctx)) return;
      if (enabled?.size === 0 && !unavailablePatterns.length)
        throw new Error(
          'Select at least one model, or choose Enable all models. Pi treats an empty scope as all models.',
        );
      const selectedIds = enabled;
      const allEnabled = selectedIds === null;
      const scoped = allEnabled
        ? []
        : models
            .filter(model => selectedIds?.has(reference(model)))
            .map(model => ({...known.get(reference(model)), model}));
      if (action === 'Apply and save to Pi settings') {
        // Preserve patterns when they still describe the session's scope.
        const matchesSavedScope =
          resolved?.scopedModels.length === configured.length &&
          configured.every((scoped, index) => {
            const saved = resolved!.scopedModels[index];
            return (
              reference(scoped.model) === reference(saved.model) &&
              scoped.thinkingLevel === saved.thinkingLevel
            );
          });
        const saved =
          !dirty && patterns?.length && matchesSavedScope
            ? patterns
            : allEnabled
              ? undefined
              : [
                  ...[...selectedIds!].map(id => {
                    const thinkingLevel = known.get(id)?.thinkingLevel;
                    return thinkingLevel ? `${id}:${thinkingLevel}` : id;
                  }),
                  ...unavailablePatterns,
                ];
        ctx.session.settingsManager.setEnabledModels(
          saved ? [...saved] : undefined,
        );
        await flushSettings(ctx);
      }
      if (stopped(ctx)) return;
      ctx.session.setScopedModels(scoped);
      await ctx.configure({});
      return;
    }
  }
}

interface SettingAction {
  label: string;
  run(): Promise<void>;
}

function setting<T extends string | boolean>(
  ctx: SettingsCommandContext,
  title: string,
  current: T,
  values: readonly T[],
  set: (value: T) => void,
  message?: string,
): SettingAction {
  const format = (value: T): string =>
    typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
  return {
    label: `${title}: ${format(current)}`,
    async run() {
      const labels = values.map(format);
      const selected = await select(ctx, title, labels, {
        selected: format(current),
        message,
      });
      if (stopped(ctx) || selected === undefined) return;
      const value = values[labels.indexOf(selected)];
      if (value === current) return;
      set(value);
      await flushSettings(ctx);
      if (!stopped(ctx)) await ctx.configure({});
    },
  };
}

async function settingsCommand(ctx: SettingsCommandContext): Promise<void> {
  const session = ctx.session;
  const settings = session.settingsManager;
  const bool = [true, false];
  while (!stopped(ctx)) {
    const actions: SettingAction[] = [
      {
        label: `Model: ${session.model ? reference(session.model) : 'none'}`,
        run: () => modelCommand(ctx, ''),
      },
      {
        label: `Thinking level: ${session.thinkingLevel}`,
        run: () => thinkingCommand(ctx, ''),
      },
      {label: 'Scoped models', run: () => scopedModelsCommand(ctx)},
      setting(
        ctx,
        'Auto compaction',
        session.autoCompactionEnabled,
        bool,
        value => session.setAutoCompactionEnabled(value),
      ),
      setting(ctx, 'Auto retry', session.autoRetryEnabled, bool, value =>
        session.setAutoRetryEnabled(value),
      ),
      setting(
        ctx,
        'Steering queue',
        session.steeringMode,
        ['all', 'one-at-a-time'],
        value => session.setSteeringMode(value),
      ),
      setting(
        ctx,
        'Follow-up queue',
        session.followUpMode,
        ['all', 'one-at-a-time'],
        value => session.setFollowUpMode(value),
      ),
      setting(
        ctx,
        'Transport',
        settings.getTransport(),
        ['auto', 'sse', 'websocket', 'websocket-cached'],
        value => {
          settings.setTransport(value);
          session.agent.transport = value;
        },
      ),
      setting(
        ctx,
        'Cache warming',
        settings.getCacheWarmingMode(),
        ['off', 'streaming', 'idle'],
        value => session.setCacheWarmingMode(value),
        'Warming can incur provider charges. Idle also warms between runs.',
      ),
      setting(
        ctx,
        'Skill commands',
        settings.getEnableSkillCommands(),
        bool,
        value => settings.setEnableSkillCommands(value),
      ),
      setting(
        ctx,
        'Auto-resize images',
        settings.getImageAutoResize(),
        bool,
        value => settings.setImageAutoResize(value),
      ),
      setting(ctx, 'Block images', settings.getBlockImages(), bool, value =>
        settings.setBlockImages(value),
      ),
      setting(
        ctx,
        'Cache miss notices',
        settings.getShowCacheMissNotices(),
        bool,
        value => settings.setShowCacheMissNotices(value),
      ),
      setting(
        ctx,
        'Session share destination',
        settings.getSessionShareDestination(),
        ['auto', 'gist', 'radius'],
        value => settings.setSessionShareDestination(value),
      ),
      setting(
        ctx,
        'Default project trust',
        settings.getDefaultProjectTrust(),
        ['ask', 'always', 'never'],
        value => settings.setDefaultProjectTrust(value),
        'Global fallback for future projects. This does not sandbox tool execution.',
      ),
      setting(
        ctx,
        'Install telemetry',
        settings.getEnableInstallTelemetry(),
        bool,
        value => settings.setEnableInstallTelemetry(value),
      ),
      {label: 'Project trust', run: () => trustCommand(ctx)},
    ];
    const selected = await select(
      ctx,
      'Session settings',
      actions.map(action => action.label),
      {
        message:
          'Model and thinking selectors can apply to this session or save a default. Other Pi preferences are saved when selected.',
        searchable: true,
      },
    );
    if (selected === undefined) return;
    await actions.find(action => action.label === selected)!.run();
  }
}

async function trustCommand(ctx: SettingsCommandContext): Promise<void> {
  if (stopped(ctx)) return;
  // Pi's parent-folder choice canonicalizes paths and clears a closer child override.
  const {getProjectTrustOptions} = (await import(
    pathToFileURL(join(getPackageDir(), 'dist/core/trust-manager.js')).href
  )) as {
    getProjectTrustOptions(cwd: string): Array<{
      label: string;
      trusted: boolean;
      savedPath?: string;
      updates: Array<{path: string; decision: boolean | null}>;
    }>;
  };
  if (stopped(ctx)) return;
  const cwd = ctx.session.sessionManager.getCwd();
  const store = new ProjectTrustStore(getAgentDir());
  const saved = store.getEntry(cwd);
  const choices = getProjectTrustOptions(cwd);
  const selected = await select(
    ctx,
    'Project trust',
    choices.map(choice => choice.label),
    {
      selected: choices.find(
        choice =>
          choice.savedPath === saved?.path &&
          choice.trusted === saved?.decision,
      )?.label,
      message: `${cwd}\nSaved decision: ${saved ? `${saved.decision ? 'trusted' : 'untrusted'} (${saved.path})` : 'none'}. Current session: ${ctx.session.settingsManager.isProjectTrusted() ? 'trusted' : 'untrusted'}.\nTrust loads project resources; it does not sandbox tools. Saved changes take effect in future Pi processes.`,
    },
  );
  if (stopped(ctx) || selected === undefined) return;
  const choice = choices.find(choice => choice.label === selected)!;
  store.setMany(choice.updates);
  if (!stopped(ctx))
    await ctx.ui.show(
      'Project trust saved',
      `Saved as ${choice.trusted ? 'trusted' : 'untrusted'}. Restart VarisDev for this to take effect. The current session is unchanged.`,
    );
}

/** Native Pi session controls. Errors propagate to the host's command error surface. */
export async function runSettingsCommand(
  name: string,
  args: string,
  ctx: SettingsCommandContext,
): Promise<boolean> {
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
    else if (name === 'scoped-models') await scopedModelsCommand(ctx);
    else await trustCommand(ctx);
  }
  return true;
}
