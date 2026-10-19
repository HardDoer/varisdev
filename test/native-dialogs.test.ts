import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  nativeCommands,
  parseSlashCommand,
} from '../assets/dashboard/command-catalog.js';

void test('native command catalog covers Pi builtins and approval management with one explicit route', async () => {
  const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
  const {BUILTIN_SLASH_COMMANDS} = await import(
    new URL('./core/slash-commands.js', sdk).href
  );
  assert.deepEqual(
    nativeCommands.map(item => item.name).sort(),
    [
      ...BUILTIN_SLASH_COMMANDS.map((item: {name: string}) => item.name),
      'approvals',
    ].sort(),
  );
  assert.equal(
    new Set(nativeCommands.map(item => item.name)).size,
    nativeCommands.length,
  );
  for (const command of nativeCommands) {
    assert.ok(['session', 'desktop'].includes(command.target));
    assert.equal(typeof command.live, 'boolean');
  }
  assert.deepEqual(parseSlashCommand(' /thinking   high  '), {
    name: 'thinking',
    args: 'high',
  });
  assert.deepEqual(parseSlashCommand('/plugin:command first\nsecond'), {
    name: 'plugin:command',
    args: 'first\nsecond',
  });
  assert.equal(parseSlashCommand('ordinary prompt /thinking'), undefined);
});

void test('native selectors retain current values and search without relaxing plugin limits', async () => {
  const ui = new DesktopExtensionUI(() => {});
  try {
    const choices = Array.from({length: 1000}, (_, i) => `Model ${i}`);
    const result = ui.select('Model', choices, {
      selected: 'Model 400',
      searchable: true,
      message: 'Current session only.',
    });
    const first = ui.snapshot().dialogs[0];
    assert.equal(first.selected, 'Model 400');
    assert.equal(first.searchable, true);
    assert.equal(first.message, 'Current session only.');
    first.options![0] = 'Mutated';
    assert.equal(ui.snapshot().dialogs[0].options![0], 'Model 0');
    ui.respond(first.id, 'not a choice');
    assert.equal(ui.snapshot().dialogs.length, 1);
    ui.respond(first.id, 'Model 900');
    assert.equal(await result, 'Model 900');
    await assert.rejects(
      ui.context.select('Plugin', choices),
      /size or queue limit/,
    );
  } finally {
    ui.dispose();
  }
});

void test('read-only command info dialogs close and cancellation prevents reopening', async () => {
  const ui = new DesktopExtensionUI(() => {});
  try {
    const controller = new AbortController();
    const scoped = ui.forCommand(controller.signal);
    const info = scoped.show('Session', 'Session information');
    assert.equal(ui.snapshot().dialogs[0].kind, 'info');
    ui.respond(ui.snapshot().dialogs[0].id, true);
    await info;
    const choice = scoped.select('Thinking', ['off', 'high']);
    controller.abort();
    assert.equal(await choice, undefined);
    assert.equal(await scoped.select('Settings', ['Never reopen']), undefined);
    assert.equal(await scoped.context.confirm('Stopped', 'Do not show'), false);
    assert.equal(await scoped.context.input('Stopped'), undefined);
    await scoped.show('Stopped', 'Do not show');
    scoped.navigate('/workspace', 'cancelled');
    assert.deepEqual(ui.snapshot().dialogs, []);
    assert.equal(ui.snapshot().navigation, undefined);
  } finally {
    ui.dispose();
  }
});

void test('prepared session navigation is isolated, acknowledged once and cancelled on stop', () => {
  const ui = new DesktopExtensionUI(() => {});
  try {
    ui.navigate('/workspace', 'fork-id', 'Restored draft');
    const next = ui.snapshot().navigation!;
    next.cwd = '/mutated';
    assert.equal(ui.snapshot().navigation!.cwd, '/workspace');
    ui.respond('stale');
    assert.ok(ui.snapshot().navigation);
    ui.respond(next.id);
    assert.equal(ui.snapshot().navigation, undefined);
    ui.navigate('/workspace', 'second-id');
    ui.cancelDialogs();
    assert.equal(ui.snapshot().navigation, undefined);
  } finally {
    ui.dispose();
  }
});
