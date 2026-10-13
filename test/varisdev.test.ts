import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import registerVarisdev from '../extensions/varisdev.ts';

type EventHandler = (
  event: {type: string; reason?: string},
  ctx: ExtensionContext,
) => void | Promise<void>;

function createExtension(t: TestContext, folder: string) {
  const handlers = new Map<string, EventHandler[]>();
  const titles: string[] = [];
  const sessionId = randomUUID();
  let active = true;
  const ctx = new Proxy(
    {
      cwd: `/projects/${folder}`,
      mode: 'rpc',
      hasUI: true,
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [],
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        getHeader: () => undefined,
      },
      getContextUsage: () => undefined,
      isIdle: () => true,
      thinkingLevel: 'off',
      ui: {
        setTitle(title: string) {
          assert.ok(active, 'stale extension UI');
          titles.push(title);
        },
      },
    } as unknown as ExtensionContext,
    {
      get(target, key, receiver) {
        assert.ok(active, 'stale extension context');
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const pi = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    registerMarkdownTransformer() {},
    events: {on: () => () => {}},
  } as unknown as ExtensionAPI;
  registerVarisdev(pi);

  async function emit(type: string, reason?: string) {
    for (const handler of handlers.get(type) ?? []) {
      await handler({type, reason}, ctx);
    }
  }
  async function shutdown(reason = 'new') {
    if (!active) return;
    await emit('session_shutdown', reason);
    active = false;
  }
  t.after(() => shutdown('quit'));
  return {titles, emit, shutdown};
}

void test('title timers release the old context before session replacement', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const originalTitle = process.title;
  t.after(() => {
    process.title = originalTitle;
  });

  for (const reason of ['new', 'reload']) {
    const previous = createExtension(t, 'previous');
    await previous.emit('session_start', 'startup');
    // Completion also schedules delayed title updates before the user
    // replaces the session or reloads the extension.
    await previous.emit('agent_end');
    assert.equal(previous.titles.at(-1), 'VarisDev - previous');
    await previous.shutdown(reason);
    const previousCount = previous.titles.length;

    // Let all pending callbacks become due while the old context is stale,
    // including the gap before the replacement extension is registered.
    t.mock.timers.tick(5000);
    assert.equal(previous.titles.length, previousCount);

    const replacement = createExtension(t, 'replacement');
    await replacement.emit('session_start', reason);
    t.mock.timers.tick(1000);
    const replacementCount = replacement.titles.length;
    t.mock.timers.tick(4000);
    assert.ok(replacement.titles.length > replacementCount);
    assert.ok(
      replacement.titles.every(title => title === 'VarisDev - replacement'),
    );
    assert.equal(previous.titles.length, previousCount);

    await replacement.shutdown();
    const stoppedCount = replacement.titles.length;
    t.mock.timers.tick(5000);
    assert.equal(replacement.titles.length, stoppedCount);
  }
});

void test('each extension registration owns its title timers', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const originalTitle = process.title;
  t.after(() => {
    process.title = originalTitle;
  });
  const first = createExtension(t, 'first');
  const second = createExtension(t, 'second');
  await first.emit('session_start', 'startup');
  await second.emit('session_start', 'startup');
  t.mock.timers.tick(1000);

  await first.shutdown();
  const firstCount = first.titles.length;
  const secondCount = second.titles.length;
  t.mock.timers.tick(4000);
  assert.equal(first.titles.length, firstCount);
  assert.ok(second.titles.length > secondCount);
  assert.equal(second.titles.at(-1), 'VarisDev - second');
});
