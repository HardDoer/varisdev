import {
  getPackageDir,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Spacer,
  Text,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DesktopExtensionUI, DesktopNativeFactory} from './extension-ui.ts';

type NativeDone = (result: void) => void;
type NativeTheme = Parameters<DesktopNativeFactory<void>>[1];
type NativeKeybindings = Parameters<DesktopNativeFactory<void>>[2];

interface PiInteractiveContext {
  session: AgentSession;
  ui: TUI;
  keybindings: NativeKeybindings;
  editorContainer: Container;
  editor: Component;
  showStatus(message: string): void;
  showError(message: string): void;
}

interface InteractiveModeAdapter {
  session: AgentSession;
  sessionManager: AgentSession['sessionManager'];
  settingsManager: AgentSession['settingsManager'];
  chatContainer: Container;
  ui: TUI;
  handleSessionCommand(): void;
  handleChangelogCommand(): void;
}

type InteractiveModeConstructor = {
  prototype: InteractiveModeAdapter;
};

const sdkRoot = getPackageDir();
async function internal<T>(relativePath: string): Promise<T> {
  return (await import(
    pathToFileURL(join(sdkRoot, 'dist', relativePath)).href
  )) as T;
}

let interactiveModePromise: Promise<InteractiveModeConstructor> | undefined;
function interactiveMode(): Promise<InteractiveModeConstructor> {
  interactiveModePromise ??= internal<{
    InteractiveMode: InteractiveModeConstructor;
  }>('modes/interactive/interactive-mode.js').then(
    module => module.InteractiveMode,
  );
  return interactiveModePromise;
}

class CloseView extends Container {
  focused = false;
  private readonly message: Text;
  private readonly theme: NativeTheme;
  private readonly done: NativeDone;

  constructor(initialMessage: string, theme: NativeTheme, done: NativeDone) {
    super();
    this.theme = theme;
    this.done = done;
    this.message = new Text(initialMessage, 1, 0);
    this.addChild(this.message);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg('dim', 'Press Enter or Escape to close.'), 1, 0),
    );
  }

  setMessage(message: string, error = false): void {
    this.message.setText(error ? this.theme.fg('error', message) : message);
    this.invalidate();
  }

  handleInput(data: string): void {
    if (data === '\r' || data === '\n' || data === '\x1b' || data === '\x03')
      this.done();
  }
}

class ReadOnlyHost extends Container {
  focused = false;
  private readonly done: NativeDone;

  constructor(output: Container, done: NativeDone) {
    super();
    this.done = done;
    this.addChild(output);
  }

  handleInput(data: string): void {
    if (data === '\r' || data === '\n' || data === '\x1b' || data === '\x03')
      this.done();
  }
}

export function exportSessionToHtmlForTheme(
  session: AgentSession,
  outputPath: Parameters<AgentSession['exportToHtml']>[0],
  owningThemeName: string | undefined,
  options: Parameters<AgentSession['exportToHtml']>[1] = {},
): ReturnType<AgentSession['exportToHtml']> {
  const configured = session.settingsManager.getTheme();
  const themeName =
    owningThemeName && owningThemeName !== '<in-memory>'
      ? owningThemeName
      : configured;
  const next = {...options};
  if (themeName) next.themeName = themeName;
  else delete next.themeName;
  return session.exportToHtml(outputPath, next);
}

function sessionWithExportTheme(
  session: AgentSession,
  theme: NativeTheme,
): AgentSession {
  return new Proxy(session, {
    get(target, property) {
      if (property === 'exportToHtml')
        return (
          outputPath: Parameters<AgentSession['exportToHtml']>[0],
          options: Parameters<AgentSession['exportToHtml']>[1] = {},
        ) =>
          exportSessionToHtmlForTheme(target, outputPath, theme.name, options);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class InteractiveHost extends Container {
  readonly editorContainer = new Container();
  readonly editor: CloseView;
  private disposed = false;
  private settled = false;
  private startTimer?: ReturnType<typeof setTimeout>;
  private readonly screen: TUI;

  constructor(screen: TUI, theme: NativeTheme, done: NativeDone) {
    super();
    this.screen = screen;
    this.editor = new CloseView('Working…', theme, done);
    this.editorContainer.addChild(this.editor);
    this.addChild(this.editorContainer);
  }

  context(
    session: AgentSession,
    theme: NativeTheme,
    keybindings: NativeKeybindings,
  ): PiInteractiveContext {
    return {
      session: sessionWithExportTheme(session, theme),
      ui: this.screen,
      keybindings,
      editorContainer: this.editorContainer,
      editor: this.editor,
      showStatus: message => this.show(message, false),
      showError: message => this.show(message, true),
    };
  }

  show(message: string, error: boolean): void {
    if (this.disposed) return;
    this.settled = true;
    this.editor.setMessage(message, error);
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.screen.setFocus(this.editor);
    this.screen.requestRender(true);
  }

  start(operation: () => Promise<void>): void {
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      if (this.disposed) return;
      void operation()
        .then(() => this.finishWithoutMessage())
        .catch(error =>
          this.show(
            error instanceof Error ? error.message : String(error),
            true,
          ),
        );
    }, 0);
  }

  finishWithoutMessage(): void {
    if (!this.disposed && !this.settled) this.show('Done.', false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    const children = [...this.editorContainer.children];
    for (const child of children) child.handleInput?.('\x1b');
    for (const child of children)
      (child as Component & {dispose?(): void}).dispose?.();
    this.editorContainer.clear();
  }
}

export interface NativeSessionViewContext {
  session: AgentSession;
  ui: Pick<DesktopExtensionUI, 'native'>;
  signal?: AbortSignal;
}

export type PiInteractiveFlow = (
  context: PiInteractiveContext,
  hint?: string,
) => void | Promise<void>;

/** Host a shipped Pi interactive flow inside the desktop terminal transport. */
export async function runPiInteractiveFlow(
  context: NativeSessionViewContext,
  title: string,
  flow: PiInteractiveFlow,
  hint?: string,
): Promise<void> {
  await context.ui.native<void>(
    title,
    (screen, theme, keybindings, done) => {
      const host = new InteractiveHost(screen, theme, done);
      host.start(() =>
        Promise.resolve(
          flow(host.context(context.session, theme, keybindings), hint),
        ),
      );
      return {component: host, focus: host.editor};
    },
    {signal: context.signal},
  );
}

async function showShippedView(
  context: NativeSessionViewContext,
  title: string,
  method: 'handleSessionCommand' | 'handleChangelogCommand',
): Promise<void> {
  const InteractiveMode = await interactiveMode();
  await context.ui.native<void>(
    title,
    (screen, _theme, _keybindings, done) => {
      const output = new Container();
      const adapter = Object.create(
        InteractiveMode.prototype,
      ) as InteractiveModeAdapter;
      for (const [key, value] of Object.entries({
        session: context.session,
        sessionManager: context.session.sessionManager,
        settingsManager: context.session.settingsManager,
        chatContainer: output,
        ui: screen,
      }))
        Object.defineProperty(adapter, key, {
          value,
          configurable: true,
          writable: true,
        });
      adapter[method]();
      const host = new ReadOnlyHost(output, done);
      return {component: host, focus: host};
    },
    {signal: context.signal},
  );
}

/** Render Pi's complete native `/session` output, including cache and cost data. */
export function showSessionView(
  context: NativeSessionViewContext,
): Promise<void> {
  return showShippedView(context, 'Session', 'handleSessionCommand');
}

/** Render Pi's parsed and link-normalized native changelog Markdown. */
export function showChangelogView(
  context: NativeSessionViewContext,
): Promise<void> {
  return showShippedView(context, 'Pi changelog', 'handleChangelogCommand');
}
