/* global process, console */
const assert = require('node:assert/strict');
const {writeFileSync} = require('node:fs');
const {once} = require('node:events');
const {registerHooks} = require('node:module');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {app} = require('electron');

const [directory, reportPath] = process.argv.slice(2);
const report = {cases: []};
const stage = value => {
  report.stage = value;
  writeFileSync(reportPath, JSON.stringify(report));
};
stage('main import');
const hooks = registerHooks({
  load(url, context, next) {
    if (/\/@earendil-works\/pi-coding-agent\/dist\/index\.js$/.test(url))
      throw new Error('The overview loaded the session SDK.');
    return next(url, context);
  },
});
process.argv.push('--varisdev-launcher');

const finished = new Promise((resolve, reject) => {
  app.once('browser-window-created', (_event, browser) => {
    stage('window creation');
    if (process.platform === 'win32') {
      // The process runner's SW_HIDE overrides the first native show call.
      // Consume it before the application's ready-to-show callback runs.
      browser.once('ready-to-show', () => {
        browser.showInactive();
        browser.hide();
      });
    }
    browser.webContents.once('did-finish-load', async () => {
      try {
        stage('window show');
        if (!browser.isVisible()) await once(browser, 'show');
        assert.equal(browser.isVisible(), true);
        stage('overview state');
        const overview = await browser.webContents.executeJavaScript(
          'window.pidev.getState()',
        );
        assert.deepEqual(overview.sessions, []);
        stage('theme discovery');
        const themes = await browser.webContents.executeJavaScript(
          'window.pidev.appThemes()',
        );
        assert.deepEqual(themes.errors, []);
        assert.ok(
          themes.themes.some(theme => theme.id === 'plugin:boot-theme:boot'),
        );
        report.cases.push(
          'visible overview and installed themes without session SDK',
        );
        hooks.deregister();
        stage('workspace creation');
        const project = join(directory, 'project');
        const created = await browser.webContents.executeJavaScript(
          `window.pidev.createSession({cwd: ${JSON.stringify(project)}})`,
        );
        const active = await browser.webContents.executeJavaScript(
          'window.pidev.getState()',
        );
        assert.equal(active.sessions.length, 1);
        assert.equal(active.sessions[0].session.id, created.id);
        assert.equal(active.sessions[0].session.cwd, project);
        assert.equal(active.sessions[0].session.controllable, true);
        report.cases.push('open workspace after deferred session SDK load');
        stage('shutdown');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});

(async () => {
  await import(
    pathToFileURL(join(process.cwd(), 'desktop/build/src/desktop/main.js')).href
  );
  await finished;
})()
  .catch(error => {
    report.fatal = error.stack || String(error);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    hooks.deregister();
    writeFileSync(reportPath, JSON.stringify(report));
    app.quit();
  });
