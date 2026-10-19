import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {
  ExtensionSelectorComponent,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  runReportCommand,
  type ReportCommandContext,
  type ReportCommandDependencies,
} from '../src/dashboard/report-commands.ts';
import {showSessionView} from '../src/dashboard/native-session-views.ts';

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for UI state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function closeDialog(ui: DesktopExtensionUI): void {
  const dialog = ui.snapshot().dialogs[0];
  assert.ok(dialog);
  ui.respond(dialog.id, '\r');
}

function fixture(t: TestContext, signal?: AbortSignal) {
  const ui = new DesktopExtensionUI(() => {});
  t.after(() => ui.dispose());
  let exportOptions: {themeName?: string} | undefined;
  const session = {
    sessionId: 'real-session-boundary',
    settingsManager: {getTheme: () => 'dark'},
    exportToHtml: async (_path: string, options?: {themeName?: string}) => {
      exportOptions = options;
      return '/tmp/session.html';
    },
  } as unknown as AgentSession;
  const calls: Array<{kind: string; context: unknown; hint?: string}> = [];
  const dependencies: ReportCommandDependencies = {
    shareSession: async context => {
      calls.push({kind: 'share', context});
      await context.session.exportToHtml('/tmp/session.html', {
        themeName: 'unscoped-theme',
      });
      context.showStatus('Stubbed Pi share completed.');
    },
    reportBug: async (context, hint) => {
      calls.push({kind: 'bug', context, hint});
      context.showStatus(`Stubbed Pi bug flow: ${hint ?? 'no hint'}`);
    },
  };
  const context: ReportCommandContext = {
    session,
    ui,
    signal,
    dependencies,
  };
  return {ui, session, calls, context, exportOptions: () => exportOptions};
}

void test('unhandled report commands do nothing', async t => {
  const f = fixture(t);
  assert.equal(await runReportCommand('export', '', f.context), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.ui.snapshot().dialogs, []);
});

void test('share and changelog reject arguments before invoking Pi', async t => {
  for (const name of ['share', 'changelog']) {
    const f = fixture(t);
    assert.equal(await runReportCommand(name, 'unexpected', f.context), true);
    assert.deepEqual(f.calls, []);
    assert.equal(f.ui.snapshot().dialogs.length, 0);
    assert.deepEqual(f.ui.snapshot().notifications.at(-1), {
      id: f.ui.snapshot().notifications.at(-1)?.id,
      message: `Usage: /${name}`,
      type: 'error',
    });
  }
});

void test('share uses the shipped-flow host with the real session and no test upload', async t => {
  const f = fixture(t);
  const pending = runReportCommand('share', '', f.context);
  await waitFor(() =>
    Boolean(
      f.ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Stubbed Pi share completed.'),
    ),
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].kind, 'share');
  const hosted = f.calls[0].context as {
    session: AgentSession;
    editorContainer: {children: unknown[]};
    editor: unknown;
    ui: {requestRender(): void};
    keybindings: unknown;
  };
  assert.equal(hosted.session.sessionId, f.session.sessionId);
  assert.ok(hosted.editorContainer.children.length > 0);
  assert.ok(hosted.editor);
  assert.equal(typeof hosted.ui.requestRender, 'function');
  assert.ok(hosted.keybindings);
  assert.equal(f.exportOptions()?.themeName, 'dark');
  closeDialog(f.ui);
  assert.equal(await pending, true);
});

void test('bug hosts Pi terminal prompts and passes the hint without a parallel flow', async t => {
  const f = fixture(t);
  f.context.dependencies = {
    ...f.context.dependencies,
    reportBug: (context, hint) =>
      new Promise<void>(resolve => {
        f.calls.push({kind: 'bug', context, hint});
        const finish = (message: string) => {
          context.showStatus(message);
          resolve();
        };
        const selector = new ExtensionSelectorComponent(
          'Stubbed Pi bug prompt',
          ['Continue'],
          () => finish(`Stubbed Pi bug flow: ${hint ?? 'no hint'}`),
          () => finish('Stubbed Pi bug cancelled.'),
          {tui: context.ui},
        );
        context.editorContainer.clear();
        context.editorContainer.addChild(selector);
        context.ui.setFocus(selector);
        context.ui.requestRender();
      }),
  };
  const pending = runReportCommand('bug', 'renderer failed', f.context);
  await waitFor(() =>
    Boolean(
      f.ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes('Stubbed Pi bug prompt'),
    ),
  );
  f.ui.respond(f.ui.snapshot().dialogs[0].id, '\r');
  await waitFor(() =>
    Boolean(
      f.ui
        .snapshot()
        .dialogs[0]?.terminal?.output.includes(
          'Stubbed Pi bug flow: renderer failed',
        ),
    ),
  );
  assert.deepEqual(
    f.calls.map(call => [call.kind, call.hint]),
    [['bug', 'renderer failed']],
  );
  closeDialog(f.ui);
  assert.equal(await pending, true);
});

void test('session cancellation disposes and cancels the hosted Pi operation', async t => {
  const controller = new AbortController();
  const f = fixture(t, controller.signal);
  let escaped = false;
  let disposed = false;
  let started = false;
  f.context.dependencies = {
    ...f.context.dependencies,
    shareSession: context =>
      new Promise<void>(resolve => {
        started = true;
        const operation = {
          render: () => ['Stubbed upload in progress'],
          invalidate: () => {},
          handleInput: (data: string) => {
            if (data === '\x1b') {
              escaped = true;
              resolve();
            }
          },
          dispose: () => {
            disposed = true;
          },
        };
        context.editorContainer.clear();
        context.editorContainer.addChild(operation);
        context.ui.setFocus(operation);
        context.ui.requestRender();
      }),
  };
  const pending = runReportCommand('share', '', f.context);
  await waitFor(() => started);
  controller.abort();
  assert.equal(await pending, true);
  assert.equal(escaped, true);
  assert.equal(disposed, true);
  assert.equal(f.ui.snapshot().dialogs.length, 0);
});

void test('changelog uses Pi Markdown parsing and terminal rendering', async t => {
  const f = fixture(t);
  const session = {
    settingsManager: {getCodeBlockIndent: () => '  '},
  } as unknown as AgentSession;
  const pending = runReportCommand('changelog', '', {
    ...f.context,
    session,
  });
  await waitFor(
    () =>
      /https:\/\/github\.com\/earendil-works\/pi\/(?:issues|pull)\//.test(
        f.ui.snapshot().dialogs[0]?.terminal?.output ?? '',
      ),
    10_000,
  );
  const output = f.ui.snapshot().dialogs[0].terminal!.output;
  assert.match(
    output,
    /https:\/\/github\.com\/earendil-works\/pi\/(?:issues|pull)\//,
  );
  assert.equal(f.calls.length, 0);
  closeDialog(f.ui);
  assert.equal(await pending, true);
});

void test('session view delegates to Pi and includes cache warming and cost detail', async t => {
  const ui = new DesktopExtensionUI(() => {});
  t.after(() => ui.dispose());
  const session = {
    getSessionStats: () => ({
      sessionFile: '/sessions/test.jsonl',
      sessionId: 'session-id',
      totalMessages: 3,
      userMessages: 1,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      tokens: {
        input: 100,
        output: 40,
        cacheRead: 50,
        cacheWrite: 10,
        total: 200,
      },
      cost: 1.25,
    }),
    sessionManager: {
      getSessionName: () => 'Native session',
      getEntries: () => [],
    },
    settingsManager: {getCacheWarmingMode: () => 'idle'},
    modelRuntime: {},
    cacheWarmingStatus: undefined,
    model: {provider: 'fixture', id: 'model'},
  } as unknown as AgentSession;
  const pending = showSessionView({session, ui});
  await waitFor(
    () =>
      ui.snapshot().dialogs[0]?.terminal?.output.includes('Cache Warming') ===
      true,
    10_000,
  );
  const output = ui.snapshot().dialogs[0].terminal!.output;
  assert.match(output, /Session Info/);
  assert.match(output, /Native session/);
  assert.match(output, /Cache Warming/);
  assert.match(output, /idle/);
  assert.match(output, /\$1\.250/);
  assert.match(output, /Cached/);
  closeDialog(ui);
  await pending;
});
