import {createHash, randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {readPreviewImage, resolveImagePath} from './image-preview/files.ts';
import {processImage} from './sharp.ts';
import type {
  ConversationImage,
  ConversationImageResponse,
  ConversationImageVariant,
} from './visualizations.ts';

const MiB = 1024 * 1024;
const maxInputBytes = 50 * MiB;
const maxPixels = 40_000_000;
type Entry = {
  key: string;
  image: ConversationImage;
  data?: string;
  bytes: number;
  cache: Map<
    ConversationImageVariant,
    {signature: string; result: ConversationImageResponse; bytes: number}
  >;
};

/** Bounded process memory, with image decoding deferred until a viewer asks. */
export class ConversationImageRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly keys = new Map<string, string>();
  private readonly pending = new Map<
    string,
    Promise<ConversationImageResponse>
  >();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private storage = 0;
  private cached = 0;
  private readonly maxEntries: number;
  private readonly maxStorageBytes: number;
  private readonly maxCacheBytes: number;

  constructor(
    limits: {
      maxEntries?: number;
      maxStorageBytes?: number;
      maxCacheBytes?: number;
    } = {},
  ) {
    this.maxEntries = limits.maxEntries ?? 256;
    this.maxStorageBytes = limits.maxStorageBytes ?? 64 * MiB;
    this.maxCacheBytes = limits.maxCacheBytes ?? 32 * MiB;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get stats() {
    return {
      entries: this.entries.size,
      storageBytes: this.storage,
      cacheBytes: this.cached,
      active: this.active,
      queued: this.queue.length,
    };
  }

  private touch(entry: Entry): void {
    this.entries.delete(entry.image.id);
    this.entries.set(entry.image.id, entry);
  }

  private remove(entry: Entry): void {
    this.entries.delete(entry.image.id);
    this.keys.delete(entry.key);
    this.storage -= entry.bytes;
    for (const cache of entry.cache.values()) this.cached -= cache.bytes;
    // Pending loads may still hold the entry; release its stored payload now.
    entry.data = undefined;
    entry.cache.clear();
  }

  private register(
    key: string,
    image: Omit<ConversationImage, 'id'>,
    data?: string,
  ): ConversationImage {
    const known = this.keys.get(key);
    const existing = known ? this.entries.get(known) : undefined;
    if (existing) {
      this.touch(existing);
      return {
        ...existing.image,
        ...image,
        width: image.width ?? existing.image.width,
        height: image.height ?? existing.image.height,
      };
    }
    const bytes = data ? data.length * 2 : 0;
    if (bytes > this.maxStorageBytes)
      throw new Error(
        'Image attachment exceeds the conversation image memory limit.',
      );
    while (
      this.entries.size >= this.maxEntries ||
      this.storage + bytes > this.maxStorageBytes
    ) {
      const oldest = this.entries.values().next().value;
      if (!oldest) throw new Error('Conversation image registry is full.');
      this.remove(oldest);
    }
    const entry: Entry = {
      key,
      image: {...image, id: `image-${randomUUID()}`},
      data,
      bytes,
      cache: new Map(),
    };
    this.entries.set(entry.image.id, entry);
    this.keys.set(key, entry.image.id);
    this.storage += bytes;
    return {...entry.image};
  }

  registerPath(
    value: string,
    cwd = process.cwd(),
    metadata: {label?: string; width?: number; height?: number} = {},
  ): ConversationImage {
    if (value.length > 4096)
      throw new Error('Image path exceeds 4096 characters.');
    const path = resolveImagePath(value, cwd);
    if (!path)
      throw new Error('Image visualization requires a local image path.');
    const dimensions = (value: number | undefined) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : undefined;
    let signature = 'unavailable';
    try {
      const info = statSync(path);
      signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch {
      // Missing or unreadable paths remain registered so the viewer can retry.
    }
    return this.register(`path:${path}:${signature}`, {
      type: 'image',
      path,
      name: basename(path).slice(0, 200),
      label: metadata.label?.slice(0, 200),
      width: dimensions(metadata.width),
      height: dimensions(metadata.height),
    });
  }

  registerInline(data: string, mimeType: string): ConversationImage {
    if (
      !/^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml|tiff|bmp)$/i.test(mimeType)
    )
      throw new Error('Image attachment has an unsupported media type.');
    if (!data || data.length > Math.ceil(maxInputBytes / 3) * 4)
      throw new Error('Image attachment exceeds 50 MiB or is empty.');
    if (data.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/i.test(data))
      throw new Error('Image attachment contains invalid base64 data.');
    const digest = createHash('sha256').update(data).digest('hex');
    return this.register(
      `inline:${mimeType}:${digest}`,
      {
        type: 'image',
        name: `Attachment.${mimeType.split('/')[1].replace('svg+xml', 'svg')}`,
      },
      data,
    );
  }

  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.queue.length >= 32)
      throw new Error('Conversation image loading queue is full.');
    if (this.active >= 2)
      await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  async read(
    id: string,
    variant: ConversationImageVariant = 'thumbnail',
  ): Promise<ConversationImageResponse> {
    if (variant !== 'thumbnail' && variant !== 'full')
      throw new Error('Unknown conversation image variant.');
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Conversation image is no longer available.');
    this.touch(entry);
    const key = `${id}:${variant}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.slot(async () => {
      if (this.entries.get(id) !== entry)
        throw new Error('Conversation image was evicted.');
      let signature = 'inline';
      if (entry.image.path) {
        let info;
        try {
          info = await stat(entry.image.path);
        } catch {
          throw new Error('Conversation image file is missing or unreadable.');
        }
        if (!info.isFile())
          throw new Error('Conversation image path is not a file.');
        if (info.size > maxInputBytes)
          throw new Error('Conversation image exceeds 50 MiB.');
        signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      }
      const cached = entry.cache.get(variant);
      if (cached?.signature === signature) return {...cached.result};
      const input = entry.data
        ? Buffer.from(entry.data, 'base64')
        : await readPreviewImage(entry.image.path!);
      if (input.length > maxInputBytes)
        throw new Error('Conversation image exceeds 50 MiB.');
      const edge = variant === 'thumbnail' ? 640 : 2560;
      let decoded;
      try {
        decoded = await processImage({
          input,
          output: 'png',
          limitInputPixels: maxPixels,
          resize: {width: edge, height: edge},
        });
      } catch (error) {
        throw new Error(
          `Could not decode conversation image: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            400,
          ),
        );
      }
      if (decoded.data.length > 8 * MiB)
        throw new Error('Conversation image raster exceeds 8 MiB.');
      if (this.entries.get(id) !== entry)
        throw new Error('Conversation image was evicted.');
      entry.image.width = decoded.metadata.width;
      entry.image.height = decoded.metadata.height;
      const result = {
        src: `data:image/png;base64,${decoded.data.toString('base64')}`,
        width: decoded.info.width,
        height: decoded.info.height,
        name: entry.image.name,
      };
      const previousCache = entry.cache.get(variant);
      if (previousCache) {
        this.cached -= previousCache.bytes;
        entry.cache.delete(variant);
      }
      const bytes = result.src.length * 2;
      // Clear the oldest transformed images while preserving their source references.
      for (const old of this.entries.values()) {
        if (this.cached + bytes <= this.maxCacheBytes) break;
        for (const [oldVariant, cache] of old.cache) {
          this.cached -= cache.bytes;
          old.cache.delete(oldVariant);
          if (this.cached + bytes <= this.maxCacheBytes) break;
        }
      }
      if (bytes <= this.maxCacheBytes) {
        entry.cache.set(variant, {signature, result, bytes});
        this.cached += bytes;
      }
      return {...result};
    });
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
}

// Source extensions and the compiled desktop can share this process.
const registrySymbol = Symbol.for('varisdev.conversation-images.v1');
const globals = globalThis as typeof globalThis & {
  [registrySymbol]?: ConversationImageRegistry;
};
export const conversationImageRegistry = (globals[registrySymbol] ??=
  new ConversationImageRegistry());

export function hasConversationImage(id: string): boolean {
  return conversationImageRegistry.has(id);
}

export function readConversationImage(
  id: string,
  variant: ConversationImageVariant = 'thumbnail',
): Promise<ConversationImageResponse> {
  return conversationImageRegistry.read(id, variant);
}
