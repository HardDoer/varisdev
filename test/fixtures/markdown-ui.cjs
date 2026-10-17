/* global process, __dirname, setTimeout */
const {app, BrowserWindow} = require('electron');
const {readFile, writeFile} = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const directory = process.argv[2];
const reportPath = process.argv[3];
const screenshotPath = process.argv[4];
app.setPath('userData', path.join(directory, 'profile'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
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
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
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
    await check('Launcher immediately opens a readable file in one panel; raw HTML remains inert', async () => {
      $('markdown-launcher').click();
      await until(() => $('markdown-preview').querySelector('h1'));
      assert(document.querySelectorAll('#markdown-panel').length === 1, 'One file panel');
      assert($('markdown-preview').getBoundingClientRect().height > 180, 'Readable preview has space');
      assert(getComputedStyle($('markdown-editor')).display === 'none', 'Hidden editor does not consume preview space');
      assert($('markdown-updated').hidden, 'Initial read has no update notification');
      $('markdown-pin').click();
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
      assert(!$('markdown-updated').hidden && $('markdown-updated').textContent.startsWith('Updated '), 'Visible update timestamp');
      assert($('markdown-updated').classList.contains('is-updated'), 'Update pulse applied');
    });
    await check('Identical disk content and polling do not create update notifications', async () => {
      const at = $('markdown-updated').dateTime;
      fixture.put('one', 'PLAN.md', fixture.disk('one', 'PLAN.md').content);
      await wait(1700);
      assert($('markdown-updated').dateTime === at, 'Identical content retains last actual update time');
    });
    await check('Polling recovers automatically after a transient read error', async () => {
      fixture.readError('Markdown file temporarily missing');
      await until(() => $('markdown-error').textContent === 'Markdown file temporarily missing');
      fixture.readError(undefined);
      await until(() => $('markdown-error').hidden);
      assert($('markdown-preview').textContent.includes('Build plan updated'), 'Recovered preview remains visible');
    });
    await check('Edit and save write full draft without an external update cue', async () => {
      const at = $('markdown-updated').dateTime;
      $('markdown-edit').click();
      draft('# Saved from app\\n\\n- [x] First\\n- [ ] Second');
      assert($('markdown-status').textContent === 'Unsaved changes', 'Dirty status visible');
      $('markdown-save').click();
      await until(() => $('markdown-status').textContent === 'Saved');
      assert(fixture.disk('one', 'PLAN.md').content.startsWith('# Saved from app'), 'Draft reached save API');
      assert($('markdown-editor').hidden, 'Preview after save');
      await wait(1700);
      assert($('markdown-updated').dateTime === at, 'Own save creates no update notification');
    });
    await check('Polling preserves dirty draft and conflict preserves agent changes', async () => {
      $('markdown-edit').click();
      draft('# My unsaved draft');
      fixture.put('one', 'PLAN.md', '# Agent revision\\n\\n- [x] Updated');
      await until(() => $('markdown-disk-status').textContent.includes('changed on disk'));
      assert($('markdown-editor').value === '# My unsaved draft', 'Polling preserves draft');
      assert(!$('markdown-updated').hidden, 'Disk update cue also visible with dirty draft');
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
    await check('Typed paths open files and arrow keys switch tabs', async () => {
      $('markdown-path').value = 'NOTES.md';
      $('markdown-path-form').dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
      await until(() => $('markdown-file-path').textContent.endsWith('NOTES.md') && $('markdown-preview').textContent.includes('Notes'));
      assert($('markdown-pin').textContent === 'Pin', 'Opening file leaves pin as explicit control');
      const tab = $('markdown-tabs').querySelector('[aria-selected=true]');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
      await until(() => $('markdown-file-path').textContent.endsWith('PLAN.md'));
      assert(document.activeElement.getAttribute('aria-selected') === 'true', 'Keyboard focus follows tab');
    });
    await check('Agent updates refresh an opened unpinned file', async () => {
      await fixture.open('NOTES.md');
      assert($('markdown-pin').textContent === 'Pin', 'File is unpinned');
      assert($('markdown-updated').hidden, 'First file read has no update cue');
      fixture.put('one', 'NOTES.md', '# Notes updated\\n\\nAgent added this line.');
      await until(() => $('markdown-preview').textContent.includes('Agent added this line'));
      assert(!$('markdown-updated').hidden, 'Unpinned file update indicated');
      $('markdown-pin').click();
      await fixture.open('PLAN.md');
    });
    await check('Pinned files refresh while another tab is selected', async () => {
      fixture.put('one', 'NOTES.md', '# Notes updated in background');
      await wait(1700);
      const readsBefore = fixture.disk('one', 'NOTES.md').version;
      await fixture.open('NOTES.md');
      assert($('markdown-preview').textContent.includes('updated in background'), 'Inactive pin is current on selection');
      assert(!$('markdown-updated').hidden && fixture.disk('one', 'NOTES.md').version === readsBefore, 'Background update cue survives tab switch');
      await fixture.open('PLAN.md');
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
    await check('Matching tab paths rebuild their handlers when the project changes', async () => {
      fixture.put('mirror-one', '/shared/FIRST.md', '# First project original');
      fixture.put('mirror-one', '/shared/SECOND.md', '# First project second');
      fixture.put('mirror-two', '/shared/FIRST.md', '# Second project original');
      fixture.put('mirror-two', '/shared/SECOND.md', '# Second project second');
      fixture.select('mirror-one', '/scope/one');
      await fixture.open('/shared/FIRST.md', {pin: true});
      await fixture.open('/shared/SECOND.md', {pin: true});
      fixture.select('mirror-two', '/scope/two');
      await fixture.open('/shared/FIRST.md', {pin: true});
      await fixture.open('/shared/SECOND.md', {pin: true});
      fixture.put('mirror-one', '/shared/FIRST.md', '# First project updated');
      fixture.select('mirror-one', '/scope/one');
      $('markdown-tabs').querySelector('button').click();
      await wait(100);
      assert(
        $('markdown-preview').textContent.includes('First project updated'),
        'Tab refresh uses the selected project document',
      );
      assert(
        !$('markdown-preview').textContent.includes('Second project'),
        'Matching paths do not retain another project handler',
      );
      fixture.select('one');
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
      assert($('markdown-preview').textContent.includes('could not be loaded'), 'Read failure has a visible preview state');
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
  const evaluate = script => window.webContents.executeJavaScript(script);
  const panelBounds = () =>
    evaluate(`(() => {
    const box = document.getElementById('markdown-panel').getBoundingClientRect();
    return {x: box.x, y: box.y, width: box.width, height: box.height};
  })()`);
  const check = async (name, fn) => {
    try {
      await fn();
      report.cases.push({name});
    } catch (error) {
      report.cases.push({name, error: error.stack});
    }
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const drag = async (id, dx, dy) => {
    const origin = await evaluate(`(() => {
      const box = document.getElementById('${id}').getBoundingClientRect();
      return {x: Math.round(box.left + 12), y: Math.round(box.top + 12)};
    })()`);
    window.webContents.sendInputEvent({type: 'mouseMove', ...origin});
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...origin,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x: origin.x + dx,
      y: origin.y + dy,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: origin.x + dx,
      y: origin.y + dy,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  await check(
    'Dragging the title moves the floating panel and persists placement',
    async () => {
      const before = await panelBounds();
      await drag('markdown-heading', 170, 25);
      const after = await panelBounds();
      assert(
        after.x === before.x + 170 && after.y === before.y + 25,
        'Pointer drag moves the panel freely',
      );
      const saved = await evaluate(
        "JSON.parse(localStorage.getItem('varisdev.markdown-placement.v1'))",
      );
      assert(
        saved.x === after.x && saved.y === after.y,
        'Drag placement saved',
      );
    },
  );
  await check('Resize handle changes the readable panel size', async () => {
    const before = await panelBounds();
    await drag('markdown-resize', 100, 40);
    const after = await panelBounds();
    assert(
      after.width === before.width + 100 && after.height === before.height + 40,
      'Pointer resize changes size',
    );
    assert(
      after.x === before.x && after.y === before.y,
      'Resize keeps top left position',
    );
  });
  await check(
    'Keyboard controls move and resize; Lock prevents pointer and keyboard changes',
    async () => {
      const before = await panelBounds();
      await evaluate(`(() => {
      const heading = document.getElementById('markdown-heading');
      heading.focus();
      heading.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
      const resize = document.getElementById('markdown-resize');
      resize.focus();
      resize.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    })()`);
      const moved = await panelBounds();
      assert(
        moved.x === before.x + 10 && moved.width === before.width + 10,
        'Keyboard move and resize work',
      );
      await evaluate("document.getElementById('markdown-lock').click()");
      await drag('markdown-heading', 60, -25);
      await drag('markdown-resize', 60, 20);
      await evaluate(
        "document.getElementById('markdown-heading').dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}))",
      );
      assert(
        JSON.stringify(await panelBounds()) === JSON.stringify(moved),
        'Lock fixes position and size',
      );
      assert(
        await evaluate(
          "document.getElementById('markdown-lock').textContent === 'Unlock' && document.getElementById('markdown-resize').disabled",
        ),
        'Lock state visible and resize disabled',
      );
    },
  );
  const beforeReload = await panelBounds();
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
  await check(
    'Reload restores placement, size, and Lock with pinned files',
    async () => {
      assert(
        JSON.stringify(await panelBounds()) === JSON.stringify(beforeReload),
        'Saved panel geometry restored',
      );
      assert(
        await evaluate(
          "document.getElementById('markdown-lock').getAttribute('aria-pressed') === 'true'",
        ),
        'Lock restored',
      );
    },
  );
  await check(
    'A smaller viewport keeps the panel in bounds and the composer reachable',
    async () => {
      window.setSize(600, 600);
      await new Promise(resolve => setTimeout(resolve, 150));
      const box = await panelBounds();
      const viewport = await evaluate(
        '({width: innerWidth, height: innerHeight})',
      );
      assert(box.x >= 8 && box.y >= 8, 'Title remains in viewport');
      assert(box.x + box.width <= viewport.width - 8, 'Right edge constrained');
      assert(
        box.y + box.height <= viewport.height - 96,
        'Bottom space reserved for composer',
      );
      assert(
        await evaluate(
          "document.getElementById('markdown-preview').getBoundingClientRect().height > 60",
        ),
        'Preview readable after viewport change',
      );
      const saved = await evaluate(
        "JSON.parse(localStorage.getItem('varisdev.markdown-placement.v1'))",
      );
      assert(
        saved.width === beforeReload.width &&
          saved.height === beforeReload.height,
        'Viewport change preserves preferred size',
      );
      window.setSize(1500, 980);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert(
        JSON.stringify(await panelBounds()) === JSON.stringify(beforeReload),
        'Growing the viewport restores the saved placement',
      );
      window.setSize(600, 600);
      await evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const beforeUnlock = await panelBounds();
      await evaluate("document.getElementById('markdown-lock').click()");
      const afterUnlock = await panelBounds();
      assert(
        Object.keys(beforeUnlock).every(
          key => Math.abs(afterUnlock[key] - beforeUnlock[key]) < 0.1,
        ),
        `Unlock keeps the constrained panel placement: ${JSON.stringify({beforeUnlock, afterUnlock})}`,
      );
      await drag('markdown-heading', -1000, -1000);
      const clamped = await panelBounds();
      assert(
        clamped.x >= 8 && clamped.y >= 8,
        'Dragging beyond viewport stays accessible',
      );
      window.setSize(1500, 980);
    },
  );
  const reload = async () => {
    await window.webContents.reload();
    await new Promise(resolve => setTimeout(resolve, 250));
  };
  await check(
    'Restart recovers unpinned Markdown drafts and their original conflict version',
    async () => {
      await evaluate(`(async () => {
      const fixture = window.markdownFixture;
      fixture.put('one', 'RECOVERY.md', '# Original disk');
      await fixture.open('RECOVERY.md', {edit: true});
      const editor = document.getElementById('markdown-editor');
      editor.value = '# Draft before restart';
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      fixture.select('two');
      fixture.put('two', 'RECOVERY.md', '# Other original disk');
      await fixture.open('RECOVERY.md', {edit: true});
      editor.value = '# Other parent draft';
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      fixture.select('one');
      fixture.put('one', 'RECOVERY.md', '# Agent changed disk during restart');
    })()`);
      await reload();
      await evaluate("window.markdownFixture.open('RECOVERY.md')");
      const restored = await evaluate(`(() => {
      const record = JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).find(([, value]) => value.cwd === '/project/one' && value.path.endsWith('RECOVERY.md'));
      return {visible: !document.getElementById('markdown-panel').hidden,
        value: document.getElementById('markdown-editor').value,
        status: document.getElementById('markdown-status').textContent,
        changed: document.getElementById('markdown-disk-status').textContent,
        pinned: document.getElementById('markdown-pin').getAttribute('aria-pressed'),
        base: record[1].baseContent, canonical: record[0] === JSON.stringify(['/project/one', '/project/one/RECOVERY.md'])};
    })()`);
      assert(
        restored.visible && restored.value === '# Draft before restart',
        'Unpinned unsaved editor restored',
      );
      assert(
        restored.status.includes('Recovered draft') &&
          restored.changed.includes('changed on disk'),
        'Recovery and disk conflict visible',
      );
      assert(
        restored.pinned === 'false' &&
          restored.canonical &&
          restored.base === '# Original disk',
        'Canonical recovery retains original base',
      );
      await evaluate("document.getElementById('markdown-save').click()");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert(
        await evaluate(
          "document.getElementById('markdown-error').textContent.includes('changed on disk') && document.getElementById('markdown-editor').value === '# Draft before restart'",
        ),
        'Save conflict preserves recovered draft',
      );
      assert(
        await evaluate(
          "window.markdownFixture.disk('one', 'RECOVERY.md').content === '# Agent changed disk during restart'",
        ),
        'Recovery never overwrites agent changes',
      );
    },
  );
  await check(
    'Recovered drafts remain isolated by project and Cancel removes recovery data',
    async () => {
      await evaluate("window.markdownFixture.select('two')");
      assert(
        await evaluate(
          "document.getElementById('markdown-editor').value === '# Other parent draft'",
        ),
        'Other project recovers its own same-name draft',
      );
      await evaluate(`(() => {
      document.getElementById('markdown-cancel').click();
      window.markdownFixture.flush();
    })()`);
      assert(
        await evaluate(
          "!JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).some(([, value]) => value.cwd === '/project/two' && value.path.endsWith('RECOVERY.md'))",
        ),
        'Cancel removes other project recovery',
      );
      await reload();
      await evaluate("window.markdownFixture.select('two')");
      assert(
        await evaluate("document.getElementById('markdown-editor').hidden"),
        'Discarded draft does not return after restart',
      );
      await evaluate("window.markdownFixture.select('one')");
      assert(
        await evaluate(
          "document.getElementById('markdown-editor').value === '# Draft before restart'",
        ),
        'Other project discard preserves first draft',
      );
    },
  );
  await check(
    'Reload disk and successful saves clear recovered drafts across restarts',
    async () => {
      await evaluate("document.getElementById('markdown-reload').click()");
      await new Promise(resolve => setTimeout(resolve, 100));
      await evaluate('window.markdownFixture.flush()');
      assert(
        await evaluate(
          "document.getElementById('markdown-editor').value === '# Agent changed disk during restart' && !JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).some(([, value]) => value.cwd === '/project/one' && value.path.endsWith('RECOVERY.md'))",
        ),
        'Reload disk discards and clears recovery',
      );
      await evaluate(`(() => {
      const editor = document.getElementById('markdown-editor');
      editor.value = '# Saved after restart';
      editor.dispatchEvent(new Event('input', {bubbles: true}));
      document.getElementById('markdown-save').click();
    })()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      await evaluate('window.markdownFixture.flush()');
      assert(
        await evaluate(
          "document.getElementById('markdown-status').textContent === 'Saved' && !JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).some(([, value]) => value.cwd === '/project/one' && value.path.endsWith('RECOVERY.md'))",
        ),
        'Successful save clears recovery',
      );
      await reload();
      await evaluate("window.markdownFixture.open('RECOVERY.md')");
      assert(
        await evaluate(
          "document.getElementById('markdown-editor').hidden && document.getElementById('markdown-preview').textContent.includes('Saved after restart')",
        ),
        'Saved disk returns without stale editor',
      );
    },
  );
  await check(
    'Storage failures and size limits retain edits and fail the restart check until recovery is saved',
    async () => {
      await evaluate(
        "window.markdownFixture.open('RECOVERY.md', {edit: true})",
      );
      const result = await evaluate(`(() => {
      const fixture = window.markdownFixture;
      const editor = document.getElementById('markdown-editor');
      const draft = value => {editor.value = value; editor.dispatchEvent(new Event('input', {bubbles: true}));};
      const restartBlocked = () => {try {fixture.flush(); return false;} catch {return true;}};
      draft('# Previously stored draft');
      fixture.flush();
      fixture.failDraftWrites(true);
      draft('# Still editable after quota failure');
      const failed = restartBlocked() && document.getElementById('markdown-storage-status').textContent.includes('could not be saved') && editor.value === '# Still editable after quota failure';
      const preserved = JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).some(([, value]) => value.draft === '# Previously stored draft');
      fixture.failDraftWrites(false);
      draft('# Quota recovered');
      fixture.flush();
      const recovered = document.getElementById('markdown-storage-status').textContent === '';
      draft('x'.repeat(1_048_577));
      const bounded = restartBlocked() && editor.value.length === 1_048_577;
      const previousRetained = JSON.parse(localStorage.getItem('varisdev.markdown-drafts.v1')).some(([, value]) => value.draft === '# Quota recovered');
      draft('# Final recoverable draft');
      fixture.flush();
      document.getElementById('markdown-cancel').click();
      fixture.flush();
      return {failed, preserved, recovered, bounded, previousRetained};
    })()`);
      assert(
        Object.values(result).every(Boolean),
        'Quota and bounds preserve drafts and block unsafe restart: ' +
          JSON.stringify(result),
      );
    },
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
