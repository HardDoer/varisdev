/* global document, window */

const rgb = hex =>
  [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);

function theme(id, name, colorScheme, colors, sceneColors) {
  return Object.freeze({
    id,
    name,
    colorScheme,
    colors: Object.freeze(colors),
    scenePalette: Object.freeze(
      Object.fromEntries(
        Object.entries({
          ...sceneColors,
          selection: colors['selection-bg'],
          running: colors['status-running'],
          queued: colors['status-queued'],
          completed: colors['status-completed'],
        }).map(([key, value]) => [
          key,
          Object.freeze(typeof value === 'string' ? rgb(value) : value),
        ]),
      ),
    ),
  });
}

/** Shared palette data is safe to import without a browser. */
export const THEMES = Object.freeze([
  theme(
    'factory',
    'Factory',
    'dark',
    {
      bg: '#0b121b',
      panel: '#101c27',
      'panel-raised': '#172532',
      input: '#0d1822',
      line: '#577383',
      text: '#edf4f6',
      muted: '#a0b5c3',
      mint: '#74f3c0',
      cyan: '#75d9ff',
      amber: '#ffcb7a',
      red: '#ff9397',
      violet: '#d1b7ff',
      rose: '#ffb4da',
      focus: '#74f3c0',
      'accent-text': '#09281f',
      hover: '#203442',
      selected: '#1b3635',
      'selection-bg': '#b9e8ff',
      'selection-text': '#102735',
      'selection-border': '#75d9ff',
      'status-running': '#78e6a1',
      'status-queued': '#f5d76e',
      'status-completed': '#91baff',
      danger: '#38232d',
      scene: '#111e2b',
      'scene-glow': '#243c48',
      'page-glow': '#172a36',
    },
    {
      floor: [0.095, 0.14, 0.16],
      edge: [0.14, 0.21, 0.23],
      dark: [0.065, 0.095, 0.115],
      metal: [0.29, 0.37, 0.39],
      shell: [0.66, 0.75, 0.73],
      white: [0.83, 0.91, 0.86],
      mint: [0.33, 1, 0.77],
      cyan: [0.15, 0.77, 1],
      amber: [1, 0.63, 0.22],
      red: [1, 0.22, 0.2],
      dim: [0.19, 0.34, 0.35],
      screen: [0.027, 0.13, 0.15],
    },
  ),
  theme(
    'nord',
    'Nord',
    'dark',
    {
      bg: '#2e3440',
      panel: '#303744',
      'panel-raised': '#3b4252',
      input: '#2b303b',
      line: '#8995aa',
      text: '#eceff4',
      muted: '#c5ccda',
      mint: '#b4d19b',
      cyan: '#a0d4e2',
      amber: '#ebcb8b',
      red: '#ffc0c5',
      violet: '#d1b7ff',
      rose: '#ffb4da',
      focus: '#88c0d0',
      'accent-text': '#242b35',
      hover: '#454f61',
      selected: '#414b5d',
      'selection-bg': '#d8ebff',
      'selection-text': '#242b35',
      'selection-border': '#a0d4e2',
      'status-running': '#b4d19b',
      'status-queued': '#ebcb8b',
      'status-completed': '#a8c6ff',
      danger: '#493947',
      scene: '#2e3440',
      'scene-glow': '#3b4252',
      'page-glow': '#3b4252',
    },
    {
      floor: '#3b4252',
      edge: '#4c566a',
      dark: '#2e3440',
      metal: '#7e8ba2',
      shell: '#d8dee9',
      white: '#eceff4',
      mint: '#a3be8c',
      cyan: '#88c0d0',
      amber: '#ebcb8b',
      red: '#bf616a',
      dim: '#5e81ac',
      screen: '#242933',
    },
  ),
  theme(
    'dracula',
    'Dracula',
    'dark',
    {
      bg: '#282a36',
      panel: '#282a36',
      'panel-raised': '#343746',
      input: '#21222c',
      line: '#9294b8',
      text: '#f8f8f2',
      muted: '#c5c6e8',
      mint: '#50fa7b',
      cyan: '#8be9fd',
      amber: '#f1fa8c',
      red: '#ff9aab',
      violet: '#d1b7ff',
      rose: '#ffb4da',
      focus: '#bd93f9',
      'accent-text': '#20212b',
      hover: '#404252',
      selected: '#404252',
      'selection-bg': '#e2d1ff',
      'selection-text': '#20212b',
      'selection-border': '#bd93f9',
      'status-running': '#50fa7b',
      'status-queued': '#f1fa8c',
      'status-completed': '#a8bfff',
      danger: '#493342',
      scene: '#21222c',
      'scene-glow': '#343746',
      'page-glow': '#343746',
    },
    {
      floor: '#343746',
      edge: '#44475a',
      dark: '#21222c',
      metal: '#6272a4',
      shell: '#bd93f9',
      white: '#f8f8f2',
      mint: '#50fa7b',
      cyan: '#8be9fd',
      amber: '#ffb86c',
      red: '#ff5555',
      dim: '#bd93f9',
      screen: '#191a22',
    },
  ),
  theme(
    'catppuccin-mocha',
    'Catppuccin Mocha',
    'dark',
    {
      bg: '#1e1e2e',
      panel: '#242436',
      'panel-raised': '#313244',
      input: '#181825',
      line: '#9399b2',
      text: '#cdd6f4',
      muted: '#bac2de',
      mint: '#a6e3a1',
      cyan: '#89dceb',
      amber: '#f9e2af',
      red: '#f38ba8',
      violet: '#d1b7ff',
      rose: '#ffb4da',
      focus: '#b4befe',
      'accent-text': '#1e1e2e',
      hover: '#38394f',
      selected: '#38394f',
      'selection-bg': '#d5d9ff',
      'selection-text': '#1e1e2e',
      'selection-border': '#b4befe',
      'status-running': '#a6e3a1',
      'status-queued': '#f9e2af',
      'status-completed': '#a6c8ff',
      danger: '#3b2b3c',
      scene: '#181825',
      'scene-glow': '#313244',
      'page-glow': '#313244',
    },
    {
      floor: '#313244',
      edge: '#45475a',
      dark: '#181825',
      metal: '#7f849c',
      shell: '#cdd6f4',
      white: '#f5e0dc',
      mint: '#a6e3a1',
      cyan: '#89dceb',
      amber: '#f9e2af',
      red: '#f38ba8',
      dim: '#b4befe',
      screen: '#11111b',
    },
  ),
  theme(
    'solarized-light',
    'Solarized Light',
    'light',
    {
      bg: '#fdf6e3',
      panel: '#fff9e8',
      'panel-raised': '#eee8d5',
      input: '#fffdf4',
      line: '#778981',
      text: '#344b52',
      muted: '#52656b',
      mint: '#356600',
      cyan: '#006b85',
      amber: '#895900',
      red: '#b53027',
      violet: '#6741a5',
      rose: '#9b2865',
      focus: '#005f89',
      'accent-text': '#fffdf4',
      hover: '#e7dfc9',
      selected: '#e7dfc9',
      'selection-bg': '#005f89',
      'selection-text': '#fffdf4',
      'selection-border': '#005f89',
      'status-running': '#356600',
      'status-queued': '#895900',
      'status-completed': '#215ab0',
      danger: '#f5e5d7',
      scene: '#eee8d5',
      'scene-glow': '#fdf6e3',
      'page-glow': '#eee8d5',
    },
    {
      floor: '#d8d1bd',
      edge: '#b8b5a3',
      dark: '#657b83',
      metal: '#93a1a1',
      shell: '#eee8d5',
      white: '#fdf6e3',
      mint: '#859900',
      cyan: '#268bd2',
      amber: '#b58900',
      red: '#dc322f',
      dim: '#2aa198',
      screen: '#073642',
    },
  ),
  theme(
    'high-contrast',
    'High Contrast',
    'dark',
    {
      bg: '#000000',
      panel: '#000000',
      'panel-raised': '#121212',
      input: '#000000',
      line: '#b3b3b3',
      text: '#ffffff',
      muted: '#e6e6e6',
      mint: '#ffff00',
      cyan: '#00ffff',
      amber: '#ffe3a6',
      red: '#ffb3b3',
      violet: '#d1b7ff',
      rose: '#ffb4da',
      focus: '#ffffff',
      'accent-text': '#000000',
      hover: '#252525',
      selected: '#252525',
      'selection-bg': '#ffffff',
      'selection-text': '#000000',
      'selection-border': '#ffffff',
      'status-running': '#78f0a5',
      'status-queued': '#fff37a',
      'status-completed': '#99c2ff',
      danger: '#250f0f',
      scene: '#000000',
      'scene-glow': '#121212',
      'page-glow': '#121212',
    },
    {
      floor: '#121212',
      edge: '#595959',
      dark: '#000000',
      metal: '#999999',
      shell: '#e6e6e6',
      white: '#ffffff',
      mint: '#ffff00',
      cyan: '#00ffff',
      amber: '#ffe3a6',
      red: '#ffb3b3',
      dim: '#bbbbbb',
      screen: '#000000',
    },
  ),
]);

const STORAGE_KEY = 'varisdev.factory.theme';

/** Merge a plugin palette with a shipped base and derive matching scene colors. */
export function pluginTheme(entry) {
  const base =
    THEMES.find(candidate => candidate.id === entry.base) ?? THEMES[0];
  const colors = {...base.colors, ...entry.colors};
  const scene = {
    floor: colors.scene,
    edge: colors.line,
    dark: colors.bg,
    metal: colors.muted,
    shell: colors.text,
    white: colors.text,
    mint: colors.mint,
    cyan: colors.cyan,
    amber: colors.amber,
    red: colors.red,
    dim: colors['scene-glow'],
    screen: colors.input,
    selection: colors['selection-bg'],
    running: colors['status-running'],
    queued: colors['status-queued'],
    completed: colors['status-completed'],
    ...entry.scenePalette,
  };
  return {
    ...entry,
    colorScheme: base.colorScheme,
    colors,
    scenePalette: Object.fromEntries(
      Object.entries(scene).map(([key, value]) => [key, rgb(value)]),
    ),
  };
}

/** Insert the theme control, discover installed plugins, and apply the saved theme. */
export function initThemes(onChange = () => {}, {deferDiscovery = false} = {}) {
  const actions = document.getElementById('app-menu-panel');
  const label = document.createElement('label');
  label.className = 'theme-control';
  const caption = document.createElement('span');
  caption.textContent = 'Theme';
  const select = document.createElement('select');
  select.id = 'factory-theme';
  select.name = 'theme';
  label.htmlFor = select.id;
  label.append(caption, select);
  actions?.insertBefore(label, actions.querySelector('#motion-toggle'));

  const diagnostics = document.createElement('details');
  diagnostics.id = 'plugin-theme-errors';
  diagnostics.hidden = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Theme errors';
  const errors = document.createElement('ul');
  diagnostics.append(summary, errors);
  label.after(diagnostics);

  let entries = [...THEMES];
  let selected;
  let sessionId;
  let generation = 0;
  let disposed = false;
  try {
    selected = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Theme selection remains available when storage is unavailable.
  }
  function options() {
    select.replaceChildren();
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.packageName
        ? `${entry.name} · ${entry.packageName}`
        : entry.name;
      select.append(option);
    }
  }
  function save(id) {
    selected = id;
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // The selected palette still applies for this window.
    }
  }
  function apply(id) {
    const entry = entries.find(candidate => candidate.id === id) ?? THEMES[0];
    select.value = entry.id;
    document.documentElement.dataset.theme = entry.id;
    document.documentElement.style.colorScheme = entry.colorScheme;
    document.getElementById('plugin-theme-style')?.remove();
    if (entry.packageName) {
      const style = document.createElement('style');
      style.id = 'plugin-theme-style';
      style.textContent = `:root {${Object.entries(entry.colors)
        .map(([key, value]) => `--${key}: ${value};`)
        .join('')}}\n${entry.css ?? ''}`;
      document.head.append(style);
    }
    onChange(entry.scenePalette);
    return entry.id;
  }
  options();
  // Keep the preferred theme when its package is absent from the current project.
  apply(selected);
  function change() {
    save(apply(select.value));
  }
  select.addEventListener('change', change);

  async function refresh(...args) {
    if (args.length) sessionId = args[0];
    if (!window.pidev?.appThemes || disposed) return;
    const request = ++generation;
    let result;
    try {
      result = await window.pidev.appThemes(sessionId);
    } catch (error) {
      if (disposed || request !== generation) return;
      errors.replaceChildren();
      const item = document.createElement('li');
      item.textContent = error instanceof Error ? error.message : String(error);
      errors.append(item);
      diagnostics.hidden = false;
      return;
    }
    if (disposed || request !== generation) return;
    entries = [...THEMES, ...result.themes.map(pluginTheme)];
    options();
    apply(selected);
    errors.replaceChildren();
    for (const message of result.errors) {
      const item = document.createElement('li');
      item.textContent = message;
      errors.append(item);
    }
    diagnostics.hidden = !result.errors.length;
  }
  const opened = () => void refresh();
  actions?.addEventListener('varisdev:app-menu-open', opened);
  if (!deferDiscovery) void refresh();
  const dispose = () => {
    disposed = true;
    generation++;
    select.removeEventListener('change', change);
    actions?.removeEventListener('varisdev:app-menu-open', opened);
    document.getElementById('plugin-theme-style')?.remove();
    diagnostics.remove();
    label.remove();
  };
  dispose.refresh = refresh;
  return dispose;
}
