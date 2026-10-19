import {
  getAgentDir,
  getPackageDir,
  ProjectTrustStore,
  type AgentSession,
  type resolveModelScopeWithDiagnostics,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DesktopNativeFactory} from './extension-ui.ts';
import type {SettingsCommandContext} from './settings-commands.ts';

type Model = NonNullable<AgentSession['model']>;
type NativeComponent = Exclude<
  Awaited<ReturnType<DesktopNativeFactory<void>>>,
  {component: unknown}
>;
type ScopeResult = Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>;
type TrustSelection = {
  trusted: boolean;
  updates: Parameters<ProjectTrustStore['setMany']>[0];
};

async function internal<T>(path: string): Promise<T> {
  return (await import(
    pathToFileURL(join(getPackageDir(), 'dist', path)).href
  )) as T;
}

// These components are shipped by Pi but are absent from its root exports.
const {ScopedModelsSelectorComponent} = await internal<{
  ScopedModelsSelectorComponent: new (
    config: {
      allModels: Model[];
      enabledModelIds: string[] | null;
      refreshStatus?: string;
    },
    callbacks: {
      onChange(ids: string[] | null): void;
      onPersist(ids: string[] | null): void;
      onCancel(): void;
    },
  ) => NativeComponent & {
    focused: boolean;
    updateModels(models: readonly Model[], ids?: string[] | null): void;
    setRefreshStatus(
      message: string,
      kind: 'muted' | 'success' | 'warning',
    ): void;
  };
}>('modes/interactive/components/scoped-models-selector.js');
const {TrustSelectorComponent} = await internal<{
  TrustSelectorComponent: new (options: {
    cwd: string;
    savedDecision: ReturnType<ProjectTrustStore['getEntry']>;
    projectTrusted: boolean;
    onSelect(selection: TrustSelection): void;
    onCancel(): void;
  }) => NativeComponent;
}>('modes/interactive/components/trust-selector.js');
const {resolveModelScopeFromModels} = await internal<{
  resolveModelScopeFromModels(
    patterns: string[],
    models: readonly Model[],
  ): ScopeResult;
}>('core/model-resolver.js');
const {refreshModelCatalogs} = await internal<{
  refreshModelCatalogs(
    runtime: AgentSession['modelRuntime'],
    signal: AbortSignal,
  ): ReturnType<AgentSession['modelRuntime']['refresh']>;
}>('modes/interactive/model-catalog-refresh.js');

const reference = (model: Model) => `${model.provider}/${model.id}`;

/** Host Pi's live model ordering, toggles, search and save shortcut. */
export async function runScopedModelsSettings(
  ctx: SettingsCommandContext,
): Promise<void> {
  if (ctx.signal?.aborted) return;
  const {session} = ctx;
  let available = [...session.modelRuntime.getAvailableSnapshot()];
  let availableIds = new Set(available.map(reference));
  const patterns = session.settingsManager.getEnabledModels();
  const initialScope = session.scopedModels;
  const configuredIds = () => {
    if (!patterns?.length) return null;
    const result = resolveModelScopeFromModels(patterns, available);
    const ids = result.scopedModels.map(item => reference(item.model));
    for (const diagnostic of result.diagnostics)
      if (diagnostic.code === 'no-match' && !ids.includes(diagnostic.pattern))
        ids.push(diagnostic.pattern);
    return ids;
  };
  let enabled = initialScope.length
    ? initialScope.map(item => reference(item.model))
    : configuredIds();
  let changed = false;
  let disposed = false;
  let timedOut = false;
  let pending = Promise.resolve();
  let failure: unknown;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);
  const dispose = () => {
    disposed = true;
    clearTimeout(timeout);
    controller.abort();
  };
  const updateScope = (ids: string[] | null) => {
    enabled = ids === null ? null : [...ids];
    const hasAvailable = ids?.some(id => availableIds.has(id)) ?? false;
    const allAvailable =
      ids !== null && [...availableIds].every(id => ids.includes(id));
    session.setScopedModels(
      ids && hasAvailable && !allAvailable
        ? resolveModelScopeFromModels(ids, available).scopedModels
        : [],
    );
  };
  try {
    await ctx.ui.native<void>(
      'Scoped models',
      (screen, _theme, _keys, done) => {
        const apply = (operation: () => Promise<void>) => {
          pending = pending
            .then(async () => {
              if (!ctx.signal?.aborted) await operation();
            })
            .catch(error => {
              failure = error;
              done();
            });
        };
        const selector = new ScopedModelsSelectorComponent(
          {
            allModels: available,
            enabledModelIds: enabled,
            refreshStatus: 'Refreshing model catalogs…',
          },
          {
            onChange(ids) {
              if (disposed || ctx.signal?.aborted) return;
              changed = true;
              updateScope(ids);
              apply(() => ctx.configure({}));
            },
            onPersist(ids) {
              if (disposed || ctx.signal?.aborted) return;
              const all =
                ids !== null &&
                ids.length === available.length &&
                ids.every(id => availableIds.has(id));
              session.settingsManager.setEnabledModels(
                ids === null || all ? undefined : [...ids],
              );
              apply(async () => {
                await session.settingsManager.flush();
                const errors = session.settingsManager.drainErrors();
                if (errors.length)
                  throw new Error(
                    errors
                      .map(
                        item => `${item.scope} settings: ${item.error.message}`,
                      )
                      .join('\n'),
                  );
                if (!ctx.signal?.aborted)
                  ctx.ui.context.notify(
                    'Model selection saved to settings',
                    'info',
                  );
              });
            },
            onCancel: () => done(),
          },
        );
        void refreshModelCatalogs(session.modelRuntime, controller.signal)
          .then(result => {
            if (disposed || ctx.signal?.aborted) return;
            available = [...session.modelRuntime.getAvailableSnapshot()];
            availableIds = new Set(available.map(reference));
            if (!changed && initialScope.length === 0) {
              enabled = configuredIds();
              selector.updateModels(available, enabled);
            } else selector.updateModels(available);
            if (enabled !== null) {
              updateScope(enabled);
              apply(() => ctx.configure({}));
            }
            selector.setRefreshStatus(
              result.aborted && timedOut
                ? 'Model refresh timed out; showing cached models.'
                : result.errors.size
                  ? `Could not refresh ${[...result.errors.keys()].join(', ')}; showing cached models.`
                  : 'Model catalogs refreshed.',
              result.aborted || result.errors.size ? 'warning' : 'success',
            );
            screen.requestRender();
          })
          .catch(error => {
            if (disposed || ctx.signal?.aborted) return;
            selector.setRefreshStatus(
              timedOut
                ? 'Model refresh timed out; showing cached models.'
                : `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
              'warning',
            );
            screen.requestRender();
          })
          .finally(() => clearTimeout(timeout));
        return {
          component: {
            render: width => selector.render(width),
            invalidate: () => selector.invalidate(),
            handleMouse: event => selector.handleMouse?.(event),
            dispose,
          },
          focus: selector,
        };
      },
      {signal: ctx.signal},
    );
  } finally {
    dispose();
    await pending;
  }
  if (failure !== undefined) throw failure;
}

/** Let Pi produce and render its trust choices, then persist its selected updates. */
export async function runTrustSettings(
  ctx: SettingsCommandContext,
): Promise<void> {
  if (ctx.signal?.aborted) return;
  const cwd = ctx.session.sessionManager.getCwd();
  const store = new ProjectTrustStore(getAgentDir());
  const savedDecision = store.getEntry(cwd);
  const selection = await ctx.ui.native<TrustSelection | undefined>(
    'Project trust',
    (_screen, _theme, _keys, done) =>
      new TrustSelectorComponent({
        cwd,
        savedDecision,
        projectTrusted: ctx.session.settingsManager.isProjectTrusted(),
        onSelect: done,
        onCancel: () => done(undefined),
      }),
    {signal: ctx.signal},
  );
  if (!selection || ctx.signal?.aborted) return;
  store.setMany(selection.updates);
  ctx.ui.context.notify(
    `Saved trust decision: ${selection.trusted ? 'trusted' : 'untrusted'}. Restart VarisDev for this to take effect.`,
    'info',
  );
}
