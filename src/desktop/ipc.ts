import {randomUUID} from 'node:crypto';
import type {ConversationImageVariant} from '../visualizations.ts';

export interface FactoryRequest {
  type: 'request';
  id: string;
  sessionId: string;
  action:
    | 'prompt'
    | 'abort'
    | 'cancelAgent'
    | 'features'
    | 'configure'
    | 'compact'
    | 'reload'
    | 'conversationImage';
  input?: unknown;
}

export function requestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
}

export function conversationImageInput(value: unknown): {
  imageId: string;
  variant: ConversationImageVariant;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Conversation image request requires an image ID.');
  const input = value as Record<string, unknown>;
  if (
    typeof input.imageId !== 'string' ||
    !/^image-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(
      input.imageId,
    )
  )
    throw new Error(
      'Conversation image request requires a registered image ID.',
    );
  const variant = input.variant ?? 'thumbnail';
  if (variant !== 'thumbnail' && variant !== 'full')
    throw new Error('Unknown conversation image variant.');
  return {imageId: input.imageId, variant};
}

/** Tracks the small set of desktop requests waiting for the attached parent session. */
export class ExternalSessionRequests {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
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

  request<T = void>(
    action: FactoryRequest['action'],
    sessionId: string,
    input?: unknown,
  ): Promise<T> {
    if (!this.connected())
      return Promise.reject(
        new Error('The attached parent session disconnected.'),
      );
    if (action === 'conversationImage' && this.pending.size >= 16)
      return Promise.reject(
        new Error(
          'Too many pending requests to load another conversation image.',
        ),
      );
    if (this.pending.size >= 32)
      return Promise.reject(
        new Error('The parent session already has 32 pending requests.'),
      );
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(
              'The attached parent session did not answer. Reopen the app from the terminal.',
            ),
          );
        },
        action === 'conversationImage'
          ? Math.max(this.timeoutMs, 65000)
          : this.timeoutMs,
      );
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      void this.send({
        type: 'request',
        id,
        sessionId,
        action,
        ...(input === undefined ? {} : {input}),
      }).catch(error => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new Error('The attached parent session disconnected.'),
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
      value?: unknown;
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
    if (reply.ok) pending.resolve(reply.value);
    else
      pending.reject(
        new Error(
          typeof reply.error === 'string'
            ? reply.error.slice(0, 2000)
            : 'The parent session request failed.',
        ),
      );
    return true;
  }

  disconnect(reason = 'The attached parent session disconnected.'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
