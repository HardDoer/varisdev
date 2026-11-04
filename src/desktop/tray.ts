import type {Menu, MenuItemConstructorOptions, Tray} from 'electron';
import type {DashboardHub} from '../dashboard/hub.ts';

interface DesktopTrayOptions {
  tray: Pick<
    Tray,
    'on' | 'setToolTip' | 'setContextMenu' | 'isDestroyed' | 'destroy'
  >;
  buildMenu(template: MenuItemConstructorOptions[]): Menu;
  showWindow(): void;
  quit(): void;
}

export function desktopWorkStatus(
  states: ReturnType<DashboardHub['workStates']>,
): string {
  let workspaces = 0;
  let working = 0;
  let compacting = 0;
  let queued = 0;
  let stopping = 0;
  let waiting = 0;
  for (const {status, agents, awaitingInput} of states) {
    if (status === 'closed') continue;
    workspaces++;
    if (status === 'running') working++;
    if (status === 'compacting') compacting++;
    if (awaitingInput) waiting++;
    for (const agent of agents) {
      if (agent === 'running') working++;
      if (agent === 'queued') queued++;
      if (agent === 'cancelling') stopping++;
    }
  }
  if (!workspaces) return 'No open workspaces';
  const parts = [
    waiting && `Awaiting input: ${waiting}`,
    working && `Working: ${working}`,
    compacting && `Compacting: ${compacting}`,
    queued && `Queued: ${queued}`,
    stopping && `Stopping: ${stopping}`,
  ].filter(Boolean);
  return (
    parts.join(' · ') ||
    `Idle · ${workspaces} workspace${workspaces === 1 ? '' : 's'}`
  );
}

function shorten(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  // Native Windows tooltips count UTF-16 units; keep surrogate pairs intact.
  if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end--;
  return `${value.slice(0, end)}…`;
}

export function desktopWorkspaceToolTip(
  states: ReturnType<DashboardHub['workStates']>,
  platform: NodeJS.Platform = process.platform,
): string {
  const rows = states
    .filter(state => state.status !== 'closed')
    .map(({name, status, agents, awaitingInput}) => {
      const running = agents.includes('running');
      const working = status === 'running' || running;
      let summary = 'Idle';
      let priority = 0;
      if (awaitingInput) {
        summary = running ? 'Awaiting input · Working' : 'Awaiting input';
        priority = 5;
      } else if (working) {
        summary = 'Working';
        priority = 4;
      } else if (status === 'compacting') {
        summary = 'Compacting';
        priority = 3;
      } else if (agents.includes('cancelling')) {
        summary = 'Stopping';
        priority = 2;
      } else if (agents.includes('queued')) {
        summary = 'Queued';
        priority = 1;
      }
      return {
        name: name.replace(/[\p{Cc}\s]+/gu, ' ').trim() || 'Workspace',
        status: summary,
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority);
  if (!rows.length) return 'No open workspaces';
  // Windows reserves one of its 128 WCHARs for the terminating null.
  const limit = platform === 'win32' ? 127 : 512;
  for (let count = Math.min(rows.length, 8); count > 0; count--) {
    const visible = rows.slice(0, count);
    const remaining = rows.length - count;
    const tail = remaining
      ? `\n+${remaining} more workspace${remaining === 1 ? '' : 's'}`
      : '';
    const nameBudget =
      limit -
      tail.length -
      (count - 1) -
      visible.reduce((total, row) => total + row.status.length + 2, 0);
    if (
      nameBudget <
      visible.reduce((total, row) => total + Math.min(8, row.name.length), 0)
    )
      continue;
    const nameLimit = Math.max(8, Math.floor(nameBudget / count));
    return (
      visible
        .map(row => `${shorten(row.name, nameLimit)}: ${row.status}`)
        .join('\n') + tail
    );
  }
  return shorten(`${rows[0].name}: ${rows[0].status}`, limit);
}

/** Keep native tray status current even while the renderer is hidden. */
export class DesktopTray {
  private readonly options: DesktopTrayOptions;
  private readonly unsubscribe: () => void;
  private status?: string;
  private tooltip?: string;
  private disposed = false;

  constructor(
    hub: Pick<DashboardHub, 'workStates' | 'subscribe'>,
    options: DesktopTrayOptions,
  ) {
    this.options = options;
    options.tray.on('click', options.showWindow);
    options.tray.on('double-click', options.showWindow);
    this.update(hub.workStates());
    this.unsubscribe = hub.subscribe(() => this.update(hub.workStates()));
  }

  isAvailable(): boolean {
    return !this.disposed && !this.options.tray.isDestroyed();
  }

  private update(states: ReturnType<DashboardHub['workStates']>): void {
    if (!this.isAvailable()) return;
    const {tray, buildMenu, showWindow, quit} = this.options;
    const tooltip = desktopWorkspaceToolTip(states);
    if (tooltip !== this.tooltip) {
      this.tooltip = tooltip;
      tray.setToolTip(tooltip);
    }
    const status = desktopWorkStatus(states);
    if (status === this.status) return;
    this.status = status;
    tray.setContextMenu(
      buildMenu([
        {label: status, enabled: false},
        {type: 'separator'},
        {label: 'Open VarisDev', click: showWindow},
        {type: 'separator'},
        {label: 'Quit VarisDev', click: quit},
      ]),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (!this.options.tray.isDestroyed()) this.options.tray.destroy();
  }
}
