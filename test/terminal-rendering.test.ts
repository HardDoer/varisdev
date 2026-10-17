import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {IPty} from '@lydell/node-pty';
import {
  DesktopTerminals,
  type TerminalSnapshot,
} from '../src/desktop/terminal.ts';
import {createTerminalTabs} from '../assets/dashboard/terminal.js';

const wait = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

void test('desktop terminal batches bursts, bounds history and orders exit events', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-terminal-burst-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  let dataListener: (data: string) => void = () => {};
  let exitListener: (event: {exitCode: number}) => void = () => {};
  let dataDisposed = false;
  let exitDisposed = false;
  let killed = false;
  const pty = {
    write() {},
    resize() {},
    kill() {
      killed = true;
    },
    onData(listener: (data: string) => void) {
      dataListener = listener;
      return {dispose: () => (dataDisposed = true)};
    },
    onExit(listener: (event: {exitCode: number}) => void) {
      exitListener = listener;
      return {dispose: () => (exitDisposed = true)};
    },
  } as unknown as IPty;
  const events: TerminalSnapshot[] = [];
  const terminals = new DesktopTerminals(
    event => events.push(event),
    async () =>
      ({spawn: () => pty}) as unknown as typeof import('@lydell/node-pty'),
  );
  t.after(() => terminals.dispose());

  const initial = await terminals.open('burst', cwd);
  assert.equal(initial.sequence, 0);
  for (let index = 0; index < 5000; index++) dataListener('x');
  await wait(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'x'.repeat(5000));

  dataListener('before-snapshot');
  const snapshot = await terminals.open('burst', cwd);
  assert.equal(events.at(-1)?.data, 'before-snapshot');
  assert.equal(snapshot.sequence, events.at(-1)?.sequence);
  assert.ok(snapshot.data.endsWith('before-snapshot'));

  const unicode = '🙂'.repeat(200_000);
  const beforeUnicode = events.length;
  dataListener(unicode);
  const unicodeEvents = events.slice(beforeUnicode);
  assert.equal(unicodeEvents.map(event => event.data).join(''), unicode);
  assert.ok(unicodeEvents.every(event => event.data.length <= 256 * 1024));
  for (const [index, event] of unicodeEvents.entries()) {
    assert.doesNotMatch(event.data.at(0) || '', /[\uDC00-\uDFFF]/);
    assert.doesNotMatch(event.data.at(-1) || '', /[\uD800-\uDBFF]/);
    if (index) assert.ok(unicodeEvents[index - 1].sequence < event.sequence);
  }
  const bounded = await terminals.open('burst', cwd);
  assert.ok(bounded.data.length <= 256 * 1024);
  assert.doesNotMatch(bounded.data.at(0) || '', /[\uDC00-\uDFFF]/);

  dataListener('last-output');
  exitListener({exitCode: 7});
  assert.equal(events.at(-2)?.data, 'last-output');
  assert.equal(events.at(-1)?.exitCode, 7);
  assert.equal(events.at(-1)?.sequence, (events.at(-2)?.sequence || 0) + 1);
  assert.equal(dataDisposed, true);
  assert.equal(exitDisposed, true);
  terminals.close('burst');
  assert.equal(killed, false, 'An exited pty is not killed again');
});

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  hidden = false;
  disabled = false;
  required = false;
  tabIndex = 0;
  textContent = '';
  parent?: FakeElement;
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, Set<(event: FakeEvent) => void>>();
  readonly classList = {toggle() {}};

  append(...children: FakeElement[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(item => item !== this);
    this.parent = undefined;
  }
  addEventListener(type: string, callback: (event: FakeEvent) => void) {
    const handlers = this.handlers.get(type) || new Set();
    handlers.add(callback);
    this.handlers.set(type, handlers);
  }
  removeEventListener(type: string, callback: (event: FakeEvent) => void) {
    this.handlers.get(type)?.delete(callback);
  }
  dispatch(type: string, event = new FakeEvent()) {
    for (const callback of this.handlers.get(type) || []) callback(event);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getClientRects() {
    return [{}];
  }
  focus() {
    fakeDocument.activeElement = this;
  }
}

class FakeEvent {
  key = '';
  preventDefault() {}
}

const elements = new Map<string, FakeElement>();
const fakeDocument = {
  activeElement: undefined as FakeElement | undefined,
  getElementById(id: string) {
    return elements.get(id);
  },
  createElement() {
    return new FakeElement();
  },
};

class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  options: {disableStdin?: boolean} = {};
  writes: string[] = [];
  callbacks: Array<() => void> = [];
  activeWrites = 0;
  peakWrites = 0;
  resets = 0;
  disposed = false;
  inputDisposed = false;

  constructor() {
    FakeTerminal.instances.push(this);
  }
  loadAddon() {}
  open() {}
  focus() {}
  onData() {
    return {dispose: () => (this.inputDisposed = true)};
  }
  write(data: string, callback: () => void) {
    this.writes.push(data);
    this.activeWrites++;
    this.peakWrites = Math.max(this.peakWrites, this.activeWrites);
    this.callbacks.push(() => {
      this.activeWrites--;
      callback();
    });
  }
  reset() {
    this.resets++;
    this.writes = [];
  }
  dispose() {
    this.disposed = true;
  }
  completeWrite() {
    this.callbacks.shift()?.();
  }
}

class FakeFitAddon {
  fit() {}
}

class FakeResizeObserver {
  disconnected = false;
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

function rendererHarness(openTerminal: () => Promise<TerminalSnapshot>) {
  elements.clear();
  FakeTerminal.instances = [];
  for (const id of [
    'terminal-error',
    'terminal-panel',
    'terminal-close',
    'terminal-sessions',
    'prompt-panel',
    'parent-prompt',
    'prompt-tab',
    'terminal-tab',
  ])
    elements.set(id, new FakeElement());
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  let receive: (event: TerminalSnapshot) => void = () => {};
  const fakeWindow = {
    Terminal: FakeTerminal,
    FitAddon: {FitAddon: FakeFitAddon},
    requestAnimationFrame(callback: () => void) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  };
  Object.assign(globalThis, {
    document: fakeDocument,
    window: fakeWindow,
    ResizeObserver: FakeResizeObserver,
  });
  const controls = createTerminalTabs(
    {
      openTerminal,
      closeTerminal: async () => {},
      resizeTerminal: async () => {},
      writeTerminal: async () => {},
      onTerminal(callback: (event: TerminalSnapshot) => void) {
        receive = callback;
        return () => {};
      },
    },
    () => 'session',
  );
  controls.update();
  elements.get('terminal-tab')?.dispatch('click');
  function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  }
  function drain(terminal: FakeTerminal) {
    for (let index = 0; index < 1000; index++) {
      flushFrames();
      if (terminal.callbacks.length) terminal.completeWrite();
      if (!frames.size && !terminal.callbacks.length) return;
    }
    throw new Error('Terminal output did not drain');
  }
  return {controls, emit: receive, flushFrames, drain};
}

void test('terminal renderer paces burst writes and truncates Unicode safely', async () => {
  const harness = rendererHarness(async () => ({
    sessionId: 'session',
    generation: 'one',
    sequence: 0,
    data: '',
  }));
  await Promise.resolve();
  await Promise.resolve();
  const terminal = FakeTerminal.instances[0];
  for (let sequence = 1; sequence <= 10_000; sequence++)
    harness.emit({
      sessionId: 'session',
      generation: 'one',
      sequence,
      data: 'x',
    });
  harness.flushFrames();
  assert.equal(terminal.writes.length, 1);
  assert.equal(terminal.peakWrites, 1);
  assert.equal(terminal.writes[0].length, 10_000);
  terminal.completeWrite();

  const unicode = '🙂'.repeat(400_000);
  harness.emit({
    sessionId: 'session',
    generation: 'one',
    sequence: 10_001,
    data: unicode,
  });
  harness.drain(terminal);
  assert.equal(terminal.resets, 1);
  assert.equal(terminal.peakWrites, 1);
  assert.match(terminal.writes.join(''), /Earlier terminal output omitted/);
  for (const write of terminal.writes) {
    assert.ok(write.length <= 32 * 1024);
    assert.doesNotMatch(write.at(0) || '', /[\uDC00-\uDFFF]/);
    assert.doesNotMatch(write.at(-1) || '', /[\uD800-\uDBFF]/);
  }
  harness.controls.dispose();
  assert.equal(terminal.disposed, true);
  assert.equal(terminal.inputDisposed, true);
});

void test('terminal renderer bounds pre-open events and applies snapshot sequence once', async () => {
  let resolveOpen!: (snapshot: TerminalSnapshot) => void;
  const opening = new Promise<TerminalSnapshot>(resolve => {
    resolveOpen = resolve;
  });
  const harness = rendererHarness(() => opening);
  for (let sequence = 1; sequence <= 1500; sequence++)
    harness.emit({
      sessionId: 'session',
      generation: 'one',
      sequence,
      data: '',
    });
  harness.emit({
    sessionId: 'session',
    generation: 'one',
    sequence: 1501,
    data: '🙂'.repeat(400_000),
  });
  harness.emit({
    sessionId: 'session',
    generation: 'one',
    sequence: 1502,
    data: 'after-snapshot',
  });
  resolveOpen({
    sessionId: 'session',
    generation: 'one',
    sequence: 1501,
    data: 'snapshot',
    exitCode: 9,
  });
  await Promise.resolve();
  await Promise.resolve();
  const terminal = FakeTerminal.instances[0];
  harness.drain(terminal);
  const output = terminal.writes.join('');
  assert.match(output, /snapshot/);
  assert.match(output, /after-snapshot/);
  assert.doesNotMatch(output, /🙂/);
  assert.ok(
    output.indexOf('Earlier terminal output omitted') <
      output.indexOf('snapshot'),
  );
  assert.ok(output.indexOf('after-snapshot') < output.indexOf('Shell exited'));
  harness.controls.dispose();
});
