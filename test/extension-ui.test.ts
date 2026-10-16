import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  ModelRuntime,
  ModelSelectorComponent,
} from '@earendil-works/pi-coding-agent';
import {setTimeout as delay} from 'node:timers/promises';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), 'Expected terminal UI state before deadline');
}
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';

void test('desktop extension dialogs preserve FIFO order and validate responses', async () => {
  let changes = 0;
  const adapter = new DesktopExtensionUI(() => changes++);
  const ui = adapter.context;
  const options = ['First', 'Second'];
  const selected = ui.select('Choose', options);
  options[0] = 'Mutated';
  const confirmed = ui.confirm('Continue?', 'Please confirm.');
  const input = ui.input('Name', 'Enter a name');
  const edited = ui.editor('Edit notes', 'Old\nnotes');
  const dialogs = adapter.snapshot().dialogs;
  assert.deepEqual(
    dialogs.map(dialog => dialog.kind),
    ['select', 'confirm', 'input', 'editor'],
  );
  assert.deepEqual(dialogs[0].options, ['First', 'Second']);
  assert.equal(dialogs[0].searchable, true);
  assert.equal(dialogs[1].message, 'Please confirm.');
  assert.equal(dialogs[2].placeholder, 'Enter a name');
  assert.equal(dialogs[3].prefill, 'Old\nnotes');

  adapter.respond(dialogs[1].id, true);
  adapter.respond(dialogs[0].id, 'Missing option');
  adapter.respond(dialogs[0].id, false);
  assert.equal(adapter.snapshot().dialogs.length, 4);
  adapter.respond(dialogs[0].id, 'Second');
  assert.equal(await selected, 'Second');
  adapter.respond(dialogs[0].id, 'First');
  adapter.respond(dialogs[1].id, 'true');
  assert.equal(adapter.snapshot().dialogs.length, 3);
  adapter.respond(dialogs[1].id, true);
  assert.equal(await confirmed, true);
  adapter.respond(dialogs[2].id, '');
  assert.equal(await input, '');
  adapter.respond(dialogs[3].id, 'New\nnotes');
  assert.equal(await edited, 'New\nnotes');
  assert.equal(adapter.snapshot().dialogs.length, 0);
  assert.equal(changes, 8);
  adapter.dispose();
});

void test('cancellation, timeout and disposal settle active and queued dialogs', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const adapter = new DesktopExtensionUI(() => {});
  const ui = adapter.context;
  const first = ui.confirm('Active', 'Waiting');
  const abort = new AbortController();
  const second = ui.input('Queued', undefined, {signal: abort.signal});
  const expired = ui.select('Timed', ['A'], {timeout: 50});
  const timedEditor = ui.editor('Timed editor', 'text', {timeout: 50});
  abort.abort();
  assert.equal(await second, undefined);
  t.mock.timers.tick(50);
  assert.equal(await expired, undefined);
  assert.equal(await timedEditor, undefined);
  assert.deepEqual(
    adapter.snapshot().dialogs.map(dialog => dialog.title),
    ['Active'],
  );
  adapter.respond(adapter.snapshot().dialogs[0].id);
  assert.equal(await first, false);

  const cancelledSelect = ui.select('Cancel select', ['A']);
  adapter.respond(adapter.snapshot().dialogs[0].id);
  assert.equal(await cancelledSelect, undefined);
  const cancelledEditor = ui.editor('Cancel editor');
  adapter.respond(adapter.snapshot().dialogs[0].id);
  assert.equal(await cancelledEditor, undefined);
  const cancelledInput = ui.input('Cancel input');
  adapter.respond(adapter.snapshot().dialogs[0].id);
  assert.equal(await cancelledInput, undefined);

  const alreadyAborted = AbortSignal.abort();
  assert.equal(
    await ui.confirm('Aborted', 'Waiting', {signal: alreadyAborted}),
    false,
  );
  assert.equal(
    await ui.input('Immediate timeout', undefined, {timeout: 0}),
    undefined,
  );
  const pendingInput = ui.input('Close input', undefined, {timeout: 100});
  const pendingConfirm = ui.confirm('Close confirm', 'Waiting');
  adapter.dispose();
  assert.equal(await pendingInput, undefined);
  assert.equal(await pendingConfirm, false);
  adapter.dispose();
  t.mock.timers.tick(100);
  assert.equal(await ui.confirm('Closed', 'Waiting'), false);
  assert.equal(await ui.editor('Closed editor'), undefined);
  ui.notify('After close');
  ui.setStatus('after', 'closed');
  ui.setEditorText('closed');
  assert.deepEqual(adapter.snapshot(), {
    dialogs: [],
    notifications: [],
    statuses: [],
  });
});

void test('notifications, widgets, status and composer text remain visible with isolated snapshots', () => {
  const adapter = new DesktopExtensionUI(() => {});
  const ui = adapter.context;
  ui.notify('Ready');
  ui.notify('Careful', 'warning');
  ui.setStatus('extension', 'Running');
  ui.setWidget('summary', ['First line', 'Second line']);
  ui.setTitle('Session');
  ui.setWorkingMessage('Loading');
  ui.setWorkingVisible(false);
  ui.setWorkingIndicator({frames: ['●'], intervalMs: 100});
  ui.setHiddenThinkingLabel('Thinking');
  ui.setEditorText('Hello');
  const originalEditorId = adapter.snapshot().editor!.id;
  ui.pasteToEditor(' world');
  assert.equal(ui.getEditorText(), 'Hello world');
  const snapshot = adapter.snapshot();
  assert.notEqual(snapshot.editor!.id, originalEditorId);
  assert.equal(snapshot.editor!.text, 'Hello world');
  assert.equal(snapshot.notifications[0].type, 'info');
  assert.equal(snapshot.notifications[1].type, 'warning');
  assert.ok(
    snapshot.statuses.some(
      item =>
        item.key === 'widget:summary' &&
        item.text === 'First line\nSecond line',
    ),
  );
  assert.ok(
    snapshot.statuses.some(
      item => item.key === 'ui:working' && item.text === 'Loading',
    ),
  );
  assert.ok(
    snapshot.statuses.some(
      item => item.key === 'ui:workingVisible' && item.text === 'hidden',
    ),
  );
  adapter.respond(snapshot.editor!.id, 'User typed');
  assert.equal(ui.getEditorText(), 'User typed');
  assert.equal(adapter.snapshot().editor!.id, snapshot.editor!.id);

  snapshot.editor!.text = 'Mutated';
  snapshot.notifications[0].message = 'Mutated';
  snapshot.statuses[0].text = 'Mutated';
  snapshot.notifications.length = 0;
  assert.equal(adapter.snapshot().editor!.text, 'User typed');
  assert.equal(adapter.snapshot().notifications[0].message, 'Ready');
  assert.equal(adapter.snapshot().statuses[0].text, 'Running');
  ui.setStatus('extension', undefined);
  ui.setWidget('summary', undefined);
  ui.setWorkingMessage();
  ui.setWorkingIndicator();
  ui.setHiddenThinkingLabel();
  assert.ok(
    !adapter
      .snapshot()
      .statuses.some(item =>
        [
          'extension',
          'widget:summary',
          'ui:working',
          'ui:workingIndicator',
          'ui:hiddenThinking',
        ].includes(item.key),
      ),
  );
  adapter.dispose();
});

void test('dialog snapshots cannot mutate pending selection choices', async () => {
  const adapter = new DesktopExtensionUI(() => {});
  const selected = adapter.context.select('Original', ['A']);
  const snapshot = adapter.snapshot();
  snapshot.dialogs[0].title = 'Changed';
  snapshot.dialogs[0].options![0] = 'B';
  adapter.respond(snapshot.dialogs[0].id, 'B');
  assert.equal(adapter.snapshot().dialogs[0].title, 'Original');
  adapter.respond(snapshot.dialogs[0].id, 'A');
  assert.equal(await selected, 'A');
  adapter.dispose();
});

void test('theme helpers and tool expansion keep normal extension API behavior', () => {
  const adapter = new DesktopExtensionUI(() => {});
  const ui = adapter.context;
  assert.equal(ui.theme.name, 'dark');
  assert.equal(typeof ui.theme.fg('accent', 'Text'), 'string');
  assert.ok(ui.getAllThemes().some(theme => theme.name === 'dark'));
  assert.ok(ui.getAllThemes().some(theme => theme.name === 'light'));
  assert.equal(ui.getTheme('missing-desktop-extension-test-theme'), undefined);
  assert.deepEqual(ui.setTheme('missing-desktop-extension-test-theme'), {
    success: false,
    error: 'Theme not found: missing-desktop-extension-test-theme',
  });
  assert.deepEqual(ui.setTheme('light'), {success: true});
  assert.equal(ui.theme.name, 'light');
  const dark = ui.getTheme('dark')!;
  assert.deepEqual(ui.setTheme(dark), {success: true});
  assert.equal(ui.theme, dark);
  assert.equal(ui.getToolsExpanded(), false);
  ui.setToolsExpanded(true);
  assert.equal(ui.getToolsExpanded(), true);
  assert.ok(
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'ui:toolsExpanded' && item.text === 'expanded',
      ),
  );
  ui.setHeader(undefined);
  ui.setFooter(undefined);
  ui.setEditorComponent(undefined);
  assert.equal(ui.getEditorComponent(), undefined);
  adapter.dispose();
});

async function selectorRuntime(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-model-selector-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const modelsPath = join(directory, 'models.json');
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        'selector-fixture': {
          api: 'openai-completions',
          baseUrl: 'https://selector-fixture.invalid/v1',
          apiKey: 'fixture-key',
          models: [
            {id: 'alpha', name: 'Alpha model'},
            {id: 'beta', name: 'Beta model'},
          ],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath,
    allowModelNetwork: false,
  });
  return {
    modelRuntime,
    currentModel: modelRuntime.getModel('selector-fixture', 'alpha')!,
    scopedModels: [],
    initialSearch: 'selector-fixture/beta',
  };
}

void test('SDK model selector routes native actions and keyboard selections with explicit persistence', async t => {
  const options = await selectorRuntime(t);
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  for (const [response, persist] of [
    [{action: 'session'}, false],
    [{action: 'default'}, true],
    ['\r', false],
    ['\x13', true],
  ] as const) {
    const selection = adapter.selectModel(options);
    await waitFor(
      () =>
        adapter.snapshot().dialogs[0]?.terminal?.output.includes('beta') ===
        true,
    );
    const dialog = adapter.snapshot().dialogs[0];
    assert.deepEqual(dialog.actions, [
      {id: 'default', label: 'Make as default'},
      {id: 'session', label: 'Apply to session'},
    ]);
    dialog.actions![0].id = 'mutated';
    adapter.respond(dialog.id, {action: 'unknown'});
    assert.equal(adapter.snapshot().dialogs[0].actions![0].id, 'default');
    adapter.respond(dialog.id, response);
    const selected = await selection;
    assert.equal(selected?.model.provider, 'selector-fixture');
    assert.equal(selected?.model.id, 'beta');
    assert.equal(selected?.persist, persist);
    assert.equal(adapter.snapshot().dialogs.length, 0);
  }
});

void test('command cancellation disposes the SDK model selector and empty results cannot submit', async t => {
  const options = await selectorRuntime(t);
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  let disposed = 0;
  const dispose = ModelSelectorComponent.prototype.dispose;
  t.mock.method(
    ModelSelectorComponent.prototype,
    'dispose',
    function (this: ModelSelectorComponent) {
      disposed++;
      dispose.call(this);
    },
  );
  const abort = new AbortController();
  const selection = adapter
    .forCommand(abort.signal)
    .selectModel({...options, initialSearch: 'no-matching-model'});
  await waitFor(
    () =>
      adapter
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('No matching models') === true,
  );
  const dialog = adapter.snapshot().dialogs[0];
  adapter.respond(dialog.id, {action: 'default'});
  assert.equal(adapter.snapshot().dialogs.length, 1);
  abort.abort();
  assert.equal(await selection, undefined);
  assert.ok(disposed > 0, 'The command-owned SDK component must be disposed');
  assert.equal(adapter.snapshot().dialogs.length, 0);
  const later = adapter.selectModel(options);
  await waitFor(
    () =>
      adapter.snapshot().dialogs[0]?.terminal?.output.includes('beta') === true,
  );
  adapter.respond(adapter.snapshot().dialogs[0].id, {action: 'session'});
  assert.equal((await later)?.persist, false);
});

void test('custom terminal dialogs render ANSI and use real keybindings and buffered raw input', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  let received = '';
  let disposed = 0;
  const result = adapter.context.custom<{text: string}>(
    (screen, theme, keys, done) => {
      assert.equal(typeof keys.matches('\x03', 'app.interrupt'), 'boolean');
      assert.ok(keys.getDefinition('app.interrupt').description);
      return {
        render: width => [theme.fg('accent', `Width ${width}: ${received}`)],
        invalidate: () => {},
        handleInput: data => {
          if (data === '\r') done({text: received});
          else {
            received += data;
            screen.requestRender();
          }
        },
        dispose: () => {
          disposed++;
        },
      };
    },
  );
  await waitFor(
    () =>
      adapter.snapshot().dialogs[0]?.terminal?.output.includes('Width 100:') ===
      true,
  );
  const initial = adapter.snapshot().dialogs[0];
  assert.equal(initial.kind, 'terminal');
  assert.equal(initial.terminal!.columns, 100);
  assert.equal(initial.terminal!.rows, 28);
  assert.ok(initial.terminal!.output.includes('\x1b['));
  const oldOutput = initial.terminal!.output;
  const oldRevision = initial.terminal!.revision;
  initial.terminal!.output = 'Mutated';
  assert.notEqual(adapter.snapshot().dialogs[0].terminal!.output, 'Mutated');
  const unsubscribe = adapter.context.onTerminalInput(data =>
    data === 'z' ? {consume: true} : undefined,
  );
  adapter.respond(initial.id, 'abz');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('ab'),
  );
  assert.equal(received, 'ab');
  assert.ok(
    adapter.snapshot().dialogs[0].terminal!.output.startsWith(oldOutput),
  );
  assert.ok(adapter.snapshot().dialogs[0].terminal!.revision > oldRevision);
  unsubscribe();
  adapter.respond(initial.id, 'z\r');
  assert.deepEqual(await result, {text: 'abz'});
  assert.equal(disposed, 1);
  assert.equal(adapter.snapshot().dialogs.length, 0);
});

void test('real Pi input components honor each session keybindings and bracketed paste', async t => {
  type Component = Awaited<
    ReturnType<Parameters<DesktopExtensionUI['context']['custom']>[0]>
  >;
  const {Input} = (await import(
    pathToFileURL(
      createRequire(
        import.meta.resolve('@earendil-works/pi-coding-agent'),
      ).resolve('@earendil-works/pi-tui'),
    ).href
  )) as {
    Input: new () => Component & {onSubmit?: (value: string) => void};
  };
  const first = new DesktopExtensionUI(() => {});
  const second = new DesktopExtensionUI(() => {});
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  const changed = first.context.custom<string>(
    (_screen, _theme, keys, done) => {
      keys.setUserBindings({
        'tui.editor.deleteCharBackward': 'ctrl+q',
        'tui.input.submit': 'enter',
      });
      const input = new Input();
      input.onSubmit = done;
      return input;
    },
  );
  const normal = second.context.custom<string>(
    (_screen, _theme, keys, done) => {
      keys.setUserBindings({'tui.input.submit': 'enter'});
      const input = new Input();
      input.onSubmit = done;
      return input;
    },
  );
  await waitFor(
    () =>
      first.snapshot().dialogs[0].terminal!.output.includes('> ') &&
      second.snapshot().dialogs[0].terminal!.output.includes('> '),
  );
  first.respond(first.snapshot().dialogs[0].id, 'ab\x11\r');
  second.respond(second.snapshot().dialogs[0].id, '\x1b[200~ab\x1b[201~\x11\r');
  assert.equal(await changed, 'a');
  assert.equal(await normal, 'ab');
});

void test('configured custom editor and stacked autocomplete operate in the virtual editor modal', async t => {
  type Factory = NonNullable<
    Parameters<DesktopExtensionUI['context']['setEditorComponent']>[0]
  >;
  const {CustomEditor} = (await import(
    new URL(
      './modes/interactive/components/custom-editor.js',
      import.meta.resolve('@earendil-works/pi-coding-agent'),
    ).href
  )) as {
    CustomEditor: new (...args: Parameters<Factory>) => ReturnType<Factory>;
  };
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  const ui = adapter.context;
  adapter.configureBaseAutocomplete(process.cwd(), [
    {name: 'example'},
    {name: 'extra'},
  ]);
  const factory: Factory = (screen, theme, keys) => {
    keys.setUserBindings({
      'tui.input.submit': 'enter',
      'tui.input.tab': 'tab',
      'tui.select.confirm': 'enter',
    });
    assert.equal(typeof theme.borderColor('Border'), 'string');
    const editor = new CustomEditor(screen, theme, keys);
    const input = editor.handleInput.bind(editor);
    editor.handleInput = data => {
      if (data === '!') {
        editor.setText(`${editor.getText()}-custom`);
        screen.requestRender();
      } else input(data);
    };
    return editor;
  };
  ui.setEditorComponent(factory);
  assert.equal(ui.getEditorComponent(), factory);
  let baseReturnedCommands = false;
  let secondWrapperCalled = false;
  ui.addAutocompleteProvider(current => ({
    ...current,
    getSuggestions: async (...args) => {
      const result = await current.getSuggestions(...args);
      baseReturnedCommands = !!result?.items.some(item =>
        item.value.includes('example'),
      );
      return result;
    },
    applyCompletion: (...args) => current.applyCompletion(...args),
  }));
  ui.addAutocompleteProvider(current => ({
    getSuggestions: async (...args) => {
      secondWrapperCalled = true;
      const result = await current.getSuggestions(...args);
      return (
        result && {
          ...result,
          items: result.items.map(item => ({
            ...item,
            label: `Wrapped ${item.label}`,
          })),
        }
      );
    },
    applyCompletion: (...args) => {
      const completed = current.applyCompletion(...args);
      const text = `[completed] ${completed.lines.join('\n')}`;
      return {lines: [text], cursorLine: 0, cursorCol: text.length};
    },
  }));
  const snapshot = adapter.snapshot();
  const buttonId = snapshot.extensionEditor!.id;
  snapshot.extensionEditor!.id = 'Mutated';
  assert.equal(adapter.snapshot().extensionEditor!.id, buttonId);
  assert.equal(adapter.respond(buttonId, '/ex'), undefined);
  assert.equal(adapter.snapshot().dialogs[0].title, 'Extension editor');
  adapter.respond(buttonId, 'Duplicate');
  assert.equal(adapter.snapshot().dialogs.length, 1);
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('/ex'),
  );
  const dialogId = adapter.snapshot().dialogs[0].id;
  adapter.respond(dialogId, '\t');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('Wrapped'),
  );
  assert.equal(baseReturnedCommands, true);
  assert.equal(secondWrapperCalled, true);
  adapter.respond(dialogId, '\t');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('[completed]'),
  );
  adapter.respond(dialogId, '!\r');
  await waitFor(
    () =>
      adapter.snapshot().dialogs.length === 0 &&
      adapter.snapshot().editor !== undefined,
  );
  assert.equal(ui.getEditorText(), '[completed] /example -custom');
  assert.equal(adapter.snapshot().editor!.text, '[completed] /example -custom');
  ui.setEditorComponent(undefined);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.ok(
    adapter.snapshot().extensionEditor,
    'autocomplete wrappers keep the editor button available',
  );
});

void test('wrapper-only editor submits into the composer and cancellation preserves the draft', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  const ui = adapter.context;
  ui.setEditorText('Before');
  ui.addAutocompleteProvider(() => ({
    getSuggestions: async () => ({
      prefix: '@',
      items: [{value: 'completed', label: 'Completed'}],
    }),
    applyCompletion: (_lines, _line, _column, item) => ({
      lines: [item.value],
      cursorLine: 0,
      cursorCol: item.value.length,
    }),
  }));
  const originalCommandId = adapter.snapshot().editor!.id;
  adapter.respond(adapter.snapshot().extensionEditor!.id, 'Draft to preserve');
  await waitFor(() =>
    adapter
      .snapshot()
      .dialogs[0].terminal!.output.includes('Draft to preserve'),
  );
  adapter.respond(adapter.snapshot().dialogs[0].id);
  await waitFor(() => adapter.snapshot().dialogs.length === 0);
  assert.equal(ui.getEditorText(), 'Draft to preserve');
  assert.equal(adapter.snapshot().editor!.id, originalCommandId);
  await delay(0);
  adapter.respond(adapter.snapshot().extensionEditor!.id, '@');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('@'),
  );
  const id = adapter.snapshot().dialogs[0].id;
  adapter.respond(id, '\t');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('completed'),
  );
  adapter.respond(id, '\r');
  await waitFor(
    () =>
      adapter.snapshot().dialogs.length === 0 &&
      adapter.snapshot().editor!.id !== originalCommandId,
  );
  assert.equal(ui.getEditorText(), 'completed');
  assert.equal(adapter.snapshot().editor!.text, 'completed');
});

void test('extension editor setup errors become notifications without unhandled rejection', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  adapter.context.setEditorComponent(() => {
    throw new Error('Editor factory failed');
  });
  adapter.respond(adapter.snapshot().extensionEditor!.id, 'Draft');
  await waitFor(() =>
    adapter
      .snapshot()
      .notifications.some(item =>
        item.message.includes('Editor factory failed'),
      ),
  );
  assert.equal(adapter.snapshot().dialogs.length, 0);
  assert.equal(adapter.context.getEditorText(), 'Draft');
  adapter.context.setEditorComponent(undefined);
  assert.equal(adapter.snapshot().extensionEditor, undefined);
});

void test('extension reload resets registrations and dialogs while preserving the native draft', async t => {
  type Factory = NonNullable<
    Parameters<DesktopExtensionUI['context']['setEditorComponent']>[0]
  >;
  const {Editor} = (await import(
    pathToFileURL(
      createRequire(
        import.meta.resolve('@earendil-works/pi-coding-agent'),
      ).resolve('@earendil-works/pi-tui'),
    ).href
  )) as {
    Editor: new (
      screen: Parameters<Factory>[0],
      theme: Parameters<Factory>[1],
    ) => ReturnType<Factory>;
  };
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  const ui = adapter.context;
  let oldWrapperCalls = 0;
  let oldRawCalls = 0;
  let disposedViews = 0;
  const editorFactory: Factory = (screen, theme, keys) => {
    keys.setUserBindings({'tui.input.submit': 'enter', 'tui.input.tab': 'tab'});
    return new Editor(screen, theme);
  };
  ui.setEditorComponent(editorFactory);
  ui.addAutocompleteProvider(current => {
    oldWrapperCalls++;
    return current;
  });
  ui.onTerminalInput(() => {
    oldRawCalls++;
    return undefined;
  });
  ui.setStatus('removed-extension', 'Old status');
  ui.notify('Old notification');
  ui.setWidget('old-view', () => ({
    render: () => ['Old widget'],
    invalidate: () => {},
    dispose: () => {
      disposedViews++;
      ui.setEditorText('Cleanup must not overwrite the native draft');
      ui.setStatus('cleanup', 'Must be cleared');
    },
  }));
  const oldButtonId = adapter.snapshot().extensionEditor!.id;
  adapter.respond(oldButtonId, 'Old draft');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('Old draft'),
  );
  adapter.respond(adapter.snapshot().dialogs[0].id, '\r');
  // The previous modal's submission is resolved, but its composer update is
  // still queued. Reload must discard that update after taking the new draft.
  ui.setEditorText('Latest native draft');
  const commandId = adapter.snapshot().editor!.id;
  const confirm = ui.confirm('Old confirm', 'Pending');
  const abort = new AbortController();
  const input = ui.input('Old input', undefined, {
    signal: abort.signal,
    timeout: 60000,
  });
  adapter.resetExtensions();
  assert.equal(await confirm, false);
  assert.equal(await input, undefined);
  await delay(0);
  assert.equal(disposedViews, 1);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.getEditorText(), 'Latest native draft');
  assert.deepEqual(adapter.snapshot(), {
    dialogs: [],
    notifications: [],
    statuses: [],
    editor: {id: commandId, text: 'Latest native draft'},
  });
  const oldWrapperCount = oldWrapperCalls;
  const oldRawCount = oldRawCalls;
  adapter.configureBaseAutocomplete(process.cwd(), [{name: 'reloaded'}]);
  let newWrapperCalls = 0;
  ui.addAutocompleteProvider(current => {
    newWrapperCalls++;
    return current;
  });
  ui.setStatus('new-extension', 'New status');
  adapter.respond(oldButtonId, 'Stale click');
  assert.equal(adapter.snapshot().dialogs.length, 0);
  adapter.respond(adapter.snapshot().extensionEditor!.id, '/relo');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('/relo'),
  );
  abort.abort();
  assert.equal(adapter.snapshot().dialogs.length, 1);
  const dialogId = adapter.snapshot().dialogs[0].id;
  adapter.respond(dialogId, '\t');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('reloaded'),
  );
  adapter.respond(dialogId, '\t');
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('/reloaded'),
  );
  adapter.respond(dialogId, '\r');
  await waitFor(() => adapter.snapshot().editor!.id !== commandId);
  assert.equal(ui.getEditorText(), '/reloaded');
  assert.equal(newWrapperCalls, 1);
  assert.equal(oldWrapperCalls, oldWrapperCount);
  assert.equal(oldRawCalls, oldRawCount);
  assert.deepEqual(adapter.snapshot().statuses, [
    {key: 'new-extension', text: 'New status'},
  ]);
});

void test('terminal dialogs queue factories and dispose async results after cancellation', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  const first = adapter.context.input('First');
  let called = 0;
  let disposed = 0;
  let supply:
    | ((component: {
        render(width: number): string[];
        invalidate(): void;
        dispose(): void;
      }) => void)
    | undefined;
  const later = adapter.context.custom(async () => {
    called++;
    return new Promise(resolve => {
      supply = resolve;
    });
  });
  assert.equal(called, 0);
  adapter.respond(adapter.snapshot().dialogs[0].id, 'Done');
  assert.equal(await first, 'Done');
  await waitFor(() => called === 1);
  adapter.cancelDialogs();
  assert.equal(await later, undefined);
  supply!({
    render: () => ['Late'],
    invalidate: () => {},
    dispose: () => {
      disposed++;
    },
  });
  await waitFor(() => disposed === 1);
  assert.equal(adapter.snapshot().dialogs.length, 0);
  const queuedFirst = adapter.context.input('Blocked');
  const neverStarted = adapter.context.custom(() => {
    called++;
    return {render: () => ['Never'], invalidate: () => {}};
  });
  adapter.cancelDialogs();
  assert.equal(await queuedFirst, undefined);
  assert.equal(await neverStarted, undefined);
  assert.equal(called, 1);
});

void test('terminal overlays expose real handles and cancellation disposes components', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  let handle:
    | Parameters<
        NonNullable<
          Parameters<typeof adapter.context.custom>[1]
        >['onHandle'] & {}
      >[0]
    | undefined;
  let disposed = 0;
  const result = adapter.context.custom(
    () => ({
      render: () => ['Overlay content'],
      invalidate: () => {},
      dispose: () => {
        disposed++;
      },
    }),
    {
      overlay: true,
      overlayOptions: () => ({width: 40}),
      onHandle: supplied => {
        handle = supplied;
      },
    },
  );
  await waitFor(() => handle !== undefined);
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.includes('Overlay content'),
  );
  handle!.setHidden(true);
  assert.equal(handle!.isHidden(), true);
  handle!.setHidden(false);
  adapter.respond(adapter.snapshot().dialogs[0].id);
  assert.equal(await result, undefined);
  assert.equal(disposed, 1);
});

void test('long terminal history resets to a complete bounded screen', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  let terminal:
    | Parameters<Parameters<typeof adapter.context.custom>[0]>[0]['terminal']
    | undefined;
  const result = adapter.context.custom(screen => {
    terminal = screen.terminal;
    return {render: () => ['Current screen'], invalidate: () => {}};
  });
  await waitFor(
    () =>
      adapter
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Current screen') === true,
  );
  const id = adapter.snapshot().dialogs[0].id;
  terminal!.write('x'.repeat(200000));
  const before = adapter.snapshot().dialogs[0].terminal!.output;
  terminal!.write('y'.repeat(200000));
  await waitFor(() =>
    adapter.snapshot().dialogs[0].terminal!.output.startsWith('\x1bc'),
  );
  const fresh = adapter.snapshot().dialogs[0].terminal!;
  assert.ok(fresh.output.length <= 262144);
  assert.ok(!fresh.output.startsWith(before));
  assert.ok(fresh.output.includes('Current screen'));
  adapter.respond(id);
  assert.equal(await result, undefined);
});

void test('component widgets, headers and footers refresh visible rows and dispose replacements', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  let value = 'Initial';
  let renderer:
    Parameters<Parameters<typeof adapter.context.custom>[0]>[0] | undefined;
  let disposed = 0;
  adapter.context.setWidget('component', (screen, theme) => {
    renderer = screen;
    return {
      render: () => [theme.fg('accent', value)],
      invalidate: () => {},
      dispose: () => {
        disposed++;
      },
    };
  });
  adapter.context.setHeader(() => ({
    render: () => ['Header'],
    invalidate: () => {},
  }));
  adapter.context.setStatus('task', 'Running');
  adapter.context.setFooter((_screen, _theme, data) => ({
    render: () => [`Footer: ${data.getExtensionStatuses().get('task')}`],
    invalidate: () => {},
  }));
  assert.ok(
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'ui:header' && item.text === 'Header',
      ),
  );
  assert.ok(
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'ui:footer' && item.text === 'Footer: Running',
      ),
  );
  assert.ok(
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'widget:component' && item.text === 'Initial',
      ),
  );
  adapter.context.setStatus('task', 'Done');
  await waitFor(() =>
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'ui:footer' && item.text === 'Footer: Done',
      ),
  );
  value = 'Changed';
  renderer!.requestRender(true);
  await waitFor(() =>
    adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'widget:component' && item.text === 'Changed',
      ),
  );
  adapter.context.setWidget('component', ['Plain replacement']);
  assert.equal(disposed, 1);
  assert.ok(
    adapter
      .snapshot()
      .statuses.some(
        item =>
          item.key === 'widget:component' && item.text === 'Plain replacement',
      ),
  );
  adapter.context.setHeader(undefined);
  adapter.context.setFooter(undefined);
  assert.ok(
    !adapter
      .snapshot()
      .statuses.some(
        item => item.key === 'ui:header' || item.key === 'ui:footer',
      ),
  );
});

void test('terminal factory and render failures reject with visible errors', async t => {
  const adapter = new DesktopExtensionUI(() => {});
  t.after(() => adapter.dispose());
  await assert.rejects(
    adapter.context.custom(() => {
      throw new Error('Factory broke');
    }),
    /Factory broke/,
  );
  await assert.rejects(
    adapter.context.custom(() => ({
      render: () => {
        throw new Error('Render broke');
      },
      invalidate: () => {},
    })),
    /Render broke/,
  );
  assert.equal(adapter.snapshot().notifications.length, 2);
  assert.ok(
    adapter.snapshot().notifications.every(item => item.type === 'error'),
  );
  assert.equal(adapter.snapshot().dialogs.length, 0);
});

void test('aborting dialogs preserves display state and permits later interactions', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const adapter = new DesktopExtensionUI(() => {});
  const ui = adapter.context;
  ui.setStatus('activity', 'Ready');
  ui.notify('Welcome');
  ui.setEditorText('Draft');
  const abort = new AbortController();
  const confirm = ui.confirm('Confirm', 'Waiting', {timeout: 10});
  const input = ui.input('Input', undefined, {signal: abort.signal});
  adapter.cancelDialogs();
  assert.equal(await confirm, false);
  assert.equal(await input, undefined);
  assert.equal(adapter.snapshot().dialogs.length, 0);
  assert.equal(adapter.snapshot().notifications[0].message, 'Welcome');
  assert.equal(adapter.snapshot().statuses[0].text, 'Ready');
  assert.equal(adapter.snapshot().editor!.text, 'Draft');
  const later = ui.input('Later');
  abort.abort();
  t.mock.timers.tick(10);
  assert.equal(adapter.snapshot().dialogs.length, 1);
  adapter.respond(adapter.snapshot().dialogs[0].id, 'Accepted');
  assert.equal(await later, 'Accepted');
  adapter.dispose();
});

void test('public state stays bounded and excess dialogs fail instead of hanging', async () => {
  const adapter = new DesktopExtensionUI(() => {});
  const ui = adapter.context;
  for (let index = 0; index < 150; index++)
    ui.notify(`${index}: ${'x'.repeat(20000)}`);
  assert.equal(adapter.snapshot().notifications.length, 100);
  assert.ok(
    adapter
      .snapshot()
      .notifications.every(item => item.message.length <= 16384),
  );
  assert.ok(adapter.snapshot().notifications[0].message.startsWith('50:'));
  const dialogs = Array.from({length: 32}, () => ui.input('Pending'));
  await assert.rejects(ui.input('Overflow'), /size or queue limit/);
  assert.equal(adapter.snapshot().dialogs.length, 32);
  assert.equal(adapter.snapshot().notifications.at(-1)!.type, 'error');
  adapter.dispose();
  assert.deepEqual(await Promise.all(dialogs), Array(32).fill(undefined));
});
