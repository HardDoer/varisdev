import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {THEMES} from '../assets/dashboard/themes.js';

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
