/* global process, __dirname, document, window, getComputedStyle, CustomEvent, Event */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');
const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
let browser;
const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
async function main() {
  await app.whenReady();
  browser = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await browser.loadFile(join(__dirname, 'plugin-themes.html'));
  assert.equal(await evaluate(() => window.ready), true);
  await evaluate(async () => {
    window.plugins = [
      {
        id: 'plugin:test:blue',
        name: '<Blue>',
        base: 'nord',
        packageName: 'test',
        colors: {mint: '#123456'},
        css: '#spacing-probe { padding: 27px; }',
      },
    ];
    window.projectPlugins = window.plugins;
    window.calls = [];
    window.pidev = {
      appThemes: async id => {
        window.calls.push(id);
        return {themes: window.plugins, errors: []};
      },
    };
    window.localStorage.setItem('varisdev.factory.theme', 'plugin:test:blue');
    window.pidev.appThemes = id =>
      new Promise(resolve => {
        window.resolveThemes = resolve;
        window.calls.push(id);
      });
    window.cleanup = window.initThemes(palette => {
      window.palette = palette;
    });
  });
  assert.equal(
    await evaluate(() => window.localStorage.getItem('varisdev.factory.theme')),
    'plugin:test:blue',
  );
  await evaluate(async () => {
    window.resolveThemes({themes: [], errors: []});
    await Promise.resolve();
  });
  assert.deepEqual(
    await evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      preferred: window.localStorage.getItem('varisdev.factory.theme'),
      hasStyle: !!document.getElementById('plugin-theme-style'),
    })),
    {theme: 'factory', preferred: 'plugin:test:blue', hasStyle: false},
  );
  await evaluate(async () => {
    window.pidev.appThemes = async id => {
      window.calls.push(id);
      return {
        themes: id === 'project-a' ? window.projectPlugins : [],
        errors: [],
      };
    };
    await window.cleanup.refresh('project-a');
  });
  assert.deepEqual(
    await evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mint: getComputedStyle(document.documentElement)
        .getPropertyValue('--mint')
        .trim(),
      spacing: getComputedStyle(document.getElementById('spacing-probe'))
        .padding,
      name: document.querySelector('option[value="plugin:test:blue"]')
        .textContent,
      palette: window.palette.mint,
      errorHidden: document.getElementById('plugin-theme-errors').hidden,
    })),
    {
      theme: 'plugin:test:blue',
      mint: '#123456',
      spacing: '27px',
      name: '<Blue> · test',
      palette: [18 / 255, 52 / 255, 86 / 255],
      errorHidden: true,
    },
  );
  report.cases.push(
    'empty startup catalog preserves preference until project themes arrive',
  );
  await evaluate(async () => {
    await window.cleanup.refresh('project-b');
  });
  assert.deepEqual(
    await evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      preferred: window.localStorage.getItem('varisdev.factory.theme'),
      hasStyle: !!document.getElementById('plugin-theme-style'),
      spacing: getComputedStyle(document.getElementById('spacing-probe'))
        .padding,
    })),
    {
      theme: 'factory',
      preferred: 'plugin:test:blue',
      hasStyle: false,
      spacing: '0px',
    },
  );
  await evaluate(async () => {
    await window.cleanup.refresh('project-a');
  });
  assert.deepEqual(
    await evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      preferred: window.localStorage.getItem('varisdev.factory.theme'),
      spacing: getComputedStyle(document.getElementById('spacing-probe'))
        .padding,
    })),
    {theme: 'plugin:test:blue', preferred: 'plugin:test:blue', spacing: '27px'},
  );
  report.cases.push('project A to B to A restores preferred theme and CSS');
  await evaluate(async () => {
    window.pidev.appThemes = async id => {
      window.calls.push(id);
      return {themes: window.plugins, errors: []};
    };
    const select = document.getElementById('factory-theme');
    select.value = 'factory';
    select.dispatchEvent(new Event('change'));
  });
  assert.equal(
    await evaluate(() => document.getElementById('plugin-theme-style')),
    null,
  );
  assert.equal(
    await evaluate(() => window.localStorage.getItem('varisdev.factory.theme')),
    'factory',
  );
  await evaluate(() => {
    const select = document.getElementById('factory-theme');
    select.value = 'plugin:test:blue';
    select.dispatchEvent(new Event('change'));
  });
  await evaluate(async () => {
    window.cleanup();
    window.cleanup = window.initThemes();
    await window.cleanup.refresh('project');
  });
  assert.equal(
    await evaluate(() => document.documentElement.dataset.theme),
    'plugin:test:blue',
  );
  assert.equal(
    await evaluate(
      () => document.querySelectorAll('#plugin-theme-style').length,
    ),
    1,
  );
  report.cases.push('select, persist, dispose and reload');
  await evaluate(async () => {
    document
      .getElementById('app-menu-panel')
      .dispatchEvent(new CustomEvent('varisdev:app-menu-open'));
    await Promise.resolve();
  });
  assert.equal(await evaluate(() => window.calls.at(-1)), 'project');
  await evaluate(async () => {
    await window.cleanup.refresh(undefined);
  });
  assert.equal(await evaluate(() => window.calls.at(-1)), undefined);
  report.cases.push(
    'menu remembers project scope and welcome restores global scope',
  );
  await evaluate(async () => {
    window.plugins = [];
    await window.cleanup.refresh();
  });
  assert.equal(
    await evaluate(() => document.documentElement.dataset.theme),
    'factory',
  );
  assert.equal(
    await evaluate(() => window.localStorage.getItem('varisdev.factory.theme')),
    'plugin:test:blue',
  );
  assert.equal(
    await evaluate(() => document.getElementById('plugin-theme-style')),
    null,
  );
  assert.equal(
    await evaluate(
      () => getComputedStyle(document.getElementById('spacing-probe')).padding,
    ),
    '0px',
  );
  await evaluate(async () => {
    window.plugins = window.projectPlugins;
    await window.cleanup.refresh();
  });
  assert.equal(
    await evaluate(() => document.documentElement.dataset.theme),
    'plugin:test:blue',
  );
  await evaluate(async () => {
    window.plugins = [];
    await window.cleanup.refresh();
    const select = document.getElementById('factory-theme');
    select.value = 'nord';
    select.dispatchEvent(new Event('change'));
    window.plugins = window.projectPlugins;
    await window.cleanup.refresh();
  });
  assert.deepEqual(
    await evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      preferred: window.localStorage.getItem('varisdev.factory.theme'),
      hasStyle: !!document.getElementById('plugin-theme-style'),
    })),
    {theme: 'nord', preferred: 'nord', hasStyle: false},
  );
  report.cases.push(
    'removal clears CSS, reinstall restores theme, and explicit choice replaces preference',
  );
  await evaluate(async () => {
    window.pidev.appThemes = async () => ({
      themes: [],
      errors: ['<Broken theme>'],
    });
    await window.cleanup.refresh();
  });
  assert.deepEqual(
    await evaluate(() => ({
      hidden: document.getElementById('plugin-theme-errors').hidden,
      text: document.querySelector('#plugin-theme-errors li').textContent,
    })),
    {hidden: false, text: '<Broken theme>'},
  );
  // A late response from the previous project must not replace the newest selection.
  await evaluate(async () => {
    const resolves = [];
    window.pidev.appThemes = () =>
      new Promise(resolve => resolves.push(resolve));
    const first = window.cleanup.refresh('first');
    const second = window.cleanup.refresh('second');
    resolves[1]({themes: window.plugins, errors: []});
    await second;
    resolves[0]({
      themes: [
        {
          id: 'plugin:old:old',
          name: 'Old',
          base: 'factory',
          packageName: 'old',
          colors: {},
        },
      ],
      errors: [],
    });
    await first;
  });
  assert.equal(
    await evaluate(
      () => !!document.querySelector('option[value="plugin:old:old"]'),
    ),
    false,
  );
  report.cases.push('diagnostics and concurrent project refresh');

  const stylesheet = join(directory, 'plugin-theme.css');
  writeFileSync(stylesheet, '#spacing-probe { padding: 31px; }');
  await evaluate(async stylesheetUrl => {
    window.cleanup();
    window.themeErrors = [];
    window.plugins = [
      {
        id: 'plugin:test:retro',
        name: 'Retro plugin',
        base: 'year1998',
        packageName: 'test',
        colors: {mint: '#123456'},
        stylesheetUrl,
        css: '#spacing-probe { padding: 77px; }',
      },
    ];
    window.pidev.appThemes = async () => ({
      themes: window.plugins,
      errors: window.themeErrors,
    });
    window.localStorage.setItem('varisdev.factory.theme', 'plugin:test:retro');
    window.cleanup = window.initThemes(
      (palette, entry) => {
        window.palette = palette;
        window.themeEntry = entry;
      },
      {deferDiscovery: true},
    );
    await window.cleanup.refresh();
    const link = document.getElementById('plugin-theme-style');
    if (!link.sheet)
      await new Promise((resolve, reject) => {
        link.addEventListener('load', resolve, {once: true});
        link.addEventListener(
          'error',
          () => reject(new Error('Stylesheet failed to load')),
          {once: true},
        );
      });
  }, pathToFileURL(stylesheet).href);
  assert.deepEqual(
    await evaluate(() => ({
      appearance: document.documentElement.dataset.appearance,
      entry: window.themeEntry.id,
      scene: window.themeEntry.scene,
      tag: document.getElementById('plugin-theme-style').tagName,
      hasPalette: !!document.getElementById('plugin-theme-palette'),
      mint: getComputedStyle(document.documentElement)
        .getPropertyValue('--mint')
        .trim(),
      spacing: getComputedStyle(document.getElementById('spacing-probe'))
        .padding,
      palette: window.palette.mint,
    })),
    {
      appearance: 'year1998',
      entry: 'plugin:test:retro',
      scene: 'year1998',
      tag: 'LINK',
      hasPalette: true,
      mint: '#123456',
      spacing: '31px',
      palette: [18 / 255, 52 / 255, 86 / 255],
    },
  );
  report.cases.push(
    'plugin links preserve palette overrides and inherit appearance and scene',
  );

  await evaluate(async () => {
    window.cleanup.reportSceneError('Scene module failed');
    window.themeErrors = ['Discovery failed'];
    await window.cleanup.refresh();
  });
  assert.deepEqual(
    await evaluate(() =>
      Array.from(
        document.querySelectorAll('#plugin-theme-errors li'),
        item => item.textContent,
      ),
    ),
    ['Discovery failed', 'Scene module failed'],
  );
  await evaluate(async () => {
    window.themeErrors = [];
    await window.cleanup.refresh();
  });
  assert.deepEqual(
    await evaluate(() =>
      Array.from(
        document.querySelectorAll('#plugin-theme-errors li'),
        item => item.textContent,
      ),
    ),
    ['Scene module failed'],
  );
  await evaluate(() => window.cleanup.reportSceneError(''));
  assert.equal(
    await evaluate(() => document.getElementById('plugin-theme-errors').hidden),
    true,
  );
  report.cases.push(
    'scene diagnostics survive same-theme refresh and clear independently',
  );

  await evaluate(() => {
    const select = document.getElementById('factory-theme');
    select.value = 'factory';
    select.dispatchEvent(new Event('change'));
  });
  assert.deepEqual(
    await evaluate(() => ({
      appearance: document.documentElement.dataset.appearance,
      hasStyle: !!document.getElementById('plugin-theme-style'),
      hasPalette: !!document.getElementById('plugin-theme-palette'),
      spacing: getComputedStyle(document.getElementById('spacing-probe'))
        .padding,
    })),
    {appearance: 'default', hasStyle: false, hasPalette: false, spacing: '0px'},
  );
  await evaluate(async () => {
    const select = document.getElementById('factory-theme');
    select.value = 'plugin:test:retro';
    select.dispatchEvent(new Event('change'));
    window.cleanup();
    window.cleanup.reportSceneError('Ignored after dispose');
  });
  assert.deepEqual(
    await evaluate(() => ({
      hasStyle: !!document.getElementById('plugin-theme-style'),
      hasPalette: !!document.getElementById('plugin-theme-palette'),
      hasDiagnostics: !!document.getElementById('plugin-theme-errors'),
    })),
    {hasStyle: false, hasPalette: false, hasDiagnostics: false},
  );
  report.cases.push(
    'switching and disposal remove linked styles and palette overrides',
  );
}
main()
  .catch(error => {
    report.error = error.stack || String(error);
  })
  .finally(() => {
    writeFileSync(reportPath, JSON.stringify(report));
    browser?.destroy();
    app.exit(report.error ? 1 : 0);
  });
