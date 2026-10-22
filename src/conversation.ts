import {isDeepStrictEqual} from 'node:util';
import {conversationImageRegistry} from './conversation-images.ts';
import {
  MAX_VISUALIZATION_BLOCKS,
  MAX_VISUALIZATION_MARKDOWN,
  type ConversationVisualizations,
  type DisplayVisualization,
} from './visualizations.ts';

export type {
  ConversationImage,
  DisplayVisualization,
} from './visualizations.ts';

export interface ConversationMessage extends ConversationVisualizations {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
  streaming?: boolean;
  truncated?: boolean;
  error?: string;
  toolName?: string;
  toolCallId?: string;
  input?: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  finishedAt?: string;
}

export interface ConversationSnapshot {
  conversation: ConversationMessage[];
  conversationTruncated: boolean;
}

export function publicText(text: string): string {
  return text.replace(
    /data:image\/[^;\s]+;base64,[a-z0-9+/=]+/gi,
    '[Image omitted]',
  );
}

/** Read only public text blocks, with no thinking, images or result details. */
export function messageText(message: {content?: unknown}): string {
  if (typeof message.content === 'string') return publicText(message.content);
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => publicText(part.text))
    .join('\n');
}

/** Preserve public JSON arguments without calling getters or user serializers. */
export function toolInput(args: unknown): string {
  const unavailable = JSON.stringify('[Arguments unavailable]');
  const omitted = JSON.stringify('[Omitted]');
  const privateKey =
    /^(?:base64|thinking|thoughtSignature|signature|providerMetadata)$/i;
  const summaryKeys = new Set(['command', 'path', 'file_path', 'url']);
  type Frame = {
    value: object;
    keys: string[];
    index: number;
    array: boolean;
  };
  const frames: Frame[] = [];
  const ancestors = new WeakSet<object>();
  const parts: string[] = [];

  function ownValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor))
      throw new Error('Argument accessors are unavailable');
    return descriptor?.value;
  }

  function encode(value: unknown): void {
    if (typeof value === 'string') {
      parts.push(JSON.stringify(publicText(value)));
      return;
    }
    if (!value || typeof value !== 'object') {
      parts.push(
        typeof value === 'bigint'
          ? unavailable
          : typeof value === 'number' || typeof value === 'boolean'
            ? JSON.stringify(value)
            : 'null',
      );
      return;
    }
    if (ancestors.has(value)) {
      parts.push(JSON.stringify('[Circular]'));
      return;
    }
    try {
      const array = Array.isArray(value);
      if (!array) {
        const type = ownValue(value, 'type');
        const mimeType = ownValue(value, 'mimeType');
        if (
          type === 'image' ||
          (typeof mimeType === 'string' && mimeType.startsWith('image/'))
        ) {
          parts.push(JSON.stringify('[Image omitted]'));
          return;
        }
        if (type === 'thinking') {
          parts.push(JSON.stringify('[Thinking omitted]'));
          return;
        }
      }
      const keys = array
        ? Array.from({length: (value as unknown[]).length}, (_, index) =>
            String(index),
          )
        : Object.keys(value).sort(
            (a, b) =>
              Number(summaryKeys.has(b)) - Number(summaryKeys.has(a)) ||
              a.localeCompare(b),
          );
      ancestors.add(value);
      frames.push({value, keys, index: 0, array});
      parts.push(array ? '[' : '{');
    } catch {
      parts.push(unavailable);
    }
  }

  encode(args);
  // An explicit stack handles deeply nested JSON and only marks ancestor cycles.
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (frame.index === frame.keys.length) {
      parts.push(frame.array ? ']' : '}');
      ancestors.delete(frame.value);
      frames.pop();
      continue;
    }
    if (frame.index) parts.push(',');
    const key = frame.keys[frame.index++];
    if (!frame.array) parts.push(`${JSON.stringify(publicText(key))}:`);
    if (!frame.array && privateKey.test(key)) {
      parts.push(omitted);
      continue;
    }
    try {
      encode(ownValue(frame.value, key));
    } catch {
      parts.push(unavailable);
    }
  }
  return parts.join('');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Validate plugin metadata and register image references without decoding images. */
export function conversationVisualizations(
  message: {content?: unknown; details?: unknown},
  details: unknown = message.details,
  cwd = process.cwd(),
): ConversationVisualizations {
  const visualizations: DisplayVisualization[] = [];
  const errors: string[] = [];
  const error = (text: string) => {
    if (errors.length < MAX_VISUALIZATION_BLOCKS)
      errors.push(text.slice(0, 200));
  };
  const room = () => {
    if (visualizations.length < MAX_VISUALIZATION_BLOCKS) return true;
    error('Only the first 8 visualization blocks are displayed.');
    return false;
  };
  const label = (value: unknown) =>
    typeof value === 'string' ? publicText(value).slice(0, 200) : undefined;
  const image = (block: Record<string, unknown>) => {
    if (!room()) return;
    if (typeof block.path !== 'string') {
      error('Image visualization requires a path.');
      return;
    }
    try {
      const legacy = Array.isArray(data.images)
        ? record(
            data.images
              .slice(0, MAX_VISUALIZATION_BLOCKS)
              .find(item => record(item).path === block.path),
          )
        : {};
      visualizations.push(
        conversationImageRegistry.registerPath(block.path, cwd, {
          label: label(block.label),
          width:
            typeof block.width === 'number'
              ? block.width
              : typeof legacy.width === 'number'
                ? legacy.width
                : undefined,
          height:
            typeof block.height === 'number'
              ? block.height
              : typeof legacy.height === 'number'
                ? legacy.height
                : undefined,
        }),
      );
    } catch (failure) {
      error(
        failure instanceof Error
          ? failure.message
          : 'Image visualization is unavailable.',
      );
    }
  };
  const data = record(details);
  if ('varisdev' in data) {
    const metadata = record(data.varisdev);
    if (metadata.version !== 1)
      error('Unsupported VarisDev visualization version.');
    else if (!Array.isArray(metadata.blocks))
      error('VarisDev visualization blocks must be an array.');
    else {
      if (metadata.blocks.length > MAX_VISUALIZATION_BLOCKS)
        error('Only the first 8 visualization blocks are displayed.');
      for (const item of metadata.blocks.slice(0, MAX_VISUALIZATION_BLOCKS)) {
        const block = record(item);
        if (block.type === 'image') image(block);
        else if (block.type === 'markdown') {
          if (typeof block.text !== 'string')
            error('Markdown visualization requires text.');
          else if (room()) {
            const text = publicText(block.text);
            if (text.length > MAX_VISUALIZATION_MARKDOWN)
              error(
                'Markdown visualization was truncated to 16000 characters.',
              );
            visualizations.push({
              type: 'markdown',
              text: text.slice(0, MAX_VISUALIZATION_MARKDOWN),
            });
          }
        } else if (block.type === 'progress') {
          if (
            typeof block.value !== 'number' ||
            !Number.isFinite(block.value) ||
            (block.total !== undefined &&
              (typeof block.total !== 'number' ||
                !Number.isFinite(block.total) ||
                block.total <= 0))
          )
            error(
              'Progress visualization requires a finite value and a positive finite total when supplied.',
            );
          else if (room())
            visualizations.push({
              type: 'progress',
              value: block.value,
              total: block.total as number | undefined,
              label: label(block.label),
            });
        } else error('Unsupported VarisDev visualization block type.');
      }
    }
  } else if (Array.isArray(data.images)) {
    if (data.images.length > MAX_VISUALIZATION_BLOCKS)
      error('Only the first 8 visualization blocks are displayed.');
    for (const item of data.images.slice(0, MAX_VISUALIZATION_BLOCKS))
      image(record(item));
  }
  if (Array.isArray(message.content)) {
    // Scan a bounded number of parts; text projection remains independent.
    for (const item of message.content.slice(0, 100)) {
      const part = record(item);
      if (part.type !== 'image') continue;
      if (!room()) break;
      try {
        if (typeof part.data !== 'string' || typeof part.mimeType !== 'string')
          throw new Error(
            'Image attachment requires base64 data and a media type.',
          );
        visualizations.push(
          conversationImageRegistry.registerInline(part.data, part.mimeType),
        );
      } catch (failure) {
        error(
          failure instanceof Error
            ? failure.message
            : 'Image attachment is unavailable.',
        );
      }
    }
  }
  return {
    visualizations: visualizations.length ? visualizations : undefined,
    visualizationErrors: errors.length ? errors : undefined,
  };
}

export function resultStatus(
  isError: boolean,
  text: string,
): ConversationMessage['status'] {
  if (!isError) return 'completed';
  return /^(?:Operation|Tool execution) (?:aborted|cancelled)\.?$/i.test(
    text.trim(),
  )
    ? 'cancelled'
    : 'failed';
}

export function projectMessage(
  message: ConversationMessage,
): ConversationMessage {
  return {
    ...message,
    text: publicText(message.text),
    visualizations: message.visualizations
      ?.slice(0, MAX_VISUALIZATION_BLOCKS)
      .map(block => ({...block})),
    visualizationErrors: message.visualizationErrors
      ?.slice(0, MAX_VISUALIZATION_BLOCKS)
      .map(error => publicText(error).slice(0, 200)),
    input: message.input === undefined ? undefined : publicText(message.input),
    error: message.error === undefined ? undefined : publicText(message.error),
    toolName:
      message.toolName === undefined ? undefined : publicText(message.toolName),
    truncated: !!message.truncated,
  };
}

function copyMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    visualizations: message.visualizations?.map(block => ({...block})),
    visualizationErrors: message.visualizationErrors?.slice(),
  };
}

/** Retains public conversation history and returns independent snapshots. */
export class ConversationState {
  private messages: ConversationMessage[] = [];
  private indices = new Map<string, number>();
  private truncated = false;

  replace(messages: Iterable<ConversationMessage>, truncated = false): boolean {
    const replacement = new ConversationState();
    replacement.truncated = truncated;
    for (const message of messages) {
      const previous = replacement.get(message.id);
      const candidate = {
        ...previous,
        ...message,
        at: previous?.at ?? message.at,
      };
      const index = this.indices.get(message.id);
      const retained = index === undefined ? undefined : this.messages[index];
      // Worker snapshots resend unchanged history alongside the updated row.
      replacement.store(
        retained && isDeepStrictEqual(retained, candidate)
          ? retained
          : projectMessage(candidate),
      );
    }
    if (
      this.truncated === truncated &&
      isDeepStrictEqual(this.messages, replacement.messages)
    )
      return false;
    this.messages = replacement.messages;
    this.indices = replacement.indices;
    this.truncated = truncated;
    return true;
  }

  update(message: ConversationMessage): boolean {
    return this.store(projectMessage(message));
  }

  private store(entry: ConversationMessage): boolean {
    const index = this.indices.get(entry.id);
    if (index === undefined) {
      this.indices.set(entry.id, this.messages.length);
      this.messages.push(entry);
    } else {
      if (isDeepStrictEqual(this.messages[index], entry)) return false;
      this.messages[index] = entry;
    }
    return true;
  }

  get(id: string): ConversationMessage | undefined {
    const index = this.indices.get(id);
    return index === undefined ? undefined : copyMessage(this.messages[index]);
  }

  settle(
    status: 'cancelled' | 'failed' = 'cancelled',
    error?: string,
  ): boolean {
    const now = new Date().toISOString();
    let changed = false;
    for (const message of this.messages) {
      if (message.streaming) {
        message.streaming = false;
        changed = true;
      }
      if (message.role === 'tool' && message.status === 'running') {
        message.status = status;
        message.finishedAt = now;
        if (error) message.error = publicText(error);
        changed = true;
      }
    }
    return changed;
  }

  snapshot(): ConversationSnapshot {
    return {
      conversation: this.messages.map(copyMessage),
      conversationTruncated: this.truncated,
    };
  }
}
