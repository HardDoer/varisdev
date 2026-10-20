import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {pluginTheme, THEMES} from '../assets/dashboard/themes.js';

function channels(hex: string) {
  return [1, 3, 5].map(
    offset => parseInt(hex.slice(offset, offset + 2), 16) / 255,
  );
}

function linear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const values = channels(hex).map(linear);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const [low, high] = [luminance(first), luminance(second)].sort(
    (a, b) => a - b,
  );
  return (high + 0.05) / (low + 0.05);
}

function oklab(hex: string) {
  const [red, green, blue] = channels(hex).map(linear);
  const long = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  );
  const medium = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  );
  const short = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  );
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function oklch(hex: string) {
  const [lightness, a, b] = oklab(hex);
  return {
    lightness,
    chroma: Math.hypot(a, b),
    hue: (Math.atan2(b, a) * 180) / Math.PI + 360,
  };
}

function colorDistance(first: string, second: string) {
  const firstLab = oklab(first);
  const secondLab = oklab(second);
  return Math.hypot(
    ...firstLab.map((value, index) => value - secondLab[index]),
  );
}

function hueDistance(first: string, second: string) {
  const difference = Math.abs(
    (oklch(first).hue % 360) - (oklch(second).hue % 360),
  );
  return Math.min(difference, 360 - difference);
}

function sceneHex(value: number[]) {
  return `#${value
    .map(channel =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const surfaces = [
  'bg',
  'panel',
  'panel-raised',
  'input',
  'hover',
  'selected',
  'danger',
  'scene',
  'scene-glow',
  'page-glow',
];

const actionRoles = [
  'action-read',
  'action-edit',
  'action-command',
  'action-web',
  'action-agent',
  'action-media',
];

const statuses = [
  'status-running',
  'status-queued',
  'status-completed',
  'status-failed',
  'status-cancelling',
  'status-compacting',
  'status-cancelled',
];

void test('catalog includes green, warm dark, and varied light themes with complete scene palettes', () => {
  const schemes = Object.fromEntries(
    THEMES.map(theme => [theme.id, theme.colorScheme]),
  );
  for (const id of ['forest', 'moss', 'kimbie-dark'])
    assert.equal(schemes[id], 'dark');
  for (const id of ['mint-paper', 'glacier', 'rose-quartz'])
    assert.equal(schemes[id], 'light');
  assert.equal(new Set(THEMES.map(theme => theme.id)).size, THEMES.length);
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(theme.colors), Object.keys(THEMES[0].colors));
    assert.deepEqual(
      Object.keys(theme.scenePalette),
      Object.keys(THEMES[0].scenePalette),
    );
    for (const rgb of Object.values(theme.scenePalette)) {
      assert.equal(rgb.length, 3);
      assert.ok(
        rgb.every(
          (value: number) => Number.isFinite(value) && value >= 0 && value <= 1,
        ),
      );
    }
    const inherited = pluginTheme({base: theme.id, colors: {}});
    assert.equal(inherited.colorScheme, theme.colorScheme);
    assert.equal(inherited.appearance, theme.appearance);
    assert.equal(inherited.scene, theme.scene);
    assert.deepEqual(inherited.colors, theme.colors);
    assert.deepEqual(inherited.scenePalette, theme.scenePalette);
  }
});

void test('plugin appearance and scene inherit independently and allow explicit overrides', () => {
  const retro = THEMES.find(theme => theme.id === 'year1998')!;
  assert.equal(retro.name, 'Year1998');
  assert.equal(retro.appearance, 'year1998');
  assert.equal(retro.scene, 'year1998');
  for (const theme of THEMES.filter(theme => theme.id !== retro.id)) {
    assert.equal(theme.appearance, 'default');
    assert.equal(theme.scene, 'factory');
  }
  const inherited = pluginTheme({base: retro.id, colors: {accent: '#123456'}});
  assert.equal(inherited.appearance, 'year1998');
  assert.equal(inherited.scene, 'year1998');
  const customScene = {moduleUrl: 'varisdev://theme/scene.js', apiVersion: 1};
  const custom = pluginTheme({base: retro.id, colors: {}, scene: customScene});
  assert.equal(custom.appearance, 'year1998');
  assert.deepEqual(custom.scene, customScene);
  const defaultChrome = pluginTheme({
    base: retro.id,
    colors: {},
    appearance: 'default',
  });
  assert.equal(defaultChrome.appearance, 'default');
  assert.equal(defaultChrome.scene, 'year1998');
});

void test('plugin role overrides inherit the base and take precedence over legacy palette overrides', () => {
  const base = THEMES.find(theme => theme.id === 'dracula')!;
  const plugin = pluginTheme({
    base: base.id,
    colors: {
      mint: '#abcdef',
      cyan: '#fedcba',
      accent: '#112233',
      'message-assistant': '#aabbcc',
      'status-cancelling': '#445566',
      'robot-shell': '#778899',
    },
  });
  assert.equal(plugin.colors.accent, '#112233');
  assert.equal(plugin.colors['message-assistant'], '#aabbcc');
  assert.equal(plugin.colors['action-agent'], '#abcdef');
  assert.equal(plugin.colors['robot-eyes'], '#abcdef');
  assert.equal(plugin.colors['action-read'], '#fedcba');
  assert.equal(plugin.colors.code, '#fedcba');
  assert.equal(plugin.colors.link, '#fedcba');
  assert.equal(pluginTheme({colors: {mint: '#abcdef'}}).colors.link, '#abcdef');
  assert.equal(
    pluginTheme({colors: {cyan: '#fedcba', link: '#112233'}}).colors.link,
    '#112233',
  );
  assert.equal(plugin.colors['action-command'], base.colors['action-command']);
  assert.equal(plugin.colors.heading, base.colors.heading);
  assert.deepEqual(plugin.scenePalette.mint, [171 / 255, 205 / 255, 239 / 255]);
  assert.deepEqual(plugin.scenePalette.eyes, [171 / 255, 205 / 255, 239 / 255]);
  assert.deepEqual(plugin.scenePalette.shell, [
    119 / 255,
    136 / 255,
    153 / 255,
  ]);
  assert.deepEqual(plugin.scenePalette.cancelling, [
    68 / 255,
    85 / 255,
    102 / 255,
  ]);
});

void test('shipped theme CSS matches the palette definitions', async () => {
  const css = await readFile(
    new URL('../assets/dashboard/themes.css', import.meta.url),
    'utf8',
  );
  for (const theme of THEMES) {
    const block = css.match(
      new RegExp(`:root\\[data-theme='${theme.id}'\\] \\{([^}]+)\\}`),
    )?.[1];
    assert.ok(block, `${theme.name} CSS is present`);
    const actual = Object.fromEntries(
      [...block.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6});/g)].map(match => [
        match[1],
        match[2],
      ]),
    );
    assert.deepEqual(actual, theme.colors);
    assert.ok(block.includes(`color-scheme: ${theme.colorScheme};`));
  }
});

for (const theme of THEMES) {
  void test(`${theme.name} text and status labels have at least 4.5:1 contrast`, () => {
    const colors = theme.colors as Record<string, string>;
    for (const foreground of [
      'text',
      'muted',
      'mint',
      'cyan',
      'amber',
      'red',
      'violet',
      'rose',
      'accent',
      'link',
      'heading',
      'code',
      'message-user',
      'message-assistant',
      'action-read',
      'action-edit',
      'action-command',
      'action-web',
      'action-agent',
      'action-media',
      'diff-add',
      'diff-remove',
      ...statuses,
    ]) {
      for (const background of surfaces) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(
          ratio >= 4.5,
          `${foreground} on ${background}: ${ratio.toFixed(2)}:1`,
        );
      }
    }
    assert.ok(contrast(colors['accent-text'], colors.accent) >= 4.5);
    assert.ok(
      contrast(colors['selection-text'], colors['selection-bg']) >= 4.5,
    );
    assert.ok(contrast(colors['selection-bg'], colors['panel-raised']) >= 3);
  });

  void test(`${theme.name} focus, borders, and robot materials have graphical contrast`, () => {
    const colors = theme.colors as Record<string, string>;
    for (const background of surfaces) {
      const ratio = contrast(colors.focus, colors[background]);
      assert.ok(ratio >= 3, `Focus on ${background}: ${ratio.toFixed(2)}:1`);
    }
    for (const background of ['bg', 'panel', 'panel-raised', 'input']) {
      const ratio = contrast(colors.line, colors[background]);
      assert.ok(ratio >= 3, `Border on ${background}: ${ratio.toFixed(2)}:1`);
    }
    for (const foreground of ['robot-shell', 'robot-outline']) {
      for (const background of ['panel', 'panel-raised']) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(
          ratio >= 3,
          `${foreground} on ${background}: ${ratio.toFixed(2)}:1`,
        );
      }
    }
    assert.ok(contrast(colors['robot-screen'], colors['robot-shell']) >= 3);
    assert.ok(contrast(colors['robot-eyes'], colors['robot-screen']) >= 4.5);
  });

  void test(`${theme.name} semantic colors remain perceptually distinct`, () => {
    const colors = theme.colors as Record<string, string>;
    const hue = (name: string) => oklch(colors[name]).hue % 360;
    assert.ok(hue('status-running') >= 125 && hue('status-running') <= 165);
    assert.ok(hue('status-queued') >= 70 && hue('status-queued') <= 115);
    assert.ok(hue('status-completed') >= 245 && hue('status-completed') <= 275);
    assert.ok(hue('status-failed') <= 35 || hue('status-failed') >= 350);
    assert.ok(hue('status-cancelling') >= 35 && hue('status-cancelling') <= 70);
    assert.ok(
      hue('status-compacting') >= 280 && hue('status-compacting') <= 335,
    );
    assert.ok(oklch(colors['status-cancelled']).chroma <= 0.06);
    assert.ok(
      hueDistance(colors['status-running'], colors['status-completed']) >= 80,
    );
    assert.ok(oklch(colors['status-running']).chroma >= 0.07);
    assert.ok(oklch(colors['status-completed']).chroma >= 0.07);
    assert.ok(
      hueDistance(colors['status-queued'], colors['status-cancelling']) >= 25,
    );
    assert.ok(
      colorDistance(colors['status-queued'], colors['status-cancelling']) >=
        0.075,
    );
    assert.ok(
      hueDistance(colors['status-completed'], colors['status-compacting']) >=
        30,
    );
    assert.ok(
      colorDistance(colors['status-completed'], colors['status-compacting']) >=
        0.07,
    );
    for (let first = 0; first < actionRoles.length; first++) {
      for (let second = first + 1; second < actionRoles.length; second++) {
        const distance = colorDistance(
          colors[actionRoles[first]],
          colors[actionRoles[second]],
        );
        assert.ok(
          distance >= 0.05,
          `${actionRoles[first]} and ${actionRoles[second]}: ${distance.toFixed(3)}`,
        );
      }
    }
  });

  void test(`${theme.name} scene robots, statuses, and effects remain visible`, () => {
    const colors = theme.colors as Record<string, string>;
    const scene = Object.fromEntries(
      Object.entries(theme.scenePalette).map(([key, value]) => [
        key,
        sceneHex(value),
      ]),
    );
    assert.equal(scene.shell, colors['robot-shell']);
    assert.equal(scene.outline, colors['robot-outline']);
    assert.equal(scene.screen, colors['robot-screen']);
    assert.equal(scene.eyes, colors['robot-eyes']);
    assert.ok(contrast(scene.screen, scene.shell) >= 3);
    assert.ok(contrast(scene.eyes, scene.screen) >= 4.5);
    for (const background of ['floor', 'dark', 'edge']) {
      const ratio = Math.max(
        contrast(scene.shell, scene[background]),
        contrast(scene.outline, scene[background]),
      );
      assert.ok(
        ratio >= 3,
        `Robot silhouette on ${background}: ${ratio.toFixed(2)}:1`,
      );
    }
    for (const status of statuses.map(name => name.slice('status-'.length))) {
      const ratio = contrast(scene[status], scene.screen);
      assert.ok(
        ratio >= 3,
        `${status} light on robot screen: ${ratio.toFixed(2)}:1`,
      );
    }
    for (const effect of ['mint', 'cyan', 'amber', 'red', 'violet', 'rose']) {
      const ratio = contrast(scene[effect], scene.floor);
      assert.ok(
        ratio >= 3,
        `${effect} effect on scene floor: ${ratio.toFixed(2)}:1`,
      );
    }
  });
}
