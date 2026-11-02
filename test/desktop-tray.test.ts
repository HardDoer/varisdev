import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import type {Menu, MenuItemConstructorOptions, Tray} from 'electron';
import type {AgentRecord} from '../src/agents/orchestrator.ts';
import {
  DashboardHub,
  type DashboardParent,
  type ParentFactory,
} from '../src/dashboard/hub.ts';
import {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {DesktopTray} from '../src/desktop/tray.ts';

function state(id = 'workspace') {
  return new DashboardState({
    id,
    name: 'Tray workspace',
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });
}

function agent(id: string, status: AgentRecord['status']): AgentRecord {
  return {
    id,
    name: id,
    task: 'Tray test',
    status,
    activity: status,
    createdAt: '2026-01-01',
    cwd: process.cwd(),
    model: 'test/model',
  };
}

function fixture(
  initial?: DashboardState,
  factory: ParentFactory = async () => {
    throw new Error('This fixture does not create sessions');
  },
) {
  const hub = new DashboardHub(initial, factory);
  hub.deliverySnapshot = () => {
    throw new Error('Tray updates must not build renderer snapshots');
  };
  const nativeTray = new EventEmitter();
  const tooltips: string[] = [];
  let menu: MenuItemConstructorOptions[] = [];
  let destroyed = false;
  let shown = 0;
  let quits = 0;
  const tray = new DesktopTray(hub, {
    tray: Object.assign(nativeTray, {
      setToolTip: (value: string) => tooltips.push(value),
      setContextMenu: () => {},
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true;
      },
    }) as unknown as Tray,
    buildMenu: template => {
      menu = template;
      return {} as Menu;
    },
    showWindow: () => {
      shown++;
    },
    quit: () => {
      quits++;
    },
  });
  return {
    hub,
    tray,
    nativeTray,
    tooltips,
    get menu() {
      return menu;
    },
    get shown() {
      return shown;
    },
    get quits() {
      return quits;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

void test('tray follows work across sessions without renderer updates and ignores finished agents', () => {
  const primary = state();
  const f = fixture(primary);
  try {
    assert.equal(f.tooltips.at(-1), 'VarisDev — Idle · 1 workspace');
    primary.updateSession({status: 'running'});
    primary.updateTeam(
      [
        agent('active', 'running'),
        agent('waiting', 'queued'),
        agent('stopping', 'cancelling'),
        agent('done', 'completed'),
        agent('error', 'failed'),
        agent('aborted', 'cancelled'),
      ],
      [],
    );
    assert.equal(
      f.tooltips.at(-1),
      'VarisDev — Working: 2 · Queued: 1 · Stopping: 1',
    );
    const external = state('external');
    external.updateSession({status: 'compacting'});
    f.hub.updateExternal(external.snapshot());
    assert.equal(
      f.tooltips.at(-1),
      'VarisDev — Working: 2 · Compacting: 1 · Queued: 1 · Stopping: 1',
    );
    const updates = f.tooltips.length;
    primary.updateSession({activity: 'Streaming output'});
    assert.equal(f.tooltips.length, updates);
    primary.updateTeam([], []);
    primary.updateSession({status: 'idle'});
    external.updateSession({status: 'idle'});
    f.hub.updateExternal(external.snapshot());
    assert.equal(f.tooltips.at(-1), 'VarisDev — Idle · 2 workspaces');
    external.updateSession({status: 'closed'});
    external.updateTeam([agent('stale', 'running')], []);
    f.hub.updateExternal(external.snapshot());
    assert.equal(f.tooltips.at(-1), 'VarisDev — Idle · 1 workspace');
    primary.updateSession({status: 'closed'});
    assert.equal(f.tooltips.at(-1), 'VarisDev — No open workspaces');
  } finally {
    f.tray.dispose();
  }
});

void test('tray menu and click actions reopen or explicitly quit, and disposal removes status updates', () => {
  const primary = state();
  const f = fixture(primary);
  assert.equal(f.tray.isAvailable(), true);
  assert.deepEqual(
    f.menu.filter(item => item.label).map(item => item.label),
    ['Idle · 1 workspace', 'Open VarisDev', 'Quit VarisDev'],
  );
  assert.equal(f.menu[0].enabled, false);
  f.nativeTray.emit('click');
  f.nativeTray.emit('double-click');
  f.menu.find(item => item.label === 'Open VarisDev')!.click!(
    undefined!,
    undefined!,
    undefined!,
  );
  assert.equal(f.shown, 3);
  f.menu.find(item => item.label === 'Quit VarisDev')!.click!(
    undefined!,
    undefined!,
    undefined!,
  );
  assert.equal(f.quits, 1);
  f.tray.dispose();
  f.tray.dispose();
  assert.equal(f.destroyed, true);
  assert.equal(f.tray.isAvailable(), false);
  const updates = f.tooltips.length;
  primary.updateSession({status: 'running'});
  assert.equal(f.tooltips.length, updates);
});

void test('pending session input reaches the tray without projecting dialog or conversation snapshots', async t => {
  const current = state();
  const f = fixture();
  const ui = new DesktopExtensionUI(() => current.touch());
  t.after(() => {
    f.tray.dispose();
    ui.dispose();
  });
  f.hub.adoptSession({state: current, ui} as DashboardParent);
  const confirmation = ui.context.confirm('Continue?', 'Approve the action.');
  const dialogId = ui.snapshot().dialogs[0].id;
  ui.snapshot = () => {
    throw new Error('Tray updates must not project dialogs');
  };
  current.deliverySnapshot = () => {
    throw new Error('Tray updates must not project conversations');
  };
  current.updateSession({activity: 'Waiting for confirmation'});
  assert.equal(f.tooltips.at(-1), 'VarisDev — Awaiting input: 1');
  assert.equal(f.menu[0].label, 'Awaiting input: 1');
  ui.respond(dialogId, true);
  assert.equal(await confirmation, true);
  assert.equal(f.tooltips.at(-1), 'VarisDev — Idle · 1 workspace');
});

for (const existing of [false, true])
  void test(
    `tray reports startup input before adoption${existing ? ' alongside an idle workspace' : ' with no open workspace'}`,
    {timeout: 5000},
    async t => {
      let ready!: () => void;
      const started = new Promise<void>(resolve => {
        ready = resolve;
      });
      let pendingUI!: DesktopExtensionUI;
      let dialogId!: string;
      const f = fixture(
        existing ? state() : undefined,
        async (_request, interaction) => {
          pendingUI = interaction!.ui;
          const confirmation = pendingUI.context.confirm(
            'Trust this project?',
            'Load its configuration.',
          );
          dialogId = pendingUI.snapshot().dialogs[0].id;
          pendingUI.snapshot = () => {
            throw new Error('Tray startup status must not project dialogs');
          };
          ready();
          await confirmation;
          return {
            state: state('opened'),
            ui: pendingUI,
            close: async () => pendingUI.dispose(),
          } as DashboardParent;
        },
      );
      t.after(async () => {
        f.tray.dispose();
        await f.hub.close();
      });
      const opening = f.hub.startParent({cwd: process.cwd()});
      await started;
      assert.equal(f.tooltips.at(-1), 'VarisDev — Awaiting input: 1');
      assert.equal(f.menu[0].label, 'Awaiting input: 1');
      pendingUI.respond(dialogId, true);
      const parent = await opening;
      f.hub.adoptSession(parent);
      assert.equal(
        f.tooltips.at(-1),
        `VarisDev — Idle · ${existing ? '2 workspaces' : '1 workspace'}`,
      );
    },
  );
