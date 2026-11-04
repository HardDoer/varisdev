/* global process, __dirname, document, window, Event, getComputedStyle, setTimeout */
const assert = require('node:assert/strict');
const {mkdirSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow, ipcMain} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const screenshotDirectory = process.env.VARISDEV_WHATS_NEW_SCREENSHOTS;
const version = '1.11.0';
const report = {cases: [], rendererErrors: [], themes: [], layouts: []};
const marks = [];
let browser;
let DesktopPreferences;
let DesktopWhatsNew;
let preferences;
let whatsNew;
let profile;
let getGate;
let getFailure = false;
let extraChanges = [];
let reads = 0;
const at = new Date().toISOString();
const hub = {
  sessions: [
    {
      session: {
        id: 'project',
        name: 'Project',
        cwd: directory,
        status: 'idle',
        activity: 'Ready',
        startedAt: at,
        updatedAt: at,
        owned: true,
        controllable: true,
      },
      agents: [],
      totalAgents: 0,
      events: [],
      changes: [],
      conversation: [],
      conversationTruncated: false,
      queue: {steering: [], followUp: []},
    },
  ],
  selectedSessionId: 'project',
  launchCwd: directory,
};
app.setPath('userData', join(directory, 'profile'));
app.setPath('sessionData', join(directory, 'session'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const evaluate = (fn, arg) =>
  browser.webContents.executeJavaScript(
    `(${fn.toString()})(${JSON.stringify(arg)})`,
  );
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  await evaluate(
    () =>
      new Promise(resolve =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(resolve),
        ),
      ),
  );
}
async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await evaluate(fn)) return;
    await delay(20);
  }
  const state = await evaluate(() => ({
    ready: document.readyState,
    hidden: document.hidden,
    error: document.getElementById('app-error')?.textContent,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(
      item => item.id,
    ),
    notes: document.getElementById('whats-new-changes')?.textContent,
    status: document.getElementById('whats-new-status')?.textContent,
    preferenceError: document.getElementById('whats-new-error')?.textContent,
  }));
  throw new Error(
    `Timed out during ${report.activeCase}: ${fn}\n${JSON.stringify(state)}\n${report.rendererErrors.join('\n')}`,
  );
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert.equal(event.sender, browser.webContents);
    try {
      return {ok: true, value: await action(...args)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });
}
function holdGet() {
  let release;
  getGate = new Promise(resolve => {
    release = resolve;
  });
  return () => {
    getGate = undefined;
    release();
  };
}
function useProfile(name, runningVersion = version, seenVersion) {
  profile = join(directory, name);
  mkdirSync(profile, {recursive: true});
  preferences = new DesktopPreferences(profile);
  if (seenVersion) preferences.markWhatsNewSeen(seenVersion);
  whatsNew = new DesktopWhatsNew(preferences, runningVersion);
  extraChanges = [];
  getFailure = false;
}
function persistedSeen(runningVersion = version) {
  return new DesktopWhatsNew(
    new DesktopPreferences(profile),
    runningVersion,
  ).get().seen;
}
async function click(id) {
  await evaluate(id => document.getElementById(id).click(), id);
}
async function key(keyCode) {
  browser.focus();
  browser.webContents.focus();
  browser.webContents.sendInputEvent({type: 'keyDown', keyCode});
  browser.webContents.sendInputEvent({type: 'keyUp', keyCode});
}
async function menu() {
  await evaluate(() => document.getElementById('app-menu-button').focus());
  await key('Space');
  await waitFor(() =>
    document.getElementById('app-menu-panel').matches(':popover-open'),
  );
}
async function open() {
  await menu();
  await click('open-whats-new');
  await waitFor(() => document.getElementById('whats-new-dialog').open);
  assert.equal(
    await evaluate(() =>
      document.getElementById('app-menu-panel').matches(':popover-open'),
    ),
    false,
  );
}
async function close() {
  await click('whats-new-close');
  await waitFor(() => !document.getElementById('whats-new-dialog').open);
}
async function reload(welcome = false) {
  const loaded = new Promise(resolve =>
    browser.webContents.once('did-finish-load', resolve),
  );
  browser.reload();
  await loaded;
  await waitFor(
    welcome
      ? () => !document.getElementById('welcome').hidden
      : () => !document.getElementById('factory-workspace').hidden,
  );
}
async function notesLoaded() {
  await waitFor(
    () => document.getElementById('whats-new-changes').children.length > 0,
  );
}
async function shownAndSaved() {
  await waitFor(
    () =>
      document.getElementById('whats-new-dialog').open &&
      !document.getElementById('whats-new-retry').disabled,
  );
  assert.equal(whatsNew.get().seen, true);
  assert.equal(
    persistedSeen(),
    true,
    'showing the notes saves the version to the profile',
  );
}
async function assertDeferred() {
  await notesLoaded();
  await delay(80);
  assert.equal(
    await evaluate(() => document.getElementById('whats-new-dialog').open),
    false,
  );
  assert.equal(whatsNew.get().seen, false);
  assert.equal(persistedSeen(), false, 'deferred notes are not marked seen');
}
async function scenario(name, action) {
  report.activeCase = name;
  await action();
  report.cases.push(name);
  delete report.activeCase;
}
async function capture(name) {
  if (!screenshotDirectory) return;
  mkdirSync(screenshotDirectory, {recursive: true});
  await settle();
  writeFileSync(
    join(screenshotDirectory, `${name}.png`),
    (await browser.webContents.capturePage()).toPNG(),
  );
}
async function select(id, value) {
  await evaluate(
    ({id, value}) => {
      const control = document.getElementById(id);
      control.scrollIntoView({block: 'nearest'});
      control.value = String(value);
      control.dispatchEvent(new Event('change', {bubbles: true}));
    },
    {id, value},
  );
}
async function assertLayout(label) {
  await settle();
  const geometry = await evaluate(() => {
    const dialog = document.getElementById('whats-new-dialog');
    const content = dialog.querySelector('.whats-new-content');
    const inside = (inner, outer) =>
      inner.left >= outer.left - 1 &&
      inner.top >= outer.top - 1 &&
      inner.right <= outer.right + 1 &&
      inner.bottom <= outer.bottom + 1;
    const viewport = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
    const rect = dialog.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const visible = id => {
      const element = document.getElementById(id);
      const bounds = element.getBoundingClientRect();
      return (
        element.checkVisibility() &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        inside(bounds, rect) &&
        inside(bounds, viewport)
      );
    };
    return {
      fits: inside(rect, viewport),
      titleVisible: visible('whats-new-title'),
      versionVisible: visible('whats-new-version'),
      closeVisible: visible('whats-new-close'),
      closeEnabled: !document.getElementById('whats-new-close').disabled,
      contentFits: contentRect.height >= 24 && inside(contentRect, rect),
      noHorizontalScroll:
        dialog.scrollWidth <= dialog.clientWidth + 1 &&
        content.scrollWidth <= content.clientWidth + 1,
      noPageScroll:
        document.documentElement.scrollHeight <= window.innerHeight + 1 &&
        document.documentElement.scrollWidth <= window.innerWidth + 1,
      internalOverflow: ['auto', 'scroll'].includes(
        getComputedStyle(content).overflowY,
      ),
    };
  });
  for (const [check, passed] of Object.entries(geometry))
    assert.equal(
      passed,
      true,
      `${label}: ${check}: ${JSON.stringify(geometry)}`,
    );
}
async function main() {
  ({DesktopPreferences} = await import(
    pathToFileURL(
      resolve(__dirname, '../../desktop/build/src/desktop/preferences.js'),
    ).href
  ));
  ({DesktopWhatsNew} = await import(
    pathToFileURL(
      resolve(__dirname, '../../desktop/build/src/desktop/whats-new.js'),
    ).href
  ));
  useProfile('profile');
  const release = whatsNew.get().release;
  assert.equal(release.version, version);
  assert.ok(release.changes.length > 0);
  assert.ok(
    release.changes.every(
      change => typeof change === 'string' && change.trim(),
    ),
  );
  const firstGet = holdGet();
  await app.whenReady();
  browser = new BrowserWindow({
    show: true,
    useContentSize: true,
    width: 1100,
    height: 760,
    webPreferences: {
      preload: resolve(__dirname, '../../assets/desktop/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  browser.webContents.on('console-message', details => {
    if (details.level === 'error') report.rendererErrors.push(details.message);
  });
  handle('pidev:get-state', () => hub);
  handle('pidev:recent-projects', () => []);
  handle('varisdev:app-themes', () => ({themes: [], errors: []}));
  handle('varisdev:get-agent-notice', () => ({acknowledged: true}));
  handle('varisdev:get-update-status', () => ({
    phase: 'idle',
    currentVersion: version,
    restartRequired: false,
  }));
  handle('pidev:session-features', () => ({
    commands: [],
    tools: [],
    models: [],
    diagnostics: [],
    thinkingLevel: 'off',
    thinkingLevels: ['off'],
  }));
  handle('varisdev:get-whats-new', async () => {
    reads++;
    await getGate;
    if (getFailure) throw new Error('Release notes unavailable');
    const state = whatsNew.get();
    if (state.release && extraChanges.length)
      state.release.changes.push(...extraChanges);
    return state;
  });
  handle('varisdev:mark-whats-new-seen', async requestedVersion => {
    const open = await evaluate(
      () => document.getElementById('whats-new-dialog').open,
    );
    marks.push({version: requestedVersion, open});
    assert.equal(
      open,
      true,
      'the preference is only saved once the modal is shown',
    );
    return whatsNew.markSeen(requestedVersion);
  });

  await scenario(
    'first launch shows the current version and bullet list and persists when shown',
    async () => {
      await browser.loadFile(
        resolve(__dirname, '../../assets/dashboard/index.html'),
      );
      await waitFor(() => !document.getElementById('factory-workspace').hidden);
      assert.equal(whatsNew.get().seen, false);
      firstGet();
      await shownAndSaved();
      const content = await evaluate(() => ({
        title: document.getElementById('whats-new-title').textContent.trim(),
        version: document
          .getElementById('whats-new-version')
          .textContent.trim(),
        listTag: document.getElementById('whats-new-changes').tagName,
        changes: [...document.querySelectorAll('#whats-new-changes > li')].map(
          item => item.textContent,
        ),
        bullets: [
          ...document.querySelectorAll('#whats-new-changes > li'),
        ].every(item => getComputedStyle(item).display === 'list-item'),
        focus: document.activeElement.id,
      }));
      assert.deepEqual(content, {
        title: 'What’s new',
        version: `VarisDev ${version}`,
        listTag: 'UL',
        changes: release.changes,
        bullets: true,
        focus: 'whats-new-close',
      });
      assert.deepEqual(marks, [{version, open: true}]);
      assert.equal(
        JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
          .lastSeenReleaseVersion,
        version,
      );
      await close();
    },
  );

  await scenario(
    'close, renderer reload and a new preferences instance do not repeat the notes',
    async () => {
      const before = marks.length;
      await reload();
      await notesLoaded();
      await delay(80);
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
      preferences = new DesktopPreferences(profile);
      whatsNew = new DesktopWhatsNew(preferences, version);
      await reload();
      await notesLoaded();
      await delay(80);
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
      assert.equal(marks.length, before);
      assert.equal(persistedSeen(), true);
    },
  );

  await scenario(
    'Menu opens the notes manually and Escape returns focus to Menu',
    async () => {
      const before = marks.length;
      await open();
      assert.equal(
        await evaluate(() => document.activeElement.id),
        'whats-new-close',
      );
      await key('Escape');
      await waitFor(() => !document.getElementById('whats-new-dialog').open);
      await waitFor(() => document.activeElement.id === 'app-menu-button');
      assert.equal(
        marks.length,
        before,
        'reopening already seen notes does not rewrite preferences',
      );
    },
  );

  await scenario(
    'an older saved version shows the new release automatically',
    async () => {
      useProfile('older-version', version, '1.10.2');
      assert.equal(persistedSeen(), false);
      await reload();
      await shownAndSaved();
      assert.equal(
        JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
          .lastSeenReleaseVersion,
        version,
      );
      await close();
    },
  );

  await scenario(
    'pending startup defers automatic display and saving',
    async () => {
      useProfile('pending-startup');
      hub.startup = {
        id: 'starting',
        name: 'Starting project',
        ui: {dialogs: [], notifications: [], statuses: []},
      };
      const releaseGet = holdGet();
      await reload();
      releaseGet();
      await assertDeferred();
      delete hub.startup;
      browser.webContents.send('pidev:snapshot', hub);
      await shownAndSaved();
      await close();
    },
  );

  await scenario(
    'a delayed response waits for another dialog and an open menu to close',
    async () => {
      useProfile('pending-dialog');
      const sessions = hub.sessions;
      const before = marks.length;
      hub.sessions = [];
      hub.selectedSessionId = undefined;
      let releaseGet = holdGet();
      await reload(true);
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
      assert.equal(marks.length, before);
      hub.startup = {
        id: 'launching',
        name: 'Opening project',
        ui: {dialogs: [], notifications: [], statuses: []},
      };
      browser.webContents.send('pidev:snapshot', hub);
      await settle();
      await menu();
      await click('open-about');
      await waitFor(() => document.getElementById('about-dialog').open);
      hub.sessions = sessions;
      hub.selectedSessionId = 'project';
      delete hub.startup;
      browser.webContents.send('pidev:snapshot', hub);
      await waitFor(() => !document.getElementById('factory-workspace').hidden);
      assert.equal(
        await evaluate(
          () => document.getElementById('whats-new-status').textContent,
        ),
        'Loading release notes…',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('whats-new-changes').children.length,
        ),
        0,
      );
      assert.equal(
        marks.length,
        before,
        'startup and its dialog do not save before the response',
      );
      releaseGet();
      await assertDeferred();
      await click('about-close');
      await shownAndSaved();
      await close();

      useProfile('pending-popover');
      releaseGet = holdGet();
      await reload();
      await menu();
      releaseGet();
      await assertDeferred();
      await key('Escape');
      await shownAndSaved();
      await close();
    },
  );

  await scenario('a hidden window waits until it becomes visible', async () => {
    useProfile('hidden-window');
    const releaseGet = holdGet();
    await reload();
    // Electron keeps document.hidden false when background throttling is disabled.
    browser.webContents.setBackgroundThrottling(true);
    browser.hide();
    await waitFor(() => document.hidden);
    releaseGet();
    await assertDeferred();
    browser.show();
    await shownAndSaved();
    browser.webContents.setBackgroundThrottling(false);
    await close();
  });

  await scenario(
    'manually opened notes that load while hidden are saved only when visible',
    async () => {
      useProfile('manual-hidden-window');
      const releaseGet = holdGet();
      await reload();
      await open();
      assert.equal(
        await evaluate(
          () => document.getElementById('whats-new-status').textContent,
        ),
        'Loading release notes…',
      );
      const before = marks.length;
      browser.webContents.setBackgroundThrottling(true);
      browser.hide();
      await waitFor(() => document.hidden);
      releaseGet();
      await notesLoaded();
      assert.equal(whatsNew.get().seen, false);
      assert.equal(persistedSeen(), false);
      assert.equal(marks.length, before);
      browser.show();
      await waitFor(() => !document.hidden);
      await shownAndSaved();
      assert.equal(marks.length, before + 1);
      browser.webContents.setBackgroundThrottling(false);
      await close();
    },
  );

  await scenario(
    'a real preference write failure offers Retry and still allows closing',
    async () => {
      useProfile('save-failure');
      const settingsPath = join(profile, 'settings.json');
      mkdirSync(settingsPath);
      await reload();
      await waitFor(
        () =>
          document.getElementById('whats-new-dialog').open &&
          !document.getElementById('whats-new-error').hidden &&
          !document.getElementById('whats-new-retry').disabled,
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('whats-new-error').textContent,
        ),
        'Could not save your preference. These notes may appear again next time.',
      );
      assert.equal(
        await evaluate(
          () => document.getElementById('whats-new-close').disabled,
        ),
        false,
      );
      assert.equal(persistedSeen(), false);
      await capture('save-failure');
      await close();
      await open();
      await waitFor(
        () =>
          !document.getElementById('whats-new-error').hidden &&
          !document.getElementById('whats-new-retry').disabled,
      );
      rmSync(settingsPath, {recursive: true});
      const before = marks.length;
      await click('whats-new-retry');
      await shownAndSaved();
      assert.equal(marks.length, before + 1);
      assert.equal(
        await evaluate(
          () =>
            document.getElementById('whats-new-error').hidden &&
            document.getElementById('whats-new-retry').hidden,
        ),
        true,
      );
      await close();
      whatsNew = new DesktopWhatsNew(new DesktopPreferences(profile), version);
      await reload();
      await notesLoaded();
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
    },
  );

  await scenario(
    'an unknown version stays quiet and manual opening explains missing notes',
    async () => {
      useProfile('unknown-version', '9.9.9');
      const before = marks.length;
      await reload();
      await waitFor(
        () =>
          document.getElementById('whats-new-status').textContent ===
          'No release notes are available for this version.',
      );
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
      await open();
      assert.deepEqual(
        await evaluate(() => ({
          message: document.getElementById('whats-new-status').textContent,
          visible: document
            .getElementById('whats-new-status')
            .checkVisibility(),
          version: document.getElementById('whats-new-version').textContent,
          changes: document.getElementById('whats-new-changes').children.length,
        })),
        {
          message: 'No release notes are available for this version.',
          visible: true,
          version: '',
          changes: 0,
        },
      );
      await capture('unknown-version');
      await key('Escape');
      await waitFor(() => !document.getElementById('whats-new-dialog').open);
      assert.equal(marks.length, before);
    },
  );

  await scenario(
    'a load failure stays quiet until manual opening and Retry loads and saves',
    async () => {
      useProfile('load-failure');
      getFailure = true;
      await reload();
      await waitFor(
        () =>
          document.getElementById('whats-new-error').textContent ===
          'Could not load release notes.',
      );
      assert.equal(
        await evaluate(() => document.getElementById('whats-new-dialog').open),
        false,
      );
      await open();
      await waitFor(
        () =>
          !document.getElementById('whats-new-error').hidden &&
          !document.getElementById('whats-new-retry').disabled,
      );
      assert.equal(persistedSeen(), false);
      getFailure = false;
      const before = reads;
      await click('whats-new-retry');
      await shownAndSaved();
      assert.equal(reads, before + 1);
      await notesLoaded();
      await close();
    },
  );

  await scenario(
    'all shipped themes fit normal and compact windows and long notes scroll inside the dialog',
    async () => {
      report.themes = await evaluate(() =>
        [...document.getElementById('factory-theme').options].map(
          option => option.value,
        ),
      );
      assert.ok(report.themes.length > 1);
      const layouts = [
        {width: 1100, height: 760, zoom: 1},
        {width: 1100, height: 760, zoom: 1.25},
        {width: 1100, height: 760, zoom: 2},
        {width: 800, height: 600, zoom: 1.25},
        {width: 800, height: 600, zoom: 2},
      ];
      for (const layout of layouts) {
        browser.setContentSize(layout.width, layout.height);
        for (const theme of report.themes) {
          await menu();
          await select('app-zoom', layout.zoom);
          await select('factory-theme', theme);
          await settle();
          assert.equal(
            await evaluate(() => window.pidev.getZoom()),
            layout.zoom,
          );
          assert.equal(
            await evaluate(() => document.documentElement.dataset.theme),
            theme,
          );
          await click('open-whats-new');
          await waitFor(() => document.getElementById('whats-new-dialog').open);
          const label = `${theme}-${layout.width}x${layout.height}-${Math.round(layout.zoom * 100)}`;
          await assertLayout(label);
          assert.deepEqual(
            await evaluate(() =>
              [...document.querySelectorAll('#whats-new-changes > li')].map(
                item => item.textContent,
              ),
            ),
            release.changes,
          );
          await capture(label);
          report.layouts.push({theme, ...layout});
          await close();
        }
      }

      extraChanges = Array.from(
        {length: 40},
        (_, index) =>
          `Additional release note ${index + 1}: Long release notes remain readable and can be scrolled without moving the heading or Close button. ${'A'.repeat(90)}`,
      );
      await reload();
      await notesLoaded();
      for (const layout of [layouts[0], layouts[3], layouts[4]]) {
        browser.setContentSize(layout.width, layout.height);
        await menu();
        await select('app-zoom', layout.zoom);
        await select('factory-theme', 'factory');
        await click('open-whats-new');
        await waitFor(() => document.getElementById('whats-new-dialog').open);
        const label = `long-notes-${layout.width}x${layout.height}-${Math.round(layout.zoom * 100)}`;
        await assertLayout(label);
        assert.equal(
          await evaluate(
            () => document.getElementById('whats-new-changes').children.length,
          ),
          release.changes.length + extraChanges.length,
        );
        assert.equal(
          await evaluate(() => {
            const content = document.querySelector(
              '#whats-new-dialog .whats-new-content',
            );
            return content.scrollHeight > content.clientHeight;
          }),
          true,
        );
        await evaluate(() => {
          document.querySelector(
            '#whats-new-dialog .whats-new-content',
          ).scrollTop = 0;
        });
        await capture(`${label}-top`);
        const closeBefore = await evaluate(() => {
          const rect = document
            .getElementById('whats-new-close')
            .getBoundingClientRect();
          return {top: rect.top, bottom: rect.bottom};
        });
        await evaluate(() =>
          document
            .querySelector('#whats-new-dialog .whats-new-content')
            .focus(),
        );
        await key('End');
        await waitFor(() => {
          const content = document.querySelector(
            '#whats-new-dialog .whats-new-content',
          );
          const last = document
            .querySelector('#whats-new-changes > li:last-child')
            .getBoundingClientRect();
          const bounds = content.getBoundingClientRect();
          return (
            content.scrollTop > 0 &&
            last.bottom <= bounds.bottom + 1 &&
            last.bottom > bounds.top
          );
        });
        assert.deepEqual(
          await evaluate(() => {
            const rect = document
              .getElementById('whats-new-close')
              .getBoundingClientRect();
            return {top: rect.top, bottom: rect.bottom};
          }),
          closeBefore,
          'scrolling the release notes keeps Close in place',
        );
        await assertLayout(label);
        await capture(`${label}-bottom`);
        await key('Escape');
        await waitFor(() => !document.getElementById('whats-new-dialog').open);
        await waitFor(() => document.activeElement.id === 'app-menu-button');
      }
    },
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
