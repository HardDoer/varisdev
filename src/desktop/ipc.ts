import {randomUUID} from 'node:crypto';

export interface FactoryRequest {
  type: 'request';
  id: string;
  sessionId: string;
  action: 'prompt' | 'abort';
  prompt?: string;
}

export function requestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}

/** Tracks the small set of desktop requests waiting for the attached Pi. */
export class ExternalSessionRequests {
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly send: (request: FactoryRequest) => Promise<void>;
  private readonly connected: () => boolean;
  private readonly timeoutMs: number;

  constructor(
    send: (request: FactoryRequest) => Promise<void>,
    connected: () => boolean,
    timeoutMs = 20000,
  ) {
    this.send = send;
    this.connected = connected;
    this.timeoutMs = timeoutMs;
  }

  request(
    action: FactoryRequest['action'],
    sessionId: string,
    prompt?: string,
  ): Promise<void> {
    if (!this.connected())
      return Promise.reject(new Error('The attached Pi session disconnected.'));
    if (this.pending.size >= 32)
      return Promise.reject(
        new Error('The attached Pi session already has 32 pending requests.'),
      );
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'The attached Pi session did not answer. Reopen the factory from Pi.',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      void this.send({
        type: 'request',
        id,
        sessionId,
        action,
        ...(prompt === undefined ? {} : {prompt}),
      }).catch(error => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error('The attached Pi session disconnected.'),
        );
      });
    });
  }

  reply(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;
    const reply = message as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      error?: unknown;
    };
    if (
      reply.type !== 'reply' ||
      !requestId(reply.id) ||
      typeof reply.ok !== 'boolean'
    )
      return false;
    const pending = this.pending.get(reply.id);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(reply.id);
    if (reply.ok) pending.resolve();
    else
      pending.reject(
        new Error(
          typeof reply.error === 'string'
            ? reply.error.slice(0, 2000)
            : 'The attached Pi request failed.',
        ),
      );
    return true;
  }

  disconnect(reason = 'The attached Pi session disconnected.'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
