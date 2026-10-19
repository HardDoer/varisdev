import {
  InteractiveMode,
  LoginDialogComponent,
} from '@earendil-works/pi-coding-agent';
import type {DesktopNativeFactory} from './extension-ui.ts';
import type {SettingsCommandContext} from './settings-commands.ts';

type Component = Exclude<
  Awaited<ReturnType<DesktopNativeFactory<void>>>,
  {component: unknown}
>;
type SelectorFactory = (done: () => void) => {
  component: Component;
  focus: Component;
  dispose?: () => void;
};
interface AuthHost {
  handleLoginCommand(provider?: string): Promise<void>;
  showOAuthSelector(mode: 'logout'): Promise<void>;
  showSelector(create: SelectorFactory): void;
  disposeActiveSelector(): void;
}

/** Host Pi's auth command flow without starting its interactive application. */
export async function runAuthCommand(
  name: string,
  args: string,
  ctx: SettingsCommandContext,
): Promise<boolean> {
  if (name !== 'login' && name !== 'logout') return false;
  if (ctx.signal?.aborted) return true;
  if (name === 'logout' && args.trim()) throw new Error('Usage: /logout');
  let failure: unknown;
  await ctx.ui.native<void>(
    name === 'login' ? 'Login' : 'Logout',
    (screen, _theme, _keys, done) => {
      // Provider choices, authentication submenus and callbacks stay in Pi.
      const host = Object.create(InteractiveMode.prototype) as AuthHost;
      if (
        typeof host.handleLoginCommand !== 'function' ||
        typeof host.showOAuthSelector !== 'function'
      )
        throw new Error(
          'This Pi version does not expose its native auth command handlers.',
        );
      const lifetime = new AbortController();
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, lifetime.signal])
        : lifetime.signal;
      const editor: Component = {render: () => [], invalidate() {}};
      let current: Component = editor;
      let last: Component = editor;
      let focus: Component = editor;
      let pending = 0;
      let disposed = false;
      let completion: ReturnType<typeof setTimeout> | undefined;
      const dialogs = new Set<LoginDialogComponent>();
      const schedule = () => {
        clearTimeout(completion);
        if (disposed) return;
        completion = setTimeout(() => {
          if (!disposed && pending === 0 && current === editor) done();
        }, 0);
      };
      const track = <T>(operation: Promise<T>): Promise<T> => {
        pending++;
        return operation.finally(() => {
          pending--;
          schedule();
        });
      };
      const runtime = new Proxy(ctx.session.modelRuntime, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          const index = key === 'login' ? 2 : key === 'logout' ? 1 : 0;
          if (
            key !== 'login' &&
            key !== 'logout' &&
            key !== 'listCredentials' &&
            key !== 'refresh'
          )
            return value.bind(target);
          return (...parameters: unknown[]) => {
            const options = (parameters[index] ?? {}) as {signal?: AbortSignal};
            parameters[index] = {
              ...options,
              signal: options.signal
                ? AbortSignal.any([signal, options.signal])
                : signal,
            };
            return track(
              Promise.resolve().then(() => value.apply(target, parameters)),
            );
          };
        },
      });
      const session = new Proxy(ctx.session, {
        get(target, key) {
          if (key === 'modelRuntime') return runtime;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const notify = (message: string, kind: 'info' | 'warning' | 'error') => {
        if (!disposed) ctx.ui.context.notify(message, kind);
        schedule();
      };
      const ui = new Proxy(screen, {
        get(target, key) {
          if (key === 'setFocus')
            return (component: Component) => {
              focus = component;
              (focus as Component & {focused?: boolean}).focused = true;
              screen.requestRender();
              schedule();
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      Object.assign(host, {
        runtimeHost: {session},
        ui,
        editor,
        editorContainer: {
          clear() {},
          addChild(component: Component) {
            if (disposed) return;
            current = component;
            if (component !== editor) last = component;
            if (component instanceof LoginDialogComponent)
              dialogs.add(component);
            schedule();
          },
        },
        programStatus: {setBlocked() {}},
        footer: {invalidate() {}},
        footerDataProvider: {setAvailableProviderCount() {}},
        updateEditorBorderColor() {},
        showStatus: (message: string) => notify(message, 'info'),
        showWarning: (message: string) => notify(message, 'warning'),
        showError: (message: string) => notify(message, 'error'),
        handleReloadCommand: () => track(ctx.session.reload()),
      });
      const showSelector = host.showSelector;
      host.showSelector = create => {
        if (!disposed) showSelector.call(host, create);
      };
      const component: Component & {dispose(): void; focused: boolean} = {
        get focused() {
          return (focus as Component & {focused?: boolean}).focused ?? false;
        },
        set focused(value: boolean) {
          (focus as Component & {focused?: boolean}).focused = value;
        },
        render: width => (current === editor ? last : current).render(width),
        invalidate: () => current.invalidate(),
        handleInput(data) {
          focus.handleInput?.(data);
          schedule();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          clearTimeout(completion);
          lifetime.abort();
          host.disposeActiveSelector();
          for (const dialog of dialogs)
            if (!dialog.signal.aborted) dialog.handleInput('\x1b');
        },
      };
      void track(
        name === 'login'
          ? host.handleLoginCommand(args.trim() || undefined)
          : host.showOAuthSelector('logout'),
      ).catch(error => {
        if (disposed) return;
        failure = error;
        done();
      });
      return component;
    },
    {signal: ctx.signal},
  );
  if (failure) throw failure;
  if (!ctx.signal?.aborted) await ctx.configure({});
  return true;
}
