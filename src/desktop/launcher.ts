import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import type {DashboardState} from '../dashboard/state.ts';
import {requestId} from './ipc.ts';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export interface FactoryControl {
  readonly pendingPrompts?: number;
  prompt(text: string): void | Promise<void>;
  abort(): void | Promise<void>;
}

export interface FactoryWindow {
  show(): void;
  attach(state: DashboardState, control: FactoryControl): void;
  detach(state?: DashboardState): void;
  close(): void;
  readonly connected: boolean;
}

/** Connects one Electron child to the current source conversation. */
export function createFactoryBridge(
  child: ChildProcess,
): FactoryWindow & {ready(): void} {
  let attachment: {state: DashboardState; control: FactoryControl} | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let sending = false;
  let dirty = false;
  const requests = new Set<string>();
  const send = (message: object) => {
    if (child.connected) child.send(message, () => {});
  };
  const snapshot = () => {
    if (!child.connected || !ready || !attachment) return;
    if (sending) {
      dirty = true;
      return;
    }
    sending = true;
    dirty = false;
    child.send(
      {
        type: 'snapshot',
        snapshot: attachment.state.snapshot(),
        controllable: true,
        pendingPrompts: attachment.control.pendingPrompts ?? 0,
      },
      () => {
        sending = false;
        if (dirty) snapshot();
      },
    );
  };
  const detach = (state?: DashboardState) => {
    if (state && attachment?.state !== state) return;
    const id = attachment?.state.snapshot().session.id;
    attachment = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    clearTimeout(pending);
    pending = undefined;
    dirty = false;
    if (id) send({type: 'detach', sessionId: id});
  };
  const lost = () => {
    if (!ready && !attachment) return;
    const control = attachment?.control;
    ready = false;
    detach();
    // A closed or crashed GUI also stops work in its attached conversation.
    if (control)
      void Promise.resolve()
        .then(() => control.abort())
        .catch(() => {});
  };
  child.on('disconnect', lost);
  child.on('exit', lost);
  child.on('error', lost);
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const request = message as {
      type?: unknown;
      id?: unknown;
      sessionId?: unknown;
      action?: unknown;
      prompt?: unknown;
    };
    if (request.type !== 'request' || !requestId(request.id)) return;
    const id = request.id;
    const reply = (ok: boolean, error?: string) =>
      send({
        type: 'reply',
        id,
        ok,
        ...(error ? {error: error.slice(0, 2000)} : {}),
      });
    if (requests.has(id)) return;
    if (requests.size >= 32) {
      reply(false, 'Pi already has 32 pending desktop requests.');
      return;
    }
    const current = attachment;
    if (
      !ready ||
      !current ||
      request.sessionId !== current.state.snapshot().session.id ||
      current.state.snapshot().session.status === 'closed'
    ) {
      reply(false, 'This Pi session is no longer attached to the factory.');
      return;
    }
    if (request.action !== 'prompt' && request.action !== 'abort') {
      reply(false, 'Unknown factory request.');
      return;
    }
    if (
      request.action === 'prompt' &&
      (typeof request.prompt !== 'string' ||
        !request.prompt.trim() ||
        request.prompt.length > 64000)
    ) {
      reply(false, 'Prompt must contain 1 to 64000 characters.');
      return;
    }
    requests.add(id);
    void Promise.resolve()
      .then(async () => {
        if (attachment !== current)
          throw new Error('The attached Pi session changed.');
        if (request.action === 'prompt')
          await current.control.prompt((request.prompt as string).trim());
        else await current.control.abort();
        if (attachment !== current)
          throw new Error('The attached Pi session changed.');
        reply(true);
      })
      .catch(error => {
        reply(
          false,
          error instanceof Error ? error.message : 'The Pi request failed.',
        );
      })
      .finally(() => requests.delete(id));
  });
  return {
    ready() {
      ready = true;
      snapshot();
    },
    attach(state, control) {
      detach();
      attachment = {state, control};
      unsubscribe = state.subscribe(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          snapshot();
        }, 80);
        pending.unref();
      });
      snapshot();
    },
    show: () => send({type: 'show'}),
    detach,
    close() {
      detach();
      if (child.connected)
        child.send({type: 'close'}, () => {
          if (child.connected) child.disconnect();
        });
    },
    get connected() {
      return ready && child.connected;
    },
  };
}

async function openFactory(state: DashboardState): Promise<FactoryWindow> {
  await execute(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--project',
      join(root, 'tsconfig.desktop.json'),
    ],
    {cwd: root, maxBuffer: 1024 * 1024},
  );
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require('electron') as string,
    [
      join(root, 'build/desktop/src/desktop/main.js'),
      `--pidev-cwd=${state.snapshot().session.cwd}`,
    ],
    {
      cwd: state.snapshot().session.cwd,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
    },
  );
  const bridge = createFactoryBridge(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.close();
      reject(
        new Error(
          'The factory window did not finish starting. Run npm run desktop to see startup details.',
        ),
      );
    }, 30000);
    const fail = () => {
      clearTimeout(timer);
      reject(
        new Error(
          'Could not open the factory window. Run npm run desktop to see startup details.',
        ),
      );
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.on('message', message => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'ready'
      )
        return;
      clearTimeout(timer);
      child.off('error', fail);
      child.off('exit', fail);
      bridge.ready();
      resolve();
    });
  });
  child.unref();
  child.channel?.unref();
  return bridge;
}

/** Reuses one window while Pi reloads extensions or switches conversations. */
export class FactoryLauncher {
  private window?: FactoryWindow;
  private starting?: Promise<FactoryWindow>;
  private attachment?: {state: DashboardState; control: FactoryControl};

  private readonly open: typeof openFactory;

  constructor(open = openFactory) {
    this.open = open;
  }

  async launch(
    state: DashboardState,
    control: FactoryControl,
  ): Promise<FactoryWindow> {
    const previous = this.attachment;
    this.attachment = {state, control};
    if (this.window?.connected) {
      if (previous?.state !== state || previous.control !== control)
        this.window.attach(state, control);
      return this.window;
    }
    this.starting ??= this.open(state)
      .then(opened => {
        this.window = opened;
        if (this.attachment)
          opened.attach(this.attachment.state, this.attachment.control);
        return opened;
      })
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  detach(state: DashboardState, quit = false): void {
    if (this.attachment?.state !== state) return;
    this.attachment = undefined;
    this.window?.detach(state);
    if (quit) {
      this.window?.close();
      this.window = undefined;
      void this.starting?.then(opened => opened.close()).catch(() => {});
    }
  }
}

const key = Symbol.for('varisdev.factory.launcher');
const shared = globalThis as typeof globalThis & {
  [key: symbol]: FactoryLauncher | undefined;
};
const launcher = (shared[key] ??= new FactoryLauncher());

export const launchFactory = (
  state: DashboardState,
  control: FactoryControl,
): Promise<FactoryWindow> => launcher.launch(state, control);
export const detachFactory = (state: DashboardState, quit = false): void =>
  launcher.detach(state, quit);
