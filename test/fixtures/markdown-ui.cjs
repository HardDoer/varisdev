/* global process, __dirname, setTimeout */
const {app, BrowserWindow} = require('electron');
const {readFile, writeFile} = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const directory = process.argv[2];
const reportPath = process.argv[3];
const screenshotPath = process.argv[4];
app.setPath('userData', path.join(directory, 'profile'));
const report = {cases: []};

(async () => {
  await app.whenReady();
  const root = path.resolve(__dirname, '../../');
  let html = await readFile(
    path.join(root, 'assets/dashboard/index.html'),
    'utf8',
  );
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace(
    /href="([^"\n]+\.css)"/g,
    (_, value) =>
      `href="${pathToFileURL(path.resolve(root, 'assets/dashboard', value))}"`,
  );
  html = html.replace(
    '</body>',
    `<script type="module" src="${pathToFileURL(path.join(__dirname, 'markdown-ui.js'))}"></script></body>`,
  );
  const page = path.join(directory, 'index.html');
  await writeFile(page, html);
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    show: false,
    webPreferences: {contextIsolation: true, nodeIntegration: false},
  });
  await window.loadFile(page);
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.markdownReady) {clearInterval(timer); resolve();}
      else if (Date.now() - start > 5000) {clearInterval(timer); reject(new Error('Fixture did not initialize'));}
    }, 20);
  })`);
  report.cases = await window.webContents.executeJavaScript(`(async () => {
    const cases = [];
    const $ = id => document.getElementById(id);
    const fixture = window.markdownFixture;
    const assert = (value, message) => {if (!value) throw new Error(message);};
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const until = async predicate => {
      for (let i = 0; i < 100; i++) {if (predicate()) return; await wait(40);}
      throw new Error('Timed out waiting for UI');
    };
    const check = async (name, fn) => {
      try {await fn(); cases.push({name});}
      catch (error) {cases.push({name, error: error.stack});}
    };
    const draft = value => {$('markdown-editor').value = value; $('markdown-editor').dispatchEvent(new Event('input', {bubbles: true}));};
    await check('Open current disk and pin a readable tasklist; raw HTML remains inert', async () => {
      await fixture.open('PLAN.md', {pin: true});
      assert(!$('markdown-panel').hidden, 'Panel opens');
      assert($('markdown-file-path').textContent === '/project/one/PLAN.md', 'Canonical path shown');
      assert($('markdown-preview').querySelector('h1').textContent === 'Build plan', 'Heading rendered');
      assert($('markdown-preview').querySelectorAll('input[type=checkbox]').length === 2, 'Task checkboxes rendered');
      assert($('markdown-progress-text').textContent === '1 / 2 tasks complete', 'Fenced tasks excluded');
      assert(!$('markdown-preview').querySelector('img, script'), 'File HTML never becomes elements');
      assert($('markdown-preview').textContent.includes('<img src=x'), 'Raw HTML displayed as text');
      assert(!window.hacked, 'File script remains inert');
    });
    await check('Agent updates refresh pinned tasklist and progress', async () => {
      fixture.put('one', 'PLAN.md', '# Build plan updated\\n\\n- [x] Read instructions\\n- [x] Implement editor');
      await until(() => $('markdown-progress-text').textContent === '2 / 2 tasks complete');
      assert($('markdown-preview').querySelector('h1').textContent === 'Build plan updated', 'Preview refreshed from disk');
    });
    await check('Polling recovers automatically after a transient read error', async () => {
      fixture.readError('Markdown file temporarily missing');
      await until(() => $('markdown-error').textContent === 'Markdown file temporarily missing');
      fixture.readError(undefined);
      await until(() => $('markdown-error').hidden);
      assert($('markdown-preview').textContent.includes('Build plan updated'), 'Recovered preview remains visible');
    });
    await check('Edit and save write full draft and show saved status', async () => {
      $('markdown-edit').click();
      draft('# Saved from app\\n\\n- [x] First\\n- [ ] Second');
      assert($('markdown-status').textContent === 'Unsaved changes', 'Dirty status visible');
      $('markdown-save').click();
      await until(() => $('markdown-status').textContent === 'Saved');
      assert(fixture.disk('one', 'PLAN.md').content.startsWith('# Saved from app'), 'Draft reached save API');
      assert($('markdown-editor').hidden, 'Preview after save');
    });
    await check('Polling preserves dirty draft and conflict preserves agent changes', async () => {
      $('markdown-edit').click();
      draft('# My unsaved draft');
      fixture.put('one', 'PLAN.md', '# Agent revision\\n\\n- [x] Updated');
      await until(() => $('markdown-disk-status').textContent.includes('changed on disk'));
      assert($('markdown-editor').value === '# My unsaved draft', 'Polling preserves draft');
      $('markdown-save').click();
      await until(() => !$('markdown-error').hidden);
      assert($('markdown-editor').value === '# My unsaved draft', 'Conflict preserves draft');
      assert(fixture.disk('one', 'PLAN.md').content.startsWith('# Agent revision'), 'Conflict preserves agent disk update');
      assert(!$('markdown-reload').hidden, 'Reload offered');
      await wait(1600);
      assert(!$('markdown-error').hidden && $('markdown-error').textContent.includes('changed on disk'), 'Successful polling preserves save conflict');
    });
    await check('Reload conflict reads current disk and Cancel returns to preview', async () => {
      $('markdown-reload').click();
      await until(() => $('markdown-editor').value.startsWith('# Agent revision'));
      assert($('markdown-save').disabled, 'Reloaded editor is clean');
      draft('# Discarded draft');
      $('markdown-cancel').click();
      await until(() => $('markdown-editor').hidden);
      assert($('markdown-preview').textContent.includes('Agent revision'), 'Cancel previews current disk');
      assert(!fixture.disk('one', 'PLAN.md').content.includes('Discarded'), 'Cancel never saves draft');
    });
    await check('Save errors retain draft and display recovery controls', async () => {
      $('markdown-edit').click();
      draft('# Retain on error');
      fixture.saveError('Permission denied');
      $('markdown-save').click();
      await until(() => $('markdown-error').textContent === 'Permission denied');
      assert($('markdown-editor').value === '# Retain on error', 'Failed save preserves draft');
      fixture.saveError(undefined);
      $('markdown-cancel').click();
    });
    await check('Typed paths pin files and arrow keys switch tabs', async () => {
      $('markdown-path').value = 'NOTES.md';
      $('markdown-path-form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      await until(() => $('markdown-file-path').textContent.endsWith('NOTES.md') && $('markdown-preview').textContent.includes('Notes'));
      assert($('markdown-pin').textContent === 'Unpin', 'Typed file pinned');
      const tab = $('markdown-tabs').querySelector('[aria-selected=true]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
      await until(() => $('markdown-file-path').textContent.endsWith('PLAN.md'));
      assert(document.activeElement.getAttribute('aria-selected') === 'true', 'Keyboard focus follows tab');
    });
    await check('Reopening a relative file path preserves its existing draft', async () => {
      $('markdown-edit').click();
      draft('# Existing draft');
      await fixture.open('PLAN.md', {edit: true});
      assert($('markdown-editor').value === '# Existing draft', 'Alias resolves to same editor');
      assert($('markdown-tabs').children.length === 2, 'No duplicate canonical file tab');
      $('markdown-cancel').click();
    });
    await check('Session switches isolate project pins and preserve editor drafts', async () => {
      $('markdown-edit').click();
      draft('# Retained across sessions');
      fixture.select('two');
      await fixture.open('PLAN.md', {pin: true});
      assert($('markdown-preview').textContent.includes('Other project'), 'Other session disk selected');
      assert($('markdown-tabs').children.length === 1, 'Pins scoped by cwd');
      fixture.select('one');
      await until(() => $('markdown-editor').value === '# Retained across sessions');
      assert($('markdown-tabs').children.length === 2, 'Original project pins restored');
    });
    await check('Unpin persists and panel Escape returns focus without discarding edits', async () => {
      $('markdown-pin').click();
      const stored = JSON.parse(localStorage.getItem('varisdev.markdown-pins.v1'));
      assert(stored['/project/one'].length === 1 && stored['/project/one'][0].endsWith('NOTES.md'), 'Unpin persisted canonical paths');
      $('markdown-panel').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      assert($('markdown-panel').hidden, 'Escape closes nonmodal panel');
      $('markdown-launcher').click();
      assert($('markdown-editor').value === '# Retained across sessions', 'Hidden panel preserves draft');
      $('markdown-cancel').click();
    });
    await check('Read errors show file path and allow retry', async () => {
      fixture.readError('Could not read Markdown file');
      await fixture.open('MISSING.md');
      assert($('markdown-error').textContent === 'Could not read Markdown file', 'Read error visible');
      assert($('markdown-edit').disabled, 'Unreadable file cannot edit');
      fixture.readError(undefined);
      fixture.put('one', 'MISSING.md', '# Recovered');
      $('markdown-reload').click();
      await until(() => $('markdown-preview').textContent.includes('Recovered'));
    });
    await check('A delayed read cannot replace another parent session document', async () => {
      let release;
      fixture.delay(new Promise(resolve => {release = resolve;}));
      const pending = fixture.open('NOTES.md');
      fixture.select('two');
      release();
      fixture.delay(undefined);
      await pending;
      await until(() => $('markdown-preview').textContent.includes('Other project'));
      assert($('markdown-file-path').textContent.startsWith('/project/two/'), 'Delayed read stays in its project');
      fixture.select('one');
    });
    await check('Large Markdown previews are bounded while editing and saving keep all text', async () => {
      const full = '# Large file\\n\\n' + 'line of content\\n'.repeat(12000) + 'END OF FILE';
      fixture.put('one', 'LARGE.md', full);
      await fixture.open('LARGE.md');
      assert($('markdown-preview').textContent.includes('Preview limited'), 'Preview is bounded');
      $('markdown-edit').click();
      assert($('markdown-editor').value === full, 'Editor receives complete file');
      draft(full + '\\nSaved tail');
      $('markdown-save').click();
      await until(() => $('markdown-status').textContent === 'Saved');
      assert(fixture.disk('one', 'LARGE.md').content.endsWith('END OF FILE\\nSaved tail'), 'Save keeps complete content');
    });
    await check('Windows canonical aliases preserve one tab and an unsaved draft', async () => {
      const separator = String.fromCharCode(92);
      const cwd = ['C:', 'project'].join(separator);
      const path = cwd + separator + 'PLAN.md';
      fixture.select('windows', cwd);
      await fixture.open(path, {edit: true, pin: true});
      draft('# Windows unsaved draft');
      await fixture.open('./PLAN.md', {edit: true});
      assert($('markdown-tabs').children.length === 1, 'Canonical alias reuses one tab');
      assert($('markdown-editor').value === '# Windows unsaved draft', 'Canonical collision preserves draft');
      assert($('markdown-status').textContent === 'Unsaved changes', 'Editor remains dirty');
      assert($('markdown-file-path').textContent === path, 'Canonical Windows path retained');
      fixture.select('one');
    });
    await fixture.open('NOTES.md', {pin: true});
    return cases;
  })()`);
  await window.webContents.reload();
  await new Promise(resolve => setTimeout(resolve, 500));
  report.cases.push(
    await window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('markdown-panel');
    const tabs = document.getElementById('markdown-tabs');
    const valid = !panel.hidden && tabs.children.length === 1 && tabs.textContent.includes('NOTES.md');
    return {name: 'Reload restores saved pins for the same project', ...(valid ? {} : {error: 'Persisted pins not restored after reload'})};
  })()`),
  );
  await window.webContents.executeJavaScript(
    // eslint-disable-next-line quotes
    `window.markdownFixture.put('one','PLAN.md','# Agent tasklist\\n\\n- [x] Read project instructions\\n- [x] Implement Markdown editor\\n- [x] Preserve drafts during agent updates\\n- [ ] Review final changes\\n\\n## Next steps\\nThe tasklist updates while agents work.'); window.markdownFixture.open('PLAN.md', {pin:true});`,
  );
  await new Promise(resolve => setTimeout(resolve, 200));
  if (screenshotPath)
    await writeFile(
      screenshotPath,
      (await window.webContents.capturePage()).toPNG(),
    );
  window.destroy();
})()
  .catch(error => {
    report.fatal = error.stack;
  })
  .finally(async () => {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    app.exit(report.fatal || report.cases.some(item => item.error) ? 1 : 0);
  });
