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

const textLimit = 16000;
function preview(text: string, limit = textLimit): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Preview truncated]`
    : text;
}

const outputLimit = 16000;
const inputLimit = 8000;

export function publicText(text: string): string {
  return text.replace(
    /data:image\/[^;\s]+;base64,[a-z0-9+/=]+/gi,
    '[Image omitted]',
  );
}

/** Read only public text blocks, with no thinking, images or result details. */
export function messageText(message: {content?: unknown}): string {
  if (typeof message.content === 'string')
    return publicText(message.content).slice(0, outputLimit + 1);
  if (!Array.isArray(message.content)) return '';
  let text = '';
  for (const part of message.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    text +=
      (text ? '\n' : '') + publicText(part.text).slice(0, outputLimit + 1);
    if (text.length > outputLimit) return text.slice(0, outputLimit + 1);
  }
  return text;
}

/** Keep arguments as bounded, public JSON so the view can render their real values. */
export function toolInput(args: unknown): string {
  const marker = '[Arguments truncated]';
  const encodedMarker = JSON.stringify(marker);
  const objectMarker = `${JSON.stringify('_truncated')}:${encodedMarker}`;
  let nodes = 0;

  function string(value: string, budget: number): string {
    const text = publicText(value);
    const limit = Math.min(budget, 6000);
    if (limit < JSON.stringify(`\n${marker}`).length) return encodedMarker;
    if (text.length < limit) {
      const encoded = JSON.stringify(text);
      if (encoded.length <= limit) return encoded;
    }
    let low = 0;
    let high = Math.min(text.length, limit);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(`${text.slice(0, middle)}\n${marker}`).length <= limit)
        low = middle;
      else high = middle - 1;
    }
    return JSON.stringify(`${text.slice(0, low)}\n${marker}`);
  }

  function encode(value: unknown, budget: number, depth = 0): string {
    if (++nodes > 100 || depth > 6) return encodedMarker;
    if (typeof value === 'string') return string(value, budget);
    if (!value || typeof value !== 'object')
      return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) {
      if (budget < encodedMarker.length + 2) return encodedMarker;
      const parts: string[] = [];
      let remaining = budget - 2;
      for (let index = 0; index < value.length; index++) {
        const comma = parts.length ? 1 : 0;
        // Keep room for a marker if more array elements must be omitted.
        const reserve = index < value.length - 1 ? encodedMarker.length + 1 : 0;
        if (index >= 30 || remaining - comma - reserve < encodedMarker.length) {
          parts.push(encodedMarker);
          break;
        }
        const part = encode(
          value[index],
          remaining - comma - reserve,
          depth + 1,
        );
        parts.push(part);
        remaining -= part.length + comma;
      }
      return `[${parts.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    if (
      record.type === 'image' ||
      (typeof record.mimeType === 'string' &&
        record.mimeType.startsWith('image/'))
    )
      return JSON.stringify('[Image omitted]');
    if (record.type === 'thinking') return JSON.stringify('[Thinking omitted]');
    if (budget < objectMarker.length + 2) return encodedMarker;
    const parts: string[] = [];
    let remaining = budget - 2;
    const summaryKeys = ['command', 'path', 'file_path', 'url'];
    const entries = Object.entries(record).sort(([a], [b]) => {
      const priority = (key: string) => (summaryKeys.includes(key) ? 0 : 1);
      return priority(a) - priority(b) || a.localeCompare(b);
    });
    for (let index = 0; index < entries.length; index++) {
      const [key, item] = entries[index];
      const name = JSON.stringify(key.slice(0, 200));
      const overhead = name.length + 1 + (parts.length ? 1 : 0);
      const reserve = index < entries.length - 1 ? objectMarker.length + 1 : 0;
      if (
        index >= 40 ||
        remaining - overhead - reserve < encodedMarker.length
      ) {
        parts.push(objectMarker);
        break;
      }
      const part =
        /^(?:base64|thinking|thoughtSignature|signature|providerMetadata)$/i.test(
          key,
        )
          ? JSON.stringify('[Omitted]')
          : encode(item, remaining - overhead - reserve, depth + 1);
      parts.push(`${name}:${part}`);
      remaining -= overhead + part.length;
    }
    return `{${parts.join(',')}}`;
  }
  try {
    return encode(args, inputLimit);
  } catch {
    return JSON.stringify('[Arguments unavailable]');
  }
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
    text: preview(publicText(message.text)),
    visualizations: message.visualizations
      ?.slice(0, MAX_VISUALIZATION_BLOCKS)
      .map(block => ({...block})),
    visualizationErrors: message.visualizationErrors
      ?.slice(0, MAX_VISUALIZATION_BLOCKS)
      .map(error => publicText(error).slice(0, 200)),
    input:
      message.input === undefined ? undefined : preview(message.input, 8000),
    error:
      message.error === undefined ? undefined : preview(message.error, 4000),
    toolName:
      message.toolName === undefined
        ? undefined
        : preview(message.toolName, 200),
    truncated:
      !!message.truncated ||
      message.text.length > textLimit ||
      (message.input?.length ?? 0) > 8000 ||
      !!message.input?.includes('[Arguments truncated]') ||
      (message.error?.length ?? 0) > 4000,
  };
}

function messageSize(message: ConversationMessage): number {
  return (
    message.text.length +
    (message.input?.length ?? 0) +
    (message.error?.length ?? 0) +
    (message.visualizations?.reduce(
      (size, block) =>
        size + (block.type === 'markdown' ? block.text.length : 400),
      0,
    ) ?? 0) +
    (message.visualizationErrors?.join('').length ?? 0)
  );
}

/** Keeps only bounded public conversation text and returns independent snapshots. */
export class ConversationState {
  private messages: ConversationMessage[] = [];
  private truncated = false;

  private trim(): void {
    let size = this.messages.reduce(
      (total, message) => total + messageSize(message),
      0,
    );
    while (this.messages.length > 100 || size > 160000) {
      size -= messageSize(this.messages.shift()!);
      this.truncated = true;
    }
  }

  replace(messages: Iterable<ConversationMessage>, truncated = false): void {
    this.messages = [];
    this.truncated = truncated;
    for (const message of messages) {
      const previous = this.get(message.id);
      this.update({...previous, ...message, at: previous?.at ?? message.at});
    }
  }

  update(message: ConversationMessage): void {
    const entry = projectMessage(message);
    const index = this.messages.findIndex(item => item.id === entry.id);
    if (index < 0) this.messages.push(entry);
    else this.messages[index] = entry;
    this.trim();
  }

  get(id: string): ConversationMessage | undefined {
    const message = this.messages.find(item => item.id === id);
    return message ? projectMessage(message) : undefined;
  }

  settle(status: 'cancelled' | 'failed' = 'cancelled', error?: string): void {
    const now = new Date().toISOString();
    for (const message of this.messages) {
      if (message.streaming) message.streaming = false;
      if (message.role === 'tool' && message.status === 'running') {
        message.status = status;
        message.finishedAt = now;
        if (error) message.error = publicText(error).slice(0, 4000);
      }
    }
  }

  snapshot(): ConversationSnapshot {
    return {
      conversation: this.messages.map(projectMessage),
      conversationTruncated: this.truncated,
    };
  }
}
