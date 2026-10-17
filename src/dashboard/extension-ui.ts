import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {
  ModelSelectorComponent,
  ThinkingSelectorComponent,
  initTheme,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from '@earendil-works/pi-coding-agent';

// The SDK exports Theme at its root, but its theme discovery helpers only live
// in this module. Resolve from the package entry so desktop builds work too.
const themes = (await import(
  new URL(
    './modes/interactive/theme/theme.js',
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  ).href
)) as {
  getThemeByName(name: string): Theme | undefined;
  getAvailableThemesWithPaths(): Array<{
    name: string;
    path: string | undefined;
  }>;
};

type TerminalTUI = Parameters<Parameters<ExtensionUIContext['custom']>[0]>[0];
type TerminalComponent = Awaited<
  ReturnType<Parameters<ExtensionUIContext['custom']>[0]>
>;
type CustomFactory<T> = (
  tui: TerminalTUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void,
) => TerminalComponent | Promise<TerminalComponent>;
type CustomOptions = Parameters<ExtensionUIContext['custom']>[1];
type EditorFactory = NonNullable<
  Parameters<ExtensionUIContext['setEditorComponent']>[0]
>;
type EditorComponent = ReturnType<EditorFactory> & {dispose?(): void};
type EditorTheme = Parameters<EditorFactory>[1];
type AutocompleteFactory = Parameters<
  ExtensionUIContext['addAutocompleteProvider']
>[0];
type AutocompleteProvider = Parameters<AutocompleteFactory>[0];

const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
const tui = (await import(
  pathToFileURL(createRequire(sdkEntry).resolve('@earendil-works/pi-tui')).href
)) as {
  TuiAltScreen: new (
    terminal: VirtualTerminal,
    hardwareCursor?: boolean,
  ) => TerminalTUI;
  StdinBuffer: new () => {
    on(event: 'data' | 'paste', callback: (data: string) => void): void;
    process(data: string): void;
    destroy(): void;
  };
  stripTerminalSequences(text: string): string;
  getKeybindings(): unknown;
  setKeybindings(keys: unknown): void;
  Editor: new (screen: TerminalTUI, theme: EditorTheme) => EditorComponent;
  CombinedAutocompleteProvider: new (
    commands: Array<{name: string; description?: string}>,
    cwd: string,
    fdPath?: string | null,
  ) => AutocompleteProvider;
};
const keybindingsModule = (await import(
  new URL('./core/keybindings.js', sdkEntry).href
)) as {
  KeybindingsManager: {create(): KeybindingsManager};
};

export interface DesktopTerminalState {
  columns: number;
  rows: number;
  output: string;
  revision: number;
}

type ModelSelectorArguments = ConstructorParameters<
  typeof ModelSelectorComponent
>;
type ThinkingSelectorArguments = ConstructorParameters<
  typeof ThinkingSelectorComponent
>;

export interface DesktopModelSelectorOptions {
  currentModel: ModelSelectorArguments[1];
  modelRuntime: ModelSelectorArguments[2];
  scopedModels: ModelSelectorArguments[3];
  defaultModel?: ModelSelectorArguments[8];
  initialSearch?: string;
}

export interface DesktopThinkingSelectorOptions {
  currentLevel: ThinkingSelectorArguments[0];
  availableLevels: ThinkingSelectorArguments[1];
  defaultLevel?: ThinkingSelectorArguments[5];
}

export interface DesktopSessionSettingsOptions {
  model: DesktopModelSelectorOptions;
  thinking: DesktopThinkingSelectorOptions;
  activeTab: 'model' | 'thinking';
}

type SessionSettingsSelection =
  | {
      kind: 'model';
      model: NonNullable<ModelSelectorArguments[1]>;
      persist: boolean;
    }
  | {
      kind: 'thinking';
      thinkingLevel: ThinkingSelectorArguments[0];
      persist: boolean;
    }
  | undefined;

export interface DesktopUIDialogAction {
  action: string;
}

export interface DesktopUIDialog {
  id: string;
  kind: 'select' | 'confirm' | 'input' | 'editor' | 'terminal' | 'info';
  title: string;
  options?: string[];
  selected?: string;
  searchable?: boolean;
  message?: string;
  placeholder?: string;
  prefill?: string;
  terminal?: DesktopTerminalState;
  actions?: Array<{id: string; label: string}>;
  tabs?: Array<{id: string; label: string}>;
  activeTab?: string;
}

export interface DesktopUIState {
  dialogs: DesktopUIDialog[];
  notifications: Array<{
    id: string;
    message: string;
    type: 'info' | 'warning' | 'error';
  }>;
  statuses: Array<{key: string; text: string}>;
  editor?: {id: string; text: string};
  extensionEditor?: {id: string};
  navigation?: {id: string; cwd: string; sessionId: string; draft?: string};
}

/** The SDK editor lacks dialog options; desktop also supports cancellation. */
export interface DesktopExtensionUIContext extends ExtensionUIContext {
  editor(
    title: string,
    prefill?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
}

type DialogValue = string | boolean | undefined;
interface PendingDialog {
  dialog: DesktopUIDialog;
  finish(value: unknown): void;
  activate?(): void;
  input?(data: string): void;
  onAction?(action: string): void;
}

interface CustomDialogControls {
  actions?: DesktopUIDialog['actions'];
  tabs?: DesktopUIDialog['tabs'];
  activeTab?: string;
  onTab?(tab: string): void;
  onAction?(action: string): void;
  signal?: AbortSignal;
}

const MAX_DIALOGS = 32;
const MAX_NOTIFICATIONS = 100;
const MAX_STATUSES = 100;
const MAX_TEXT = 16384;
const MAX_EDITOR_TEXT = 262144;
const MAX_OPTIONS = 256;
const MAX_TERMINAL_OUTPUT = 262144;

/** Real Pi renderer transport with buffered keys and a bounded ANSI history. */
class VirtualTerminal {
  readonly columns = 100;
  readonly rows = 28;
  readonly kittyProtocolActive = false;
  readonly state: DesktopTerminalState = {
    columns: 100,
    rows: 28,
    output: '',
    revision: 0,
  };
  private inputBuffer?: InstanceType<typeof tui.StdinBuffer>;
  private render?: TerminalTUI;
  private change?: ReturnType<typeof setImmediate>;
  private reset?: ReturnType<typeof setImmediate>;
  private stopped = false;

  constructor(
    privateChanged: () => void,
    privateFailed: (error: Error) => void,
    privateFilter: (data: string) => string | undefined,
    capture = true,
    dispatch: (operation: () => void) => void = operation => operation(),
  ) {
    this.changed = privateChanged;
    this.failed = privateFailed;
    this.filter = privateFilter;
    this.capture = capture;
    this.dispatch = dispatch;
  }
  private readonly changed: () => void;
  private readonly failed: (error: Error) => void;
  private readonly filter: (data: string) => string | undefined;
  private readonly capture: boolean;
  private readonly dispatch: (operation: () => void) => void;

  attach(render: TerminalTUI): void {
    this.render = render;
  }
  start(onInput: (data: string) => void): void {
    this.stopped = false;
    this.inputBuffer = new tui.StdinBuffer();
    const receive = (data: string) => {
      try {
        this.dispatch(() => {
          const filtered = this.filter(data);
          if (filtered !== undefined) onInput(filtered);
        });
      } catch (error) {
        this.failed(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.inputBuffer.on('data', receive);
    this.inputBuffer.on('paste', data => receive(`\x1b[200~${data}\x1b[201~`));
    this.write('\x1b[?2004h');
  }
  input(data: string): void {
    this.inputBuffer?.process(data);
  }
  stop(): void {
    this.stopped = true;
    this.inputBuffer?.destroy();
    this.inputBuffer = undefined;
    if (this.change) clearImmediate(this.change);
    if (this.reset) clearImmediate(this.reset);
    this.change = undefined;
    this.reset = undefined;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    if (this.stopped || !this.capture) return;
    if (data.length > MAX_TERMINAL_OUTPUT) {
      this.failed(
        new Error(
          'A terminal UI frame exceeds the desktop 256 KiB output limit.',
        ),
      );
      return;
    }
    if (this.state.output.length + data.length > MAX_TERMINAL_OUTPUT) {
      if (!this.reset)
        this.reset = setImmediate(() => {
          this.reset = undefined;
          if (this.stopped) return;
          this.state.output = '\x1bc\x1b[?1049h\x1b[?7l\x1b[?2004h';
          this.state.revision++;
          this.render?.requestRender(true);
          this.scheduleChange();
        });
      return;
    }
    // A reset replaces all writes from the previous screen transaction.
    if (this.reset) return;
    this.state.output += data;
    this.state.revision++;
    this.scheduleChange();
  }
  private scheduleChange(): void {
    if (!this.change)
      this.change = setImmediate(() => {
        this.change = undefined;
        if (!this.stopped && !this.reset) this.changed();
      });
  }
  moveBy(lines: number): void {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`);
  }
  hideCursor(): void {
    this.write('\x1b[?25l');
  }
  showCursor(): void {
    this.write('\x1b[?25h');
  }
  clearLine(): void {
    this.write('\x1b[2K');
  }
  clearFromCursor(): void {
    this.write('\x1b[J');
  }
  clearScreen(): void {
    this.write('\x1b[2J\x1b[H');
  }
  setTitle(title: string): void {
    this.write(`\x1b]2;${bounded(title)}\x07`);
  }
  setProgress(): void {}
}

function bounded(text: string, limit = MAX_TEXT): string {
  return text.length > limit
    ? `${text.slice(0, limit - 12)}\n[truncated]`
    : text;
}

/** Native dialogs and durable display state for extension UI requests. */
export class DesktopExtensionUI {
  readonly context: DesktopExtensionUIContext;
  private pending: PendingDialog[] = [];
  private notifications: DesktopUIState['notifications'] = [];
  private statuses = new Map<string, string>();
  private widgets = new Map<string, string>();
  private editorState: DesktopUIState['editor'];
  private navigation: DesktopUIState['navigation'];
  private editorText = '';
  private toolsExpanded = false;
  private currentTheme: Theme;
  private disposed = false;
  private readonly onChange: () => void;
  private readonly keybindings = keybindingsModule.KeybindingsManager.create();
  private cancelling = false;
  private editorFactory?: EditorFactory;
  private autocompleteFactories: AutocompleteFactory[] = [];
  private baseAutocomplete: AutocompleteProvider =
    new tui.CombinedAutocompleteProvider([], process.cwd(), null);
  private extensionEditorId?: string;
  private extensionEditorOpen = false;
  private extensionGeneration = 0;
  private viewTUI?: TerminalTUI;
  private views = new Map<
    string,
    {component: TerminalComponent; wrapper: TerminalComponent}
  >();
  private terminalListeners = new Set<
    Parameters<ExtensionUIContext['onTerminalInput']>[0]
  >();
  private footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(this.statuses),
    getAvailableProviderCount: () => 0,
    onBranchChange: () => () => {},
  };

  constructor(onChange: () => void) {
    this.onChange = onChange;
    initTheme('dark');
    const theme = themes.getThemeByName('dark');
    if (!theme) throw new Error('The SDK dark theme is unavailable.');
    this.currentTheme = theme;
    const getCurrentTheme = () => this.currentTheme;
    this.context = {
      select: (title, options, opts) =>
        this.open(
          {kind: 'select', title, options: [...options]},
          opts,
        ) as Promise<string | undefined>,
      confirm: (title, message, opts) =>
        this.open({kind: 'confirm', title, message}, opts) as Promise<boolean>,
      input: (title, placeholder, opts) =>
        this.open({kind: 'input', title, placeholder}, opts) as Promise<
          string | undefined
        >,
      editor: (title, prefill, opts) =>
        this.open({kind: 'editor', title, prefill}, opts) as Promise<
          string | undefined
        >,
      notify: (message, type = 'info') => this.notify(message, type),
      setStatus: (key, text) => this.setStatus(key, text),
      setWidget: (key, content) => {
        const viewKey = `widget:${key}`;
        if (typeof content === 'function') this.setView(viewKey, content);
        else {
          this.removeView(viewKey);
          this.setStatus(viewKey, content?.join('\n'), this.widgets);
        }
      },
      setTitle: title => this.setStatus('ui:title', title),
      setWorkingMessage: message => this.setStatus('ui:working', message),
      setWorkingVisible: visible =>
        this.setStatus('ui:workingVisible', visible ? 'visible' : 'hidden'),
      setWorkingIndicator: options =>
        this.setStatus(
          'ui:workingIndicator',
          options
            ? `${bounded(options.frames?.join(' ') ?? '')} (${options.intervalMs ?? 80} ms)`
            : undefined,
        ),
      setHiddenThinkingLabel: label =>
        this.setStatus('ui:hiddenThinking', label),
      setEditorText: text => this.setEditorText(text),
      pasteToEditor: text => this.setEditorText(this.editorText + text),
      getEditorText: () => this.editorText,
      custom: <T>(factory: CustomFactory<T>, options?: CustomOptions) =>
        this.openCustom(factory, options),
      addAutocompleteProvider: factory => {
        if (this.disposed) return;
        if (this.autocompleteFactories.length >= 32)
          throw new Error(
            'Desktop extension autocomplete provider limit reached.',
          );
        this.autocompleteFactories.push(factory);
        this.updateExtensionEditor();
      },
      setEditorComponent: factory => {
        if (this.disposed) return;
        this.editorFactory = factory;
        this.updateExtensionEditor();
      },
      getEditorComponent: () => this.editorFactory,
      setHeader: factory => this.setView('ui:header', factory),
      setFooter: factory =>
        this.setView(
          'ui:footer',
          factory && ((tui, theme) => factory(tui, theme, this.footerData)),
        ),
      onTerminalInput: handler => {
        if (this.disposed) return () => {};
        if (this.terminalListeners.size >= 100)
          throw new Error('Desktop terminal input listener limit reached.');
        this.terminalListeners.add(handler);
        return () => {
          this.terminalListeners.delete(handler);
        };
      },
      get theme() {
        return getCurrentTheme();
      },
      getAllThemes: () =>
        themes.getAvailableThemesWithPaths().map(item => ({...item})),
      getTheme: name => this.getTheme(name),
      setTheme: requested => {
        if (this.disposed)
          return {success: false, error: 'The desktop session has closed.'};
        const next =
          typeof requested === 'string' ? this.getTheme(requested) : requested;
        if (!next)
          return {success: false, error: `Theme not found: ${requested}`};
        this.currentTheme = next;
        this.setStatus('ui:theme', next.name ?? 'custom');
        return {success: true};
      },
      getToolsExpanded: () => this.toolsExpanded,
      setToolsExpanded: expanded => {
        if (this.disposed) return;
        this.toolsExpanded = expanded;
        this.setStatus('ui:toolsExpanded', expanded ? 'expanded' : 'collapsed');
      },
    };
  }

  /** Scope command interactions to Stop/close without changing extension-owned UI. */
  forCommand(signal: AbortSignal): DesktopExtensionUI {
    const options = (opts?: ExtensionUIDialogOptions) => ({
      ...opts,
      signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal,
    });
    const context = {
      ...this.context,
      select: (
        title: string,
        choices: string[],
        opts?: ExtensionUIDialogOptions,
      ) => this.context.select(title, choices, options(opts)),
      confirm: (
        title: string,
        message: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.context.confirm(title, message, options(opts)),
      input: (
        title: string,
        placeholder?: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.context.input(title, placeholder, options(opts)),
      editor: (
        title: string,
        prefill?: string,
        opts?: ExtensionUIDialogOptions,
      ) => this.context.editor(title, prefill, options(opts)),
      notify: (...args: Parameters<ExtensionUIContext['notify']>) => {
        if (!signal.aborted) this.context.notify(...args);
      },
      setEditorText: (text: string) => {
        if (!signal.aborted) this.context.setEditorText(text);
      },
    };
    return new Proxy(this, {
      get: (target, key) => {
        if (key === 'context') return context;
        if (key === 'selectSessionSettings')
          return (options: DesktopSessionSettingsOptions) =>
            this.openSessionSettings(options, signal);
        if (key === 'selectModel')
          return (options: DesktopModelSelectorOptions) =>
            this.openModelSelector(options, signal);
        if (key === 'selectThinking')
          return (options: DesktopThinkingSelectorOptions) =>
            this.openThinkingSelector(options, signal);
        if (key === 'select')
          return (title: string, choices: string[], presentation = {}) =>
            this.open(
              {kind: 'select', title, options: [...choices], ...presentation},
              {signal},
              true,
            );
        if (key === 'show')
          return async (title: string, message: string) => {
            await this.open(
              {kind: 'info', title, message: bounded(message, MAX_EDITOR_TEXT)},
              {signal},
              true,
            );
          };
        if (key === 'navigate')
          return (...args: Parameters<DesktopExtensionUI['navigate']>) => {
            if (!signal.aborted) this.navigate(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** Native command dialogs share the extension transport, not terminal components. */
  select(
    title: string,
    options: string[],
    presentation: {
      selected?: string;
      message?: string;
      searchable?: boolean;
    } = {},
  ): Promise<string | undefined> {
    return this.open(
      {kind: 'select', title, options: [...options], ...presentation},
      undefined,
      true,
    ) as Promise<string | undefined>;
  }

  selectSessionSettings(options: DesktopSessionSettingsOptions) {
    return this.openSessionSettings(options);
  }

  private openSessionSettings(
    options: DesktopSessionSettingsOptions,
    signal?: AbortSignal,
  ): Promise<SessionSettingsSelection> {
    let switchTab: ((tab: string) => void) | undefined;
    let submit: ((action: string) => void) | undefined;
    return this.openCustom<SessionSettingsSelection>(
      (screen, _theme, _keys, done) => {
        let activeTab = options.activeTab;
        let persist = false;
        let focused = false;
        const selectors: {
          model?: ModelSelectorComponent;
          thinking?: ThinkingSelectorComponent;
        } = {};
        const current = () => {
          if (activeTab === 'model') {
            return (selectors.model ??= new ModelSelectorComponent(
              screen,
              options.model.currentModel,
              options.model.modelRuntime,
              options.model.scopedModels,
              model => done({kind: 'model', model, persist}),
              () => done(undefined),
              options.model.initialSearch,
              model => done({kind: 'model', model, persist: true}),
              options.model.defaultModel,
            ));
          }
          return (selectors.thinking ??= new ThinkingSelectorComponent(
            options.thinking.currentLevel,
            options.thinking.availableLevels,
            thinkingLevel => done({kind: 'thinking', thinkingLevel, persist}),
            () => done(undefined),
            thinkingLevel =>
              done({kind: 'thinking', thinkingLevel, persist: true}),
            options.thinking.defaultLevel,
          ));
        };
        switchTab = tab => {
          if (tab !== 'model' && tab !== 'thinking') return;
          if (tab === activeTab) return;
          current().focused = false;
          activeTab = tab;
          current().focused = focused;
          screen.requestRender(true);
        };
        submit = action => {
          persist = action === 'default';
          try {
            const selector = current();
            if (selector instanceof ModelSelectorComponent) {
              const search = selector.getSearchInput();
              search.onSubmit?.(search.getValue());
            } else {
              const list = selector.getSelectList();
              const selected = list.getSelectedItem();
              if (selected) list.onSelect?.(selected);
            }
          } finally {
            persist = false;
          }
        };
        current();
        return {
          get focused() {
            return focused;
          },
          set focused(value: boolean) {
            focused = value;
            current().focused = value;
          },
          render: width => current().render(width),
          invalidate: () => {
            selectors.model?.invalidate();
            selectors.thinking?.invalidate();
          },
          handleInput: data => current().handleInput(data),
          dispose: () => selectors.model?.dispose(),
        };
      },
      undefined,
      'Model & thinking',
      {
        actions: this.selectionActions(),
        tabs: [
          {id: 'model', label: 'Model'},
          {id: 'thinking', label: 'Thinking'},
        ],
        activeTab: options.activeTab,
        onTab: tab => switchTab?.(tab),
        onAction: action => submit?.(action),
        signal,
      },
    );
  }

  selectModel(options: DesktopModelSelectorOptions) {
    return this.openModelSelector(options);
  }

  private openModelSelector(
    options: DesktopModelSelectorOptions,
    signal?: AbortSignal,
  ) {
    type Model = NonNullable<ModelSelectorArguments[1]>;
    let submit: ((action: string) => void) | undefined;
    return this.openCustom<{model: Model; persist: boolean} | undefined>(
      (screen, _theme, _keys, done) => {
        let persist = false;
        const selector = new ModelSelectorComponent(
          screen,
          options.currentModel,
          options.modelRuntime,
          options.scopedModels,
          model => done({model, persist}),
          () => done(undefined),
          options.initialSearch,
          model => done({model, persist: true}),
          options.defaultModel,
        );
        submit = action => {
          persist = action === 'default';
          try {
            const search = selector.getSearchInput();
            search.onSubmit?.(search.getValue());
          } finally {
            persist = false;
          }
        };
        return selector;
      },
      undefined,
      'Model',
      {
        actions: this.selectionActions(),
        onAction: action => submit?.(action),
        signal,
      },
    );
  }

  selectThinking(options: DesktopThinkingSelectorOptions) {
    return this.openThinkingSelector(options);
  }

  private openThinkingSelector(
    options: DesktopThinkingSelectorOptions,
    signal?: AbortSignal,
  ) {
    type ThinkingLevel = ThinkingSelectorArguments[0];
    let submit: ((action: string) => void) | undefined;
    return this.openCustom<
      {thinkingLevel: ThinkingLevel; persist: boolean} | undefined
    >(
      (_screen, _theme, _keys, done) => {
        let persist = false;
        const selector = new ThinkingSelectorComponent(
          options.currentLevel,
          options.availableLevels,
          thinkingLevel => done({thinkingLevel, persist}),
          () => done(undefined),
          thinkingLevel => done({thinkingLevel, persist: true}),
          options.defaultLevel,
        );
        submit = action => {
          persist = action === 'default';
          try {
            const list = selector.getSelectList();
            const selected = list.getSelectedItem();
            if (selected) list.onSelect?.(selected);
          } finally {
            persist = false;
          }
        };
        return selector;
      },
      undefined,
      'Thinking level',
      {
        actions: this.selectionActions(),
        onAction: action => submit?.(action),
        signal,
      },
    );
  }

  private selectionActions(): NonNullable<DesktopUIDialog['actions']> {
    return [
      {id: 'default', label: 'Make as default'},
      {id: 'session', label: 'Apply to session'},
    ];
  }

  async show(title: string, message: string): Promise<void> {
    await this.open(
      {kind: 'info', title, message: bounded(message, MAX_EDITOR_TEXT)},
      undefined,
      true,
    );
  }

  /** The renderer acknowledges before replacing the parent, avoiding a close deadlock. */
  navigate(cwd: string, sessionId: string, draft?: string): void {
    if (this.disposed || this.cancelling) return;
    this.navigation = {
      id: randomUUID(),
      cwd,
      sessionId,
      ...(draft !== undefined ? {draft: bounded(draft, MAX_EDITOR_TEXT)} : {}),
    };
    this.onChange();
  }

  snapshot(): DesktopUIState {
    return {
      dialogs: this.pending.map(({dialog}) => ({
        ...dialog,
        ...(dialog.options ? {options: [...dialog.options]} : {}),
        ...(dialog.actions
          ? {actions: dialog.actions.map(action => ({...action}))}
          : {}),
        ...(dialog.tabs ? {tabs: dialog.tabs.map(tab => ({...tab}))} : {}),
        ...(dialog.terminal ? {terminal: {...dialog.terminal}} : {}),
      })),
      notifications: this.notifications.map(item => ({...item})),
      statuses: [...this.statuses, ...this.widgets].map(([key, text]) => ({
        key,
        text,
      })),
      ...(this.editorState ? {editor: {...this.editorState}} : {}),
      ...(this.navigation ? {navigation: {...this.navigation}} : {}),
      ...(this.extensionEditorId
        ? {extensionEditor: {id: this.extensionEditorId}}
        : {}),
    };
  }

  /** Only the first dialog accepts input. Unknown or stale responses are ignored. */
  respond(id: string, value?: string | boolean | DesktopUIDialogAction): void {
    if (this.disposed) return;
    if (id === this.navigation?.id) {
      this.navigation = undefined;
      this.onChange();
      return;
    }
    if (id === this.extensionEditorId) {
      if (typeof value === 'string' && !this.extensionEditorOpen)
        this.openExtensionEditor(value);
      return;
    }
    if (id === this.editorState?.id) {
      if (typeof value === 'string') {
        this.editorText = bounded(value, MAX_EDITOR_TEXT);
        this.editorState.text = this.editorText;
        this.onChange();
      }
      return;
    }
    const item = this.pending[0];
    if (!item || item.dialog.id !== id) return;
    if (item.dialog.kind === 'info') {
      item.finish(undefined);
      return;
    }
    if (item.dialog.kind === 'terminal') {
      if (value === undefined) item.finish(undefined);
      else if (typeof value === 'string' && value.length <= MAX_EDITOR_TEXT)
        item.input?.(value);
      else if (
        value &&
        typeof value === 'object' &&
        Object.keys(value).length === 1 &&
        (item.dialog.actions?.some(action => action.id === value.action) ||
          item.dialog.tabs?.some(tab => `tab:${tab.id}` === value.action))
      )
        item.onAction?.(value.action);
      return;
    }
    if (value === undefined) {
      item.finish(item.dialog.kind === 'confirm' ? false : undefined);
    } else if (item.dialog.kind === 'confirm') {
      if (typeof value === 'boolean') item.finish(value);
    } else if (typeof value === 'string' && value.length <= MAX_EDITOR_TEXT) {
      if (item.dialog.kind !== 'select' || item.dialog.options?.includes(value))
        item.finish(value);
    }
  }

  /** Abort outstanding interactions while keeping this session's UI usable. */
  cancelDialogs(): void {
    this.navigation = undefined;
    this.cancelling = true;
    try {
      for (const item of [...this.pending])
        item.finish(item.dialog.kind === 'confirm' ? false : undefined);
    } finally {
      this.cancelling = false;
    }
  }

  /** Supply the native session's cwd and command/skill catalog for completions. */
  configureBaseAutocomplete(
    cwd: string,
    commands: Array<{name: string; description?: string}> = [],
  ): void {
    if (this.disposed) return;
    this.baseAutocomplete = new tui.CombinedAutocompleteProvider(
      commands.slice(0, 1000),
      cwd,
      null,
    );
  }

  /** Bind real session footer metadata when the host provides it. */
  setFooterDataProvider(provider: ReadonlyFooterDataProvider): void {
    this.footerData = provider;
    this.viewTUI?.requestRender(true);
  }

  /** Remove the previous extension lifecycle while retaining the native draft. */
  resetExtensions(): void {
    if (this.disposed) return;
    this.extensionGeneration++;
    // Ignore old component cleanup writes while their views are being removed.
    this.disposed = true;
    try {
      this.clearExtensionState();
    } finally {
      this.disposed = false;
    }
    this.onChange();
  }

  /** Settle every outstanding promise and remove timers and abort listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.extensionGeneration++;
    this.clearExtensionState();
    this.editorState = undefined;
    this.editorText = '';
    this.onChange();
  }

  private clearExtensionState(): void {
    this.cancelDialogs();
    this.viewTUI?.stop();
    for (const key of [...this.views.keys()]) this.removeView(key);
    this.viewTUI = undefined;
    this.terminalListeners.clear();
    this.editorFactory = undefined;
    this.autocompleteFactories = [];
    this.extensionEditorId = undefined;
    this.extensionEditorOpen = false;
    this.notifications = [];
    this.statuses.clear();
    this.widgets.clear();
  }

  private open(
    data: Omit<DesktopUIDialog, 'id'>,
    opts?: ExtensionUIDialogOptions,
    native = false,
  ): Promise<DialogValue> {
    const cancelled = data.kind === 'confirm' ? false : undefined;
    if (this.disposed || opts?.signal?.aborted)
      return Promise.resolve(cancelled);
    if (
      this.pending.length >= MAX_DIALOGS ||
      data.title.length > MAX_TEXT ||
      (data.message?.length ?? 0) > (native ? MAX_EDITOR_TEXT : MAX_TEXT) ||
      (data.placeholder?.length ?? 0) > MAX_TEXT ||
      (data.prefill?.length ?? 0) > MAX_EDITOR_TEXT ||
      (data.options?.length ?? 0) > (native ? 10000 : MAX_OPTIONS) ||
      (data.options?.reduce((size, option) => size + option.length, 0) ?? 0) >
        (native ? 2 * 1024 * 1024 : MAX_EDITOR_TEXT)
    ) {
      const message =
        'Extension dialog exceeds the desktop UI size or queue limit.';
      this.notify(message, 'error');
      return Promise.reject(new Error(message));
    }
    if (opts?.timeout !== undefined && opts.timeout <= 0)
      return Promise.resolve(cancelled);
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = opts?.signal;
      const abort = () => item.finish(cancelled);
      const item: PendingDialog = {
        dialog: {
          id: randomUUID(),
          ...data,
          ...(data.kind === 'select'
            ? {searchable: data.searchable ?? true}
            : {}),
        },
        finish: value => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          this.pending = this.pending.filter(pending => pending !== item);
          resolve(value as DialogValue);
          if (!this.disposed) {
            if (!this.cancelling) this.pending[0]?.activate?.();
            this.onChange();
          }
        },
      };
      this.pending.push(item);
      signal?.addEventListener('abort', abort, {once: true});
      if (opts?.timeout !== undefined && Number.isFinite(opts.timeout))
        timer = setTimeout(abort, Math.min(opts.timeout, 2147483647));
      this.onChange();
    });
  }

  private openCustom<T>(
    factory: CustomFactory<T>,
    options?: CustomOptions,
    title = 'Extension',
    controls?: CustomDialogControls,
  ): Promise<T> {
    if (this.disposed || controls?.signal?.aborted)
      return Promise.resolve(undefined as T);
    if (this.pending.length >= MAX_DIALOGS) {
      const message = 'Extension dialog exceeds the desktop UI queue limit.';
      this.notify(message, 'error');
      return Promise.reject(new Error(message));
    }
    return new Promise<T>((resolve, reject) => {
      let component: TerminalComponent | undefined;
      let renderer: TerminalTUI | undefined;
      let terminal: VirtualTerminal | undefined;
      let started = false;
      let closed = false;
      const signal = controls?.signal;
      const abort = () => item.finish(undefined);
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        terminal?.stop();
        renderer?.stop();
        this.disposeComponent(component);
        component = undefined;
        this.pending = this.pending.filter(pending => pending !== item);
        if (!this.disposed) {
          if (!this.cancelling) this.pending[0]?.activate?.();
          this.onChange();
        }
      };
      const fail = (error: unknown) => {
        if (closed) return;
        closed = true;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.notify(
          `Extension terminal UI failed: ${failure.message}`,
          'error',
        );
        cleanup();
        reject(failure);
      };
      const item: PendingDialog = {
        dialog: {
          id: randomUUID(),
          kind: 'terminal',
          title,
          ...(controls?.tabs
            ? {
                tabs: controls.tabs.map(tab => ({...tab})),
                activeTab: controls.activeTab,
              }
            : {}),
          ...(controls?.actions
            ? {actions: controls.actions.map(action => ({...action}))}
            : {}),
        },
        onAction: action => {
          try {
            this.withKeybindings(() => {
              const tab = item.dialog.tabs?.find(
                tab => `tab:${tab.id}` === action,
              );
              if (tab) {
                controls?.onTab?.(tab.id);
                item.dialog.activeTab = tab.id;
                this.onChange();
              } else controls?.onAction?.(action);
            });
          } catch (error) {
            fail(error);
          }
        },
        finish: result => {
          if (closed) return;
          closed = true;
          cleanup();
          resolve(result as T);
        },
        input: data => {
          try {
            terminal?.input(data);
          } catch (error) {
            fail(error);
          }
        },
        activate: () => {
          if (started || closed || this.disposed) return;
          started = true;
          terminal = new VirtualTerminal(
            () => {
              if (!closed && !this.disposed) this.onChange();
            },
            fail,
            data => this.filterTerminalInput(data),
            true,
            operation => this.withKeybindings(operation),
          );
          item.dialog.terminal = terminal.state;
          renderer = new tui.TuiAltScreen(terminal, true);
          terminal.attach(renderer);
          // Starting before factory construction also supports components which
          // show their own overlays or query the virtual terminal in the factory.
          renderer.start();
          Promise.resolve()
            .then(() =>
              closed
                ? undefined
                : this.withKeybindings(() =>
                    factory(
                      renderer!,
                      this.currentTheme,
                      this.keybindings,
                      result => item.finish(result),
                    ),
                  ),
            )
            .then(created => {
              if (!created) {
                if (!closed)
                  fail(
                    new Error(
                      'The extension custom UI factory returned no component.',
                    ),
                  );
                return;
              }
              if (closed) {
                this.disposeComponent(created);
                return;
              }
              component = created;
              const render = component.render.bind(component);
              component.render = width => {
                try {
                  return this.withKeybindings(() => render(width));
                } catch (error) {
                  fail(error);
                  return [];
                }
              };
              if (options?.overlay) {
                const overlayOptions =
                  typeof options.overlayOptions === 'function'
                    ? options.overlayOptions()
                    : options.overlayOptions;
                const handle = renderer!.showOverlay(component, overlayOptions);
                options.onHandle?.(handle);
              } else {
                renderer!.addChild(component);
                renderer!.setFocus(component);
              }
              renderer!.requestRender(true);
            })
            .catch(fail);
        },
      };
      this.pending.push(item);
      signal?.addEventListener('abort', abort, {once: true});
      if (this.pending[0] === item) item.activate!();
      this.onChange();
    });
  }

  private updateExtensionEditor(): void {
    this.extensionEditorId =
      this.editorFactory || this.autocompleteFactories.length
        ? randomUUID()
        : undefined;
    this.onChange();
  }

  private openExtensionEditor(draft: string): void {
    this.extensionEditorOpen = true;
    const generation = this.extensionGeneration;
    this.editorText = bounded(draft, MAX_EDITOR_TEXT);
    if (this.editorState) this.editorState.text = this.editorText;
    const initialText = this.editorText;
    const factory = this.editorFactory;
    const wrappers = [...this.autocompleteFactories];
    const base = this.baseAutocomplete;
    void this.openCustom<string | undefined>(
      (screen, theme, keys, done) => {
        const editorTheme: EditorTheme = {
          borderColor: text => theme.fg('borderMuted', text),
          selectList: {
            selectedPrefix: text => theme.fg('accent', text),
            selectedText: text => theme.fg('accent', text),
            description: text => theme.fg('muted', text),
            scrollInfo: text => theme.fg('muted', text),
            noMatch: text => theme.fg('muted', text),
          },
        };
        const editor: EditorComponent = factory
          ? factory(screen, editorTheme, keys)
          : new tui.Editor(screen, editorTheme);
        const dispose = editor.dispose?.bind(editor);
        editor.dispose = () => {
          // SDK Editor cancels its pending completion requests when the provider
          // changes. Custom editors also get their own cleanup callback.
          editor.setAutocompleteProvider?.(base);
          dispose?.();
        };
        try {
          editor.setText(initialText);
          editor.onSubmit = text => done(text);
          let provider = base;
          for (const wrapper of wrappers) provider = wrapper(provider);
          if (wrappers.length && !editor.setAutocompleteProvider)
            throw new Error(
              'The custom editor needs setAutocompleteProvider to use extension autocomplete.',
            );
          editor.setAutocompleteProvider?.(provider);
          return editor;
        } catch (error) {
          this.disposeComponent(editor);
          throw error;
        }
      },
      undefined,
      'Extension editor',
    )
      .then(result => {
        if (
          typeof result === 'string' &&
          !this.disposed &&
          generation === this.extensionGeneration
        )
          this.setEditorText(result);
      })
      .catch(() => {
        // openCustom already publishes the failure as a visible notification.
      })
      .finally(() => {
        if (generation === this.extensionGeneration)
          this.extensionEditorOpen = false;
      });
  }

  private withKeybindings<T>(operation: () => T): T {
    const previous = tui.getKeybindings();
    tui.setKeybindings(this.keybindings);
    try {
      return operation();
    } finally {
      tui.setKeybindings(previous);
    }
  }

  private filterTerminalInput(data: string): string | undefined {
    let current = data;
    for (const handler of this.terminalListeners) {
      const result = handler(current);
      if (result?.consume) return undefined;
      if (result?.data !== undefined) current = result.data;
    }
    return current;
  }

  private setView(
    key: string,
    factory:
      ((tui: TerminalTUI, theme: Theme) => TerminalComponent) | undefined,
  ): void {
    if (this.disposed) return;
    this.removeView(key);
    if (!factory) {
      this.setStatus(key, undefined, this.widgets);
      return;
    }
    if (
      key.length > 256 ||
      (!this.widgets.has(key) &&
        this.statuses.size + this.widgets.size >= MAX_STATUSES)
    )
      throw new Error('Desktop UI status and widget limit reached.');
    if (!this.viewTUI) {
      const terminal = new VirtualTerminal(
        () => {},
        error => this.notify(error.message, 'error'),
        data => this.filterTerminalInput(data),
        false,
        operation => this.withKeybindings(operation),
      );
      this.viewTUI = new tui.TuiAltScreen(terminal);
      terminal.attach(this.viewTUI);
      this.viewTUI.start();
    }
    try {
      const component = this.withKeybindings(() =>
        factory(this.viewTUI!, this.currentTheme),
      );
      const wrapper: TerminalComponent = {
        render: width => {
          let text: string;
          try {
            text = bounded(
              tui.stripTerminalSequences(
                this.withKeybindings(() => component.render(width)).join('\n'),
              ),
            );
          } catch (error) {
            text = bounded(
              `Extension view failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (this.widgets.get(key) !== text) {
            this.widgets.set(key, text);
            if (!this.disposed) this.onChange();
          }
          // View output lives in status rows; the renderer drives refresh timing.
          return [];
        },
        invalidate: () => component.invalidate(),
      };
      this.views.set(key, {component, wrapper});
      this.viewTUI.addChild(wrapper);
      // Publish initial content synchronously, then allow normal Pi redraws.
      wrapper.render(100);
      this.viewTUI.requestRender(true);
    } catch (error) {
      this.notify(
        `Extension view failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

  private removeView(key: string): void {
    const previous = this.views.get(key);
    if (!previous) return;
    this.views.delete(key);
    this.viewTUI?.removeChild(previous.wrapper);
    this.disposeComponent(previous.component);
    this.widgets.delete(key);
    if (!this.disposed) this.viewTUI?.requestRender(true);
  }

  private disposeComponent(component?: TerminalComponent): void {
    try {
      component?.dispose?.();
    } catch (error) {
      this.notify(
        `Extension component cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

  private notify(message: string, type: 'info' | 'warning' | 'error'): void {
    if (this.disposed) return;
    this.notifications.push({
      id: randomUUID(),
      message: bounded(message),
      type,
    });
    this.notifications = this.notifications.slice(-MAX_NOTIFICATIONS);
    this.onChange();
  }

  private setStatus(
    key: string,
    text: string | undefined,
    entries = this.statuses,
  ): void {
    if (this.disposed) return;
    if (key.length > 256) throw new Error('Desktop UI status key is too long.');
    if (text === undefined) entries.delete(key);
    else {
      if (
        !entries.has(key) &&
        this.statuses.size + this.widgets.size >= MAX_STATUSES
      )
        throw new Error('Desktop UI status and widget limit reached.');
      entries.set(key, bounded(text));
    }
    this.viewTUI?.requestRender();
    this.onChange();
  }

  private setEditorText(text: string): void {
    if (this.disposed) return;
    this.editorText = bounded(text, MAX_EDITOR_TEXT);
    this.editorState = {id: randomUUID(), text: this.editorText};
    this.onChange();
  }

  private getTheme(name: string): Theme | undefined {
    try {
      return themes.getThemeByName(name);
    } catch {
      return undefined;
    }
  }
}
