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
  id = '';
  style = {};
  title = '';
  type = '';
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
  replaceChildren(...children: FakeElement[]) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...children);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  getBoundingClientRect() {
    return {top: 100, right: 500, bottom: 130, width: 240, height: 160};
  }
  hidePopover() {}
  showPopover() {}
  matches() {
    return false;
  }
  scrollIntoView() {}
  closest(selector: string): FakeElement | undefined {
    if (
      selector === 'button[data-terminal-id]' &&
      this.hasAttribute('data-terminal-id')
    )
      return this;
    if (selector === '[role="tab"]' && this.getAttribute('role') === 'tab')
      return this;
    return this.parent?.closest(selector);
  }
  querySelector() {
    return this.children.find(child => child.type === 'button');
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
  readonly target?: FakeElement;
  constructor(target?: FakeElement) {
    this.target = target;
  }
  key = '';
  preventDefault() {}
}

const elements = new Map<string, FakeElement>();
const fakeDocument = {
  activeElement: undefined as FakeElement | undefined,
  documentElement: new FakeElement(),
  getElementById(id: string) {
    const find = (element: FakeElement): FakeElement | undefined => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const result = find(child);
        if (result) return result;
      }
      return undefined;
    };
    return elements.get(id) || [...elements.values()].map(find).find(Boolean);
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

function rendererHarness(
  openTerminal: (workspaceId: string) => Promise<TerminalSnapshot>,
  options: {
    selectedSession?: () => string;
    listTerminals?: (workspaceId: string) => Promise<TerminalSnapshot[]>;
    createTerminal?: (
      workspaceId: string,
      profileId?: string,
    ) => Promise<TerminalSnapshot>;
    closeTerminal?: (id: string) => Promise<void>;
  } = {},
) {
  elements.clear();
  FakeTerminal.instances = [];
  for (const id of [
    'terminal-error',
    'terminal-panel',
    'terminal-tabs',
    'terminal-new',
    'terminal-profiles',
    'terminal-profile-menu',
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
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({
      getPropertyValue: () => '#edf4f6',
      backgroundColor: '#10171d',
    }),
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
    MutationObserver: FakeResizeObserver,
  });
  const controls = createTerminalTabs(
    {
      openTerminal,
      listTerminals: options.listTerminals || (async () => []),
      createTerminal: options.createTerminal,
      getTerminalProfiles: async () => ({
        profiles: [{id: 'sh', label: 'sh', path: '/bin/sh'}],
        defaultProfileId: 'sh',
      }),
      closeTerminal: options.closeTerminal || (async () => {}),
      resizeTerminal: async () => {},
      writeTerminal: async () => {},
      onTerminal(callback: (event: TerminalSnapshot) => void) {
        receive = callback;
        return () => {};
      },
    },
    options.selectedSession || (() => 'session'),
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
    workspaceId: 'session',
    profileId: 'sh',
    title: 'sh',
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
      workspaceId: 'session',
      profileId: 'sh',
      title: 'sh',
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
    workspaceId: 'session',
    profileId: 'sh',
    title: 'sh',
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
      workspaceId: 'session',
      profileId: 'sh',
      title: 'sh',
      generation: 'one',
      sequence,
      data: '',
    });
  harness.emit({
    sessionId: 'session',
    workspaceId: 'session',
    profileId: 'sh',
    title: 'sh',
    generation: 'one',
    sequence: 1501,
    data: '🙂'.repeat(400_000),
  });
  harness.emit({
    sessionId: 'session',
    workspaceId: 'session',
    profileId: 'sh',
    title: 'sh',
    generation: 'one',
    sequence: 1502,
    data: 'after-snapshot',
  });
  resolveOpen({
    sessionId: 'session',
    workspaceId: 'session',
    profileId: 'sh',
    title: 'sh',
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

function terminalSnapshot(
  workspaceId: string,
  id = workspaceId,
  sequence = 0,
  data = '',
): TerminalSnapshot {
  return {
    sessionId: id,
    workspaceId,
    profileId: 'sh',
    title: 'sh',
    generation: id,
    sequence,
    data,
  };
}

void test('terminal renderer keeps pending creations with their workspace and retains other tabs on close', async () => {
  let workspace = 'session';
  let resolveCreate!: (snapshot: TerminalSnapshot) => void;
  const creating = new Promise<TerminalSnapshot>(resolve => {
    resolveCreate = resolve;
  });
  const closed: string[] = [];
  const harness = rendererHarness(async id => terminalSnapshot(id), {
    selectedSession: () => workspace,
    createTerminal: () => creating,
    closeTerminal: async id => {
      closed.push(id);
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  const first = FakeTerminal.instances[0];
  elements.get('terminal-new')?.dispatch('click');
  harness.emit(terminalSnapshot('session', 'added', 2, 'after-snapshot'));
  workspace = 'other';
  harness.controls.update();
  await Promise.resolve();
  await Promise.resolve();
  const other = FakeTerminal.instances[1];
  resolveCreate(terminalSnapshot('session', 'added', 1, 'snapshot'));
  await Promise.resolve();
  const added = FakeTerminal.instances[2];
  assert.equal(
    fakeDocument.getElementById('terminal-view-other')?.hidden,
    false,
  );
  assert.equal(
    fakeDocument.getElementById('terminal-view-added')?.hidden,
    true,
  );
  workspace = 'session';
  harness.controls.update();
  harness.drain(added);
  assert.equal(added.writes.join(''), 'snapshotafter-snapshot');
  assert.equal(
    fakeDocument.getElementById('terminal-view-added')?.hidden,
    false,
  );
  assert.equal(first.disposed, false);
  const close = elements.get('terminal-tabs')?.children[0].children[1];
  elements.get('terminal-tabs')?.dispatch('click', new FakeEvent(close));
  await Promise.resolve();
  assert.deepEqual(closed, ['session']);
  assert.equal(first.disposed, true);
  assert.equal(added.disposed, false);
  assert.equal(other.disposed, false);
  harness.controls.retain(['other']);
  assert.equal(added.disposed, true);
  assert.equal(other.disposed, false);
  harness.controls.dispose();
});

void test('terminal renderer restores listed snapshots and ignores a creation completed after disposal', async () => {
  let opened = 0;
  let resolveCreate!: (snapshot: TerminalSnapshot) => void;
  const creating = new Promise<TerminalSnapshot>(resolve => {
    resolveCreate = resolve;
  });
  const harness = rendererHarness(
    async id => {
      opened++;
      return terminalSnapshot(id);
    },
    {
      listTerminals: async () => [
        terminalSnapshot('session', 'existing', 4, 'retained-output'),
      ],
      createTerminal: () => creating,
    },
  );
  await Promise.resolve();
  const existing = FakeTerminal.instances[0];
  harness.drain(existing);
  assert.equal(opened, 0);
  assert.equal(existing.writes.join(''), 'retained-output');
  elements.get('terminal-new')?.dispatch('click');
  harness.controls.dispose();
  resolveCreate(terminalSnapshot('session', 'late'));
  await Promise.resolve();
  assert.equal(FakeTerminal.instances.length, 1);
  assert.equal(existing.disposed, true);
  assert.equal(elements.get('terminal-sessions')?.children.length, 0);
});
