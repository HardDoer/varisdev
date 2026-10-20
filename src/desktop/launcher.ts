import {spawn, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DashboardState} from '../dashboard/state.ts';
import {
  agentCancellationId,
  agentSessionRequest,
  type AgentSessionRequest,
  type AgentSessionResult,
  sessionConfiguration,
  compactionInstructions,
  type StoppedMessages,
} from '../dashboard/hub.ts';
import type {
  SessionFeatures,
  SessionConfiguration,
} from '../dashboard/features.ts';
import {conversationImageInput, requestId} from './ipc.ts';
import {readConversationImage} from '../conversation-images.ts';
import {buildDesktop} from './build.ts';
import {environmentForChild} from '../runtime/environment.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

export interface FactoryControl {
  prompt(text: string): void | Promise<void>;
  abort(): StoppedMessages | Promise<StoppedMessages>;
  cancelAgent(agentId: string): void | Promise<void>;
  agentSession?(request: AgentSessionRequest): Promise<AgentSessionResult>;
  features(): Promise<SessionFeatures>;
  configure(input: SessionConfiguration): Promise<void>;
  compact(instructions?: string): Promise<void>;
  reload(): Promise<void>;
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
        snapshot: attachment.state.deliverySnapshot(),
        controllable: true,
      },
      () => {
        sending = false;
        if (dirty) snapshot();
      },
    );
  };
  const detach = (state?: DashboardState) => {
    if (state && attachment?.state !== state) return;
    const id = attachment?.state.deliverySnapshot().session.id;
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
        .then(() =>
          Promise.allSettled([control.abort(), control.cancelAgent('all')]),
        )
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
      input?: unknown;
    };
    if (request.type !== 'request' || !requestId(request.id)) return;
    const id = request.id;
    const reply = (ok: boolean, error?: string, value?: unknown) =>
      send({
        type: 'reply',
        id,
        ok,
        ...(value === undefined ? {} : {value: structuredClone(value)}),
        ...(error ? {error: error.slice(0, 2000)} : {}),
      });
    if (requests.has(id)) return;
    if (requests.size >= 32) {
      reply(false, 'The workspace already has 32 pending desktop requests.');
      return;
    }
    const current = attachment;
    if (
      !ready ||
      !current ||
      request.sessionId !== current.state.deliverySnapshot().session.id ||
      current.state.deliverySnapshot().session.status === 'closed'
    ) {
      reply(false, 'This workspace is no longer attached to the app.');
      return;
    }
    if (
      request.action !== 'prompt' &&
      request.action !== 'abort' &&
      request.action !== 'cancelAgent' &&
      request.action !== 'agentSession' &&
      request.action !== 'features' &&
      request.action !== 'configure' &&
      request.action !== 'compact' &&
      request.action !== 'reload' &&
      request.action !== 'conversationImage'
    ) {
      reply(false, 'Unknown factory request.');
      return;
    }
    if (request.action === 'conversationImage' && requests.size >= 16) {
      reply(
        false,
        'Too many pending requests to load another conversation image.',
      );
      return;
    }
    if (
      request.action === 'prompt' &&
      (typeof request.input !== 'string' ||
        !request.input.trim() ||
        request.input.length > 64000)
    ) {
      reply(false, 'Prompt must contain 1 to 64000 characters.');
      return;
    }
    try {
      if (request.action === 'conversationImage')
        request.input = conversationImageInput(request.input);
      if (request.action === 'cancelAgent')
        request.input = agentCancellationId(request.input);
      if (request.action === 'agentSession')
        request.input = agentSessionRequest(request.input);
      if (request.action === 'configure')
        request.input = sessionConfiguration(request.input);
      if (request.action === 'compact')
        request.input = compactionInstructions(request.input);
    } catch (error) {
      reply(
        false,
        error instanceof Error ? error.message : 'Invalid session settings.',
      );
      return;
    }
    requests.add(id);
    void Promise.resolve()
      .then(async () => {
        if (attachment !== current)
          throw new Error('The attached workspace changed.');
        let value: unknown;
        if (request.action === 'prompt')
          await current.control.prompt((request.input as string).trim());
        else if (request.action === 'cancelAgent')
          await current.control.cancelAgent(request.input as string);
        else if (request.action === 'agentSession') {
          if (!current.control.agentSession)
            throw new Error('Agent conversations are unavailable.');
          value = await current.control.agentSession(
            request.input as AgentSessionRequest,
          );
        } else if (request.action === 'conversationImage') {
          const input = request.input as ReturnType<
            typeof conversationImageInput
          >;
          value = await readConversationImage(input.imageId, input.variant);
        } else if (request.action === 'features')
          value = await current.control.features();
        else if (request.action === 'configure')
          await current.control.configure(
            request.input as SessionConfiguration,
          );
        else if (request.action === 'compact')
          await current.control.compact(request.input as string | undefined);
        else if (request.action === 'reload') await current.control.reload();
        else value = await current.control.abort();
        if (attachment !== current)
          throw new Error('The attached workspace changed.');
        reply(true, undefined, value);
      })
      .catch(error => {
        reply(
          false,
          error instanceof Error
            ? error.message
            : 'The workspace request failed.',
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
  await buildDesktop();
  const env = environmentForChild();
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require('electron') as string,
    [
      join(root, 'desktop/build/src/desktop/main.js'),
      `--pidev-cwd=${state.deliverySnapshot().session.cwd}`,
    ],
    {
      cwd: state.deliverySnapshot().session.cwd,
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
          'The VarisDev window did not finish starting. Try opening VarisDev again.',
        ),
      );
    }, 30000);
    const fail = () => {
      clearTimeout(timer);
      reject(
        new Error(
          'Could not open the VarisDev window. Try opening VarisDev again.',
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

/** Reuses one window while the parent session reloads extensions or switches conversations. */
export class FactoryLauncher {
  private window?: FactoryWindow;
  private starting?: Promise<FactoryWindow>;
  private attachment?: {state: DashboardState; control: FactoryControl};

  private readonly open: typeof openFactory;

  constructor(open = openFactory) {
    this.open = open;
  }

  get isOpen(): boolean {
    return !!this.starting || !!this.window?.connected;
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

export const factoryIsOpen = (): boolean => launcher.isOpen;
export const launchFactory = (
  state: DashboardState,
  control: FactoryControl,
): Promise<FactoryWindow> => launcher.launch(state, control);
export const detachFactory = (state: DashboardState, quit = false): void =>
  launcher.detach(state, quit);
