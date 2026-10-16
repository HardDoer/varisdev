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
      accent: '#74f3c0',
      link: '#74f3c0',
      heading: '#edf4f6',
      code: '#75d9ff',
      'message-user': '#75d9ff',
      'message-assistant': '#74f3c0',
      'action-read': '#75d9ff',
      'action-edit': '#ffcb7a',
      'action-command': '#d1b7ff',
      'action-web': '#75d9ff',
      'action-agent': '#74f3c0',
      'action-media': '#ffb4da',
      'diff-add': '#74f3c0',
      'diff-remove': '#ff9397',
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
      violet: '#c9a7c0',
      rose: '#e7ad95',
      accent: '#88c0d0',
      link: '#a0d4e2',
      heading: '#a8c6e6',
      code: '#b4d19b',
      'message-user': '#c9a7c0',
      'message-assistant': '#88c0d0',
      'action-read': '#a8c6e6',
      'action-edit': '#e7ad95',
      'action-command': '#b4d19b',
      'action-web': '#a0d4e2',
      'action-agent': '#ebcb8b',
      'action-media': '#ebcb8b',
      'diff-add': '#b4d19b',
      'diff-remove': '#ffc0c5',
      focus: '#88c0d0',
      'accent-text': '#242b35',
      hover: '#3b4252',
      selected: '#3b4252',
      'selection-bg': '#d8ebff',
      'selection-text': '#242b35',
      'selection-border': '#a0d4e2',
      'status-running': '#b4d19b',
      'status-queued': '#ebcb8b',
      'status-completed': '#88c0d0',
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
      violet: '#bd93f9',
      rose: '#ff79c6',
      accent: '#bd93f9',
      link: '#8be9fd',
      heading: '#bd93f9',
      code: '#f1fa8c',
      'message-user': '#8be9fd',
      'message-assistant': '#ff79c6',
      'action-read': '#50fa7b',
      'action-edit': '#ffb86c',
      'action-command': '#ff79c6',
      'action-web': '#8be9fd',
      'action-agent': '#bd93f9',
      'action-media': '#f1fa8c',
      'diff-add': '#50fa7b',
      'diff-remove': '#ff9aab',
      focus: '#bd93f9',
      'accent-text': '#20212b',
      hover: '#383a4a',
      selected: '#383a4a',
      'selection-bg': '#e2d1ff',
      'selection-text': '#20212b',
      'selection-border': '#bd93f9',
      'status-running': '#50fa7b',
      'status-queued': '#ffb86c',
      'status-completed': '#bd93f9',
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
      violet: '#cba6f7',
      rose: '#f5c2e7',
      accent: '#cba6f7',
      link: '#89b4fa',
      heading: '#f5c2e7',
      code: '#fab387',
      'message-user': '#b4befe',
      'message-assistant': '#94e2d5',
      'action-read': '#f9e2af',
      'action-edit': '#f38ba8',
      'action-command': '#89b4fa',
      'action-web': '#94e2d5',
      'action-agent': '#cba6f7',
      'action-media': '#f5c2e7',
      'diff-add': '#a6e3a1',
      'diff-remove': '#f38ba8',
      focus: '#cba6f7',
      'accent-text': '#1e1e2e',
      hover: '#38394f',
      selected: '#3b304c',
      'selection-bg': '#e3cef7',
      'selection-text': '#1e1e2e',
      'selection-border': '#cba6f7',
      'status-running': '#a6e3a1',
      'status-queued': '#f9e2af',
      'status-completed': '#94e2d5',
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
    'forest',
    'Forest',
    'dark',
    {
      bg: '#0c1812',
      panel: '#112219',
      'panel-raised': '#1b3023',
      input: '#0b1912',
      line: '#78957f',
      text: '#e8f4e8',
      muted: '#adc5af',
      mint: '#9be28f',
      cyan: '#8fd6c6',
      amber: '#edcf8a',
      red: '#f3a49c',
      violet: '#c6b5ed',
      rose: '#e8b0cb',
      accent: '#9be28f',
      link: '#8fd6c6',
      heading: '#edcf8a',
      code: '#8fd6c6',
      'message-user': '#8fd6c6',
      'message-assistant': '#9be28f',
      'action-read': '#8fd6c6',
      'action-edit': '#edcf8a',
      'action-command': '#c6b5ed',
      'action-web': '#8fd6c6',
      'action-agent': '#9be28f',
      'action-media': '#e8b0cb',
      'diff-add': '#9be28f',
      'diff-remove': '#f3a49c',
      focus: '#b1f39b',
      'accent-text': '#122313',
      hover: '#263c2b',
      selected: '#29402c',
      'selection-bg': '#bde8ae',
      'selection-text': '#142519',
      'selection-border': '#9be28f',
      'status-running': '#9be28f',
      'status-queued': '#edcf8a',
      'status-completed': '#a5c8ed',
      danger: '#392923',
      scene: '#10231a',
      'scene-glow': '#203a2a',
      'page-glow': '#1a3022',
    },
    {
      floor: '#213c2c',
      edge: '#3b5a41',
      dark: '#102018',
      metal: '#71997b',
      shell: '#b6d6ab',
      white: '#e8f4d8',
      mint: '#9be28f',
      cyan: '#8fd6c6',
      amber: '#edcf8a',
      red: '#f3a49c',
      dim: '#608e69',
      screen: '#0a1b13',
    },
  ),
  theme(
    'moss',
    'Moss',
    'dark',
    {
      bg: '#171c12',
      panel: '#202719',
      'panel-raised': '#2b3321',
      input: '#141a10',
      line: '#8c9874',
      text: '#f0f1df',
      muted: '#bec5a5',
      mint: '#ccdf8b',
      cyan: '#a4d4bf',
      amber: '#efd194',
      red: '#f1aca0',
      violet: '#c9bce8',
      rose: '#e4b5c8',
      accent: '#e6b673',
      link: '#b5c7f2',
      heading: '#c6d68a',
      code: '#82c9c4',
      'message-user': '#d8a7c4',
      'message-assistant': '#e6b673',
      'action-read': '#c6d68a',
      'action-edit': '#82c9c4',
      'action-command': '#e6b673',
      'action-web': '#b5c7f2',
      'action-agent': '#b5c7f2',
      'action-media': '#f1aca0',
      'diff-add': '#ccdf8b',
      'diff-remove': '#f1aca0',
      focus: '#e6b673',
      'accent-text': '#222b13',
      hover: '#343c25',
      selected: '#383e27',
      'selection-bg': '#e6c799',
      'selection-text': '#222b13',
      'selection-border': '#e6b673',
      'status-running': '#ccdf8b',
      'status-queued': '#efd194',
      'status-completed': '#82c9c4',
      danger: '#3e2d24',
      scene: '#222a19',
      'scene-glow': '#343c25',
      'page-glow': '#2b3321',
    },
    {
      floor: '#363e27',
      edge: '#56603d',
      dark: '#1b2214',
      metal: '#929d70',
      shell: '#ced6a3',
      white: '#f0f1df',
      mint: '#e6b673',
      cyan: '#82c9c4',
      amber: '#ccdf8b',
      red: '#f1aca0',
      dim: '#7b8c53',
      screen: '#141b0e',
    },
  ),
  theme(
    'kimbie-dark',
    'Kimbie Dark',
    'dark',
    {
      bg: '#221a0f',
      panel: '#2b2118',
      'panel-raised': '#362712',
      input: '#1c160d',
      line: '#a18a6b',
      text: '#e6cfb1',
      muted: '#c6ad91',
      mint: '#f0b36a',
      cyan: '#a3c2ac',
      amber: '#e8c47f',
      red: '#f09b91',
      violet: '#c8a5d8',
      rose: '#eaa6b8',
      accent: '#dc9656',
      link: '#8ab1b0',
      heading: '#d3af86',
      code: '#b8c98c',
      'message-user': '#f07970',
      'message-assistant': '#d3af86',
      'action-read': '#dc9656',
      'action-edit': '#b8c98c',
      'action-command': '#8ab1b0',
      'action-web': '#c8a5d8',
      'action-agent': '#c8a5d8',
      'action-media': '#eaa6b8',
      'diff-add': '#b8c98c',
      'diff-remove': '#f09b91',
      focus: '#dc9656',
      'accent-text': '#2b1d0e',
      hover: '#3e2d22',
      selected: '#462b24',
      'selection-bg': '#e3bb8c',
      'selection-text': '#2b1d0e',
      'selection-border': '#dc9656',
      'status-running': '#b8c98c',
      'status-queued': '#e8c47f',
      'status-completed': '#8ab1b0',
      danger: '#40251f',
      scene: '#2b2015',
      'scene-glow': '#3d2d20',
      'page-glow': '#38251c',
    },
    {
      floor: '#423021',
      edge: '#694b32',
      dark: '#221a0f',
      metal: '#a18a6b',
      shell: '#d3af86',
      white: '#f3dfc3',
      mint: '#f0b36a',
      cyan: '#a3c2ac',
      amber: '#f6c177',
      red: '#dc6958',
      dim: '#98634e',
      screen: '#18120c',
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
      accent: '#005f89',
      link: '#006b85',
      heading: '#895900',
      code: '#006b85',
      'message-user': '#6741a5',
      'message-assistant': '#895900',
      'action-read': '#006b85',
      'action-edit': '#b53027',
      'action-command': '#356600',
      'action-web': '#215ab0',
      'action-agent': '#9b2865',
      'action-media': '#6741a5',
      'diff-add': '#356600',
      'diff-remove': '#b53027',
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
    'mint-paper',
    'Mint Paper',
    'light',
    {
      bg: '#f3f8f1',
      panel: '#fbfdf8',
      'panel-raised': '#e6f0e4',
      input: '#ffffff',
      line: '#718573',
      text: '#233d30',
      muted: '#4c6253',
      mint: '#28623e',
      cyan: '#1c6268',
      amber: '#795613',
      red: '#a13d39',
      violet: '#6b4f91',
      rose: '#974569',
      accent: '#28623e',
      link: '#375f9a',
      heading: '#6b4f91',
      code: '#a13d39',
      'message-user': '#375f9a',
      'message-assistant': '#6b4f91',
      'action-read': '#28623e',
      'action-edit': '#974569',
      'action-command': '#795613',
      'action-web': '#1c6268',
      'action-agent': '#1c6268',
      'action-media': '#6b4f91',
      'diff-add': '#28623e',
      'diff-remove': '#a13d39',
      focus: '#28623e',
      'accent-text': '#ffffff',
      hover: '#dfeada',
      selected: '#dce8d8',
      'selection-bg': '#28623e',
      'selection-text': '#ffffff',
      'selection-border': '#1b4b2d',
      'status-running': '#28623e',
      'status-queued': '#795613',
      'status-completed': '#375f9a',
      danger: '#f7e6df',
      scene: '#e3eddf',
      'scene-glow': '#f3f8f1',
      'page-glow': '#e6f0e4',
    },
    {
      floor: '#d3e2ce',
      edge: '#a4bda2',
      dark: '#46624b',
      metal: '#7c9a7d',
      shell: '#e5f0dc',
      white: '#fbfdf8',
      mint: '#4f995b',
      cyan: '#378c8d',
      amber: '#b58a34',
      red: '#bd6558',
      dim: '#6c9672',
      screen: '#183c2c',
    },
  ),
  theme(
    'glacier',
    'Glacier',
    'light',
    {
      bg: '#f3f7fc',
      panel: '#fbfdff',
      'panel-raised': '#e7eef8',
      input: '#ffffff',
      line: '#74839b',
      text: '#26364e',
      muted: '#52627b',
      mint: '#285f99',
      cyan: '#146375',
      amber: '#7f5518',
      red: '#aa3b44',
      violet: '#4d39a2',
      rose: '#a02c64',
      accent: '#285f99',
      link: '#285f99',
      heading: '#4d39a2',
      code: '#a13d39',
      'message-user': '#146375',
      'message-assistant': '#4d39a2',
      'action-read': '#a02c64',
      'action-edit': '#285f99',
      'action-command': '#7f5518',
      'action-web': '#146375',
      'action-agent': '#4d39a2',
      'action-media': '#286447',
      'diff-add': '#286447',
      'diff-remove': '#aa3b44',
      focus: '#285f99',
      'accent-text': '#ffffff',
      hover: '#dfe9f5',
      selected: '#dce7f4',
      'selection-bg': '#285f99',
      'selection-text': '#ffffff',
      'selection-border': '#204c7c',
      'status-running': '#286447',
      'status-queued': '#7f5518',
      'status-completed': '#285f99',
      danger: '#f8e5e8',
      scene: '#e3edf8',
      'scene-glow': '#f3f7fc',
      'page-glow': '#e7eef8',
    },
    {
      floor: '#d0deef',
      edge: '#a3b9d2',
      dark: '#425a79',
      metal: '#7c99b8',
      shell: '#e4eefb',
      white: '#fbfdff',
      mint: '#4288ba',
      cyan: '#319bb1',
      amber: '#bf9245',
      red: '#c86878',
      dim: '#6e9bc6',
      screen: '#203a58',
    },
  ),
  theme(
    'rose-quartz',
    'Rose Quartz',
    'light',
    {
      bg: '#fcf5f3',
      panel: '#fffbf9',
      'panel-raised': '#f4e8e5',
      input: '#ffffff',
      line: '#967a7c',
      text: '#493238',
      muted: '#74585f',
      mint: '#93435f',
      cyan: '#30636d',
      amber: '#805319',
      red: '#a3363e',
      violet: '#744c93',
      rose: '#93435f',
      accent: '#93435f',
      link: '#30636d',
      heading: '#93435f',
      code: '#744c93',
      'message-user': '#9b4d16',
      'message-assistant': '#30636d',
      'action-read': '#744c93',
      'action-edit': '#9b4d16',
      'action-command': '#93435f',
      'action-web': '#346343',
      'action-agent': '#475c9b',
      'action-media': '#30636d',
      'diff-add': '#346343',
      'diff-remove': '#a3363e',
      focus: '#93435f',
      'accent-text': '#ffffff',
      hover: '#f0e0dd',
      selected: '#edddda',
      'selection-bg': '#93435f',
      'selection-text': '#ffffff',
      'selection-border': '#76354d',
      'status-running': '#346343',
      'status-queued': '#805319',
      'status-completed': '#475c9b',
      danger: '#f6e2de',
      scene: '#f1e3e0',
      'scene-glow': '#fcf5f3',
      'page-glow': '#f4e8e5',
    },
    {
      floor: '#e4ceca',
      edge: '#c9a5a3',
      dark: '#71515b',
      metal: '#b38f97',
      shell: '#f4ddd8',
      white: '#fffbf9',
      mint: '#c5708f',
      cyan: '#609ca2',
      amber: '#bf9258',
      red: '#bd5b62',
      dim: '#b47e91',
      screen: '#482c39',
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
      violet: '#ff88ff',
      rose: '#ff88ff',
      accent: '#ffff00',
      link: '#00ffff',
      heading: '#ffffff',
      code: '#99ff99',
      'message-user': '#00ffff',
      'message-assistant': '#ffff00',
      'action-read': '#99ff99',
      'action-edit': '#ffff00',
      'action-command': '#ff88ff',
      'action-web': '#00ffff',
      'action-agent': '#ffffff',
      'action-media': '#ffe3a6',
      'diff-add': '#99ff99',
      'diff-remove': '#ffb3b3',
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

// Preserve the roles controlled by palette keys in older plugin themes.
const LEGACY_ROLE_COLORS = {
  accent: 'mint',
  link: 'mint',
  heading: 'text',
  code: 'cyan',
  'message-user': 'cyan',
  'message-assistant': 'mint',
  'action-read': 'cyan',
  'action-edit': 'amber',
  'action-command': 'violet',
  'action-web': 'cyan',
  'action-agent': 'mint',
  'action-media': 'rose',
  'diff-add': 'mint',
  'diff-remove': 'red',
};

/** Merge a plugin palette with a shipped base and derive matching scene colors. */
export function pluginTheme(entry) {
  const base =
    THEMES.find(candidate => candidate.id === entry.base) ?? THEMES[0];
  const colors = {...base.colors, ...entry.colors};
  for (const [role, legacy] of Object.entries(LEGACY_ROLE_COLORS)) {
    if (entry.colors?.[role] === undefined && entry.colors?.[legacy])
      colors[role] = entry.colors[legacy];
  }
  // Markdown and usage links used cyan; conversation links used mint.
  if (entry.colors?.link === undefined && entry.colors?.cyan)
    colors.link = entry.colors.cyan;
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
