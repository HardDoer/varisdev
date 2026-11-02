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

/** Keep native tray status current even while the renderer is hidden. */
export class DesktopTray {
  private readonly options: DesktopTrayOptions;
  private readonly unsubscribe: () => void;
  private status?: string;
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
    const status = desktopWorkStatus(states);
    if (status === this.status) return;
    this.status = status;
    const {tray, buildMenu, showWindow, quit} = this.options;
    tray.setToolTip(`VarisDev — ${status}`);
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
