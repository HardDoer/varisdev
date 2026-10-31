import type {DashboardHub, DashboardHubSnapshot} from '../dashboard/hub.ts';

interface SnapshotWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, snapshot: DashboardHubSnapshot): void;
  };
}

/** Build snapshots only when a visible window can receive the latest state. */
export class DesktopSnapshotDelivery {
  private window?: SnapshotWindow;
  private timer?: NodeJS.Timeout;
  private pending = false;
  private disposed = false;
  private readonly hub: Pick<DashboardHub, 'deliverySnapshot' | 'subscribe'>;
  private readonly unsubscribe: () => void;

  constructor(hub: Pick<DashboardHub, 'deliverySnapshot' | 'subscribe'>) {
    this.hub = hub;
    this.unsubscribe = hub.subscribe(() => {
      this.pending = true;
      this.schedule();
    });
  }

  attach(window: SnapshotWindow): void {
    if (this.disposed) return;
    this.detach();
    this.window = window;
    for (const event of ['show', 'hide', 'minimize', 'restore'])
      window.on(event, this.visibilityChanged);
    window.on('closed', this.detach);
    this.refresh();
  }

  // Explicit window opening also refreshes when native show events are absent.
  refresh(): void {
    if (this.disposed) return;
    this.pending = true;
    this.schedule();
  }

  private canSend(): boolean {
    const window = this.window;
    return Boolean(
      window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      !window.webContents.isDestroyed(),
    );
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed || !this.pending || this.timer || !this.canSend()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.canSend()) return;
      this.pending = false;
      this.window!.webContents.send(
        'pidev:snapshot',
        this.hub.deliverySnapshot(),
      );
    }, 80);
    this.timer.unref();
  }

  private readonly visibilityChanged = (): void => {
    if (this.canSend()) this.schedule();
    else this.cancel();
  };

  private readonly detach = (): void => {
    this.cancel();
    for (const event of ['show', 'hide', 'minimize', 'restore'])
      this.window?.removeListener(event, this.visibilityChanged);
    this.window?.removeListener('closed', this.detach);
    this.window = undefined;
  };

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.detach();
    this.pending = false;
  }
}
