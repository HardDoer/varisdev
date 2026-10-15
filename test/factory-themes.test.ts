import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {pluginTheme, THEMES} from '../assets/dashboard/themes.js';

function luminance(hex: string) {
  const values = [1, 3, 5].map(offset => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(first: string, second: string) {
  const [low, high] = [luminance(first), luminance(second)].sort(
    (a, b) => a - b,
  );
  return (high + 0.05) / (low + 0.05);
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
    assert.deepEqual(inherited.colors, theme.colors);
  }
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
      'status-running',
      'status-queued',
      'status-completed',
    ]) {
      for (const background of surfaces) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(
          ratio >= 4.5,
          `${foreground} on ${background}: ${ratio.toFixed(2)}:1`,
        );
      }
    }
    assert.ok(contrast(colors['accent-text'], colors.mint) >= 4.5);
    assert.ok(
      contrast(colors['selection-text'], colors['selection-bg']) >= 4.5,
    );
    assert.ok(contrast(colors['selection-bg'], colors['panel-raised']) >= 3);
  });

  void test(`${theme.name} focus indicators and input borders have at least 3:1 contrast`, () => {
    const colors = theme.colors as Record<string, string>;
    for (const background of surfaces) {
      const ratio = contrast(colors.focus, colors[background]);
      assert.ok(ratio >= 3, `Focus on ${background}: ${ratio.toFixed(2)}:1`);
    }
    for (const background of ['bg', 'panel', 'panel-raised', 'input']) {
      const ratio = contrast(colors.line, colors[background]);
      assert.ok(ratio >= 3, `Border on ${background}: ${ratio.toFixed(2)}:1`);
    }
  });
}
