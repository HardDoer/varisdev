import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {AgentSessionController} from '../src/agents/team.ts';
import {DashboardHub} from '../src/dashboard/hub.ts';
import {observeDashboardSession} from '../src/dashboard/observe.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {
  DesktopCompletionSound,
  playDesktopCompletionSound,
} from '../src/desktop/completion-sound.ts';
import type {runRuntimeCommand} from '../src/runtime/manager.ts';

type Handler = (event: never, ctx: ExtensionContext) => unknown;

function fixture() {
  const handlers = new Map<string, Handler[]>();
  let state!: DashboardState;
  const pi = {
    events: {on: () => () => {}},
    getThinkingLevel: () => 'off',
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    isIdle: () => true,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionName: () => 'Completion fixture',
      getSessionId: () => 'fixture',
      getSessionFile: () => undefined,
      getHeader: () => undefined,
      getBranch: () => [],
    },
  } as unknown as ExtensionContext;
  observeDashboardSession(
    pi,
    {
      snapshot: () => undefined,
      subscribe: () => () => {},
    } as unknown as AgentSessionController,
    value => {
      state = value;
    },
  );
  return {
    get state() {
      return state;
    },
    async emit(type: string, event: object = {}) {
      for (const handler of handlers.get(type) ?? [])
        await handler({...event, type} as never, ctx);
    },
  };
}

function hub(state?: DashboardState) {
  return new DashboardHub(state, async () => {
    throw new Error('This fixture does not create sessions');
  });
}

void test('Pi settlement through dashboard state and hub sounds only for unfocused live runs', async () => {
  const source = fixture();
  await source.emit('session_start');
  const dashboard = hub(source.state);
  let focused = true;
  let destroyed = false;
  let available = true;
  let sounds = 0;
  const window = {isFocused: () => focused, isDestroyed: () => destroyed};
  const sound = new DesktopCompletionSound(dashboard, {
    window: () => (available ? window : undefined),
    play: () => {
      sounds++;
    },
  });
  try {
    // Idle startup and a settlement without a run do not produce a completion.
    await source.emit('agent_settled', {aborted: false});
    assert.equal(source.state.snapshot().session.completionId, undefined);
    assert.equal(sounds, 0);

    await source.emit('agent_start');
    await source.emit('agent_end');
    assert.equal(sounds, 0);
    await source.emit('agent_settled', {aborted: false});
    const first = source.state.snapshot().session.completionId;
    assert.ok(first);
    assert.equal(sounds, 0);

    focused = false;
    source.state.updateSession({activity: 'Unrelated update'});
    await source.emit('agent_settled', {aborted: false});
    assert.equal(source.state.snapshot().session.completionId, first);
    assert.equal(sounds, 0, 'A focused completion never sounds after blur');

    // No renderer delivery timer is needed to observe a fast run.
    await source.emit('agent_start');
    await source.emit('agent_settled', {aborted: false});
    const second = source.state.snapshot().session.completionId;
    assert.notEqual(second, first);
    assert.equal(sounds, 1);
    source.state.record('message', 'Another snapshot');
    await source.emit('agent_settled', {aborted: false});
    assert.equal(
      sounds,
      1,
      'Duplicate settlements and snapshots remain silent',
    );

    await source.emit('agent_start');
    await source.emit('agent_settled', {aborted: true});
    assert.equal(source.state.snapshot().session.completionId, second);
    assert.equal(sounds, 1, 'Cancellation does not count as completion');

    await source.emit('session_before_compact');
    await source.emit('session_compact_failed', {errorMessage: 'Cancelled'});
    await source.emit('agent_settled', {aborted: true});
    assert.equal(
      sounds,
      1,
      'Manual compaction does not count as work completion',
    );

    await source.emit('agent_start');
    await source.emit('session_before_compact');
    source.state.updateSession({status: 'running'});
    assert.equal(sounds, 1, 'Automatic compaction waits for final settlement');
    await source.emit('agent_settled', {aborted: false});
    assert.equal(sounds, 2);

    // The original plugin notified on non-aborted errors too.
    await source.emit('agent_start');
    await source.emit('message_end', {
      message: {
        role: 'assistant',
        content: [],
        timestamp: Date.now(),
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    });
    await source.emit('agent_settled', {aborted: false});
    assert.equal(sounds, 3);
    assert.equal(source.state.snapshot().session.error, 'Provider unavailable');

    destroyed = true;
    await source.emit('agent_start');
    await source.emit('agent_settled', {aborted: false});
    assert.equal(sounds, 3);
    destroyed = false;
    available = false;
    await source.emit('agent_start');
    await source.emit('agent_settled', {aborted: false});
    assert.equal(sounds, 3);
    available = true;

    sound.dispose();
    await source.emit('agent_start');
    await source.emit('agent_settled', {aborted: false});
    assert.equal(sounds, 3);
  } finally {
    sound.dispose();
    await source.emit('session_shutdown');
  }
});

void test('restored and newly attached workspaces establish their own completion baselines', () => {
  const dashboard = hub();
  let sounds = 0;
  const sound = new DesktopCompletionSound(dashboard, {
    window: () => ({isFocused: () => false, isDestroyed: () => false}),
    play: () => {
      sounds++;
    },
  });
  const historical = new DashboardState({
    id: 'restored',
    name: 'Saved conversation',
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: '2026-01-01',
    updatedAt: '2026-01-01',
    completionId: 'historical',
  });
  try {
    dashboard.updateExternal(historical.snapshot());
    dashboard.updateExternal(historical.snapshot());
    assert.equal(sounds, 0);
    historical.updateSession({completionId: 'live'});
    dashboard.updateExternal(historical.snapshot());
    dashboard.updateExternal(historical.snapshot());
    assert.equal(sounds, 1);
    historical.updateSession({id: 'other-workspace', completionId: 'old'});
    dashboard.updateExternal(historical.snapshot());
    assert.equal(sounds, 1);
    historical.updateSession({completionId: 'new'});
    dashboard.updateExternal(historical.snapshot());
    assert.equal(sounds, 2);
    historical.updateSession({status: 'closed', completionId: 'shutdown'});
    dashboard.updateExternal(historical.snapshot());
    assert.equal(sounds, 2);
  } finally {
    sound.dispose();
  }
});

void test('native playback uses the original WAV and Windows player with a bounded process tree', async () => {
  const path = "C:\\User's files\\windows_98_ding.wav";
  const calls: Array<Parameters<typeof runRuntimeCommand>> = [];
  let beeps = 0;
  await playDesktopCompletionSound({
    platform: 'win32',
    path,
    shouldPlay: () => true,
    beep: () => {
      beeps++;
    },
    run: async (...args) => {
      calls.push(args);
      return '';
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1].at(-1)!, /C:\\User''s files\\windows_98_ding\.wav/);
  assert.match(calls[0][1].at(-1)!, /PlaySync\(\)/);
  assert.equal(calls[0][2].timeoutMs, 5000);
  assert.equal(beeps, 0);
  const wave = readFileSync(
    new URL('../assets/windows_98_ding.wav', import.meta.url),
  );
  assert.equal(wave.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wave.subarray(8, 12).toString(), 'WAVE');
});

void test('Linux player fallback stops after success, and macOS uses its native bell', async () => {
  const calls: string[] = [];
  let beeps = 0;
  await playDesktopCompletionSound({
    platform: 'linux',
    path: '/assets/windows_98_ding.wav',
    shouldPlay: () => true,
    beep: () => {
      beeps++;
    },
    run: async (command, args, options) => {
      calls.push(command);
      assert.equal(args.at(-1), '/assets/windows_98_ding.wav');
      assert.equal(options.timeoutMs, 5000);
      if (command !== 'aplay') throw new Error('Player unavailable');
      return '';
    },
  });
  assert.deepEqual(calls, ['pw-play', 'paplay', 'aplay']);
  assert.equal(beeps, 0);
  await playDesktopCompletionSound({
    platform: 'darwin',
    path: '/assets/windows_98_ding.wav',
    shouldPlay: () => true,
    beep: () => {
      beeps++;
    },
    run: async () => {
      assert.fail('macOS uses the native bell');
    },
  });
  assert.equal(beeps, 1);
});

void test('all failed players fall back to a native bell only while still unfocused', async () => {
  let focused = false;
  let calls = 0;
  let beeps = 0;
  const options = {
    platform: 'linux' as const,
    path: '/assets/windows_98_ding.wav',
    shouldPlay: () => !focused,
    beep: () => {
      beeps++;
    },
    run: async () => {
      calls++;
      throw new Error('No player');
    },
  };
  await playDesktopCompletionSound(options);
  assert.equal(calls, 6);
  assert.equal(beeps, 1);
  await playDesktopCompletionSound({
    ...options,
    run: async () => {
      focused = true;
      calls++;
      throw new Error('Player failed after the user focused the app');
    },
  });
  assert.equal(calls, 7);
  assert.equal(
    beeps,
    1,
    'Focus returning suppresses pending player and bell fallbacks',
  );
  await playDesktopCompletionSound(options);
  assert.equal(calls, 7, 'Already focused windows never start a player');
});

void test('disposal suppresses a pending playback fallback during shutdown', async () => {
  const state = new DashboardState({
    id: 'fixture',
    name: 'Fixture',
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
  const dashboard = hub(state);
  let rejectPlayer!: (error: Error) => void;
  let playing!: Promise<void>;
  let beeps = 0;
  const sound = new DesktopCompletionSound(dashboard, {
    window: () => ({isFocused: () => false, isDestroyed: () => false}),
    play: shouldPlay =>
      (playing = playDesktopCompletionSound({
        platform: 'win32',
        path: '/assets/windows_98_ding.wav',
        shouldPlay,
        beep: () => {
          beeps++;
        },
        run: () =>
          new Promise((_resolve, reject) => {
            rejectPlayer = reject;
          }),
      })),
  });
  state.updateSession({completionId: 'finished'});
  sound.dispose();
  rejectPlayer(new Error('Failed during shutdown'));
  await playing;
  assert.equal(beeps, 0);
});
