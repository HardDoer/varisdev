import OpenAI, {toFile, type Uploadable} from 'openai';
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, extname, join, resolve} from 'node:path';
import {Type, type Static} from 'typebox';
import {processImage} from '../sharp.ts';
import {DEFAULT_IMAGE_MODEL, selectToolModel} from './model-selection.ts';
const DEFAULT_IMAGE_SIZE = '1024x1024';
const DEFAULT_IMAGE_QUALITY = 'auto';
const DEFAULT_OUTPUT_DIR = 'generated-images';
const DEFAULT_OUTPUT_FORMAT = 'png';
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_IMAGES = 4;
const MAX_INPUT_IMAGES = 16;
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
const API_KEY_ENV_VAR = 'OPENAI_API_KEY';
const OPENAI_IMAGE_TOOL_NAME = 'openai_image';

const openAIImageSchema = Type.Object({
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description: `Image model chosen by the user. Otherwise uses the saved choice, then OPENAI_IMAGE_MODEL; offers presets on first GUI use; defaults to ${DEFAULT_IMAGE_MODEL} without a UI.`,
    }),
  ),
  prompt: Type.String({
    description: 'Detailed prompt for the image to create or edit.',
  }),
  inputImagePaths: Type.Optional(
    Type.Array(
      Type.String({
        description:
          'Local PNG, JPEG, or WebP image path to use as input/reference for an image edit. Prefix with @ if helpful; relative paths resolve under the current project.',
      }),
      {
        description: `Optional local image file paths to use as edit inputs. The tool accepts local paths only, reads each file, converts it to a base64-backed OpenAI upload payload, and sends the images array to the edit API. Maximum ${MAX_INPUT_IMAGES}.`,
        minItems: 1,
        maxItems: MAX_INPUT_IMAGES,
      },
    ),
  ),
  markupImagePath: Type.Optional(
    Type.String({
      description:
        'Local transparent PNG annotation layer for an edit. Must match the first input image after orientation and contain transparent pixels. Each may have at most 16,777,216 pixels; the annotation may be at most 50 MiB. Cannot combine with maskImagePath.',
    }),
  ),
  maskImagePath: Type.Optional(
    Type.String({
      description:
        'Local PNG mask with an alpha channel for the first input image. Must match its dimensions after orientation. Cannot combine with markupImagePath or GIF output.',
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: `Image size as WIDTHxHEIGHT or auto. Recommended: 1024x1024, 1024x1536, or 1536x1024. Custom raster dimensions must be multiples of 16, with an aspect ratio between 1:3 and 3:1, neither edge above 3840 pixels, and 655360–8294400 total pixels. GIF accepts auto or positive multiples of 16, subject to the model's frame and total pixel limits; GIF defaults to auto. Otherwise defaults to process.env.OPENAI_IMAGE_SIZE or ${DEFAULT_IMAGE_SIZE}.`,
    }),
  ),
  quality: Type.Optional(
    Type.Union(
      [
        Type.Literal('auto'),
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('xhigh'),
        Type.Literal('max'),
      ],
      {
        description: `Image rendering quality. xhigh and max require GPT Image 2.5 or later. Use low for quick drafts; choose higher settings from the user's requested detail, latency, and cost preferences. Defaults to ${DEFAULT_IMAGE_QUALITY}.`,
        default: DEFAULT_IMAGE_QUALITY,
      },
    ),
  ),
  complexity: Type.Optional(
    Type.Union(
      [Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')],
      {
        description:
          'Image planning effort, independent of rendering quality. Omit for the model default (high for GPT Image 2.6). For SVG, applies to the reference image.',
      },
    ),
  ),
  frameCount: Type.Optional(
    Type.Integer({
      description:
        'GIF frame count, 2–16. GIF output only; defaults to 9 on the API. Requires access to the selected model’s GIF preview.',
      minimum: 2,
      maximum: 16,
    }),
  ),
  frameDurationMs: Type.Optional(
    Type.Integer({
      description:
        'Requested GIF delay per frame in milliseconds, at least 20. Defaults to 200 on the API, which rounds to 10 ms and caps the encoded delay at 655350 ms.',
      minimum: 20,
    }),
  ),
  svg: Type.Optional(
    Type.Object({
      model: Type.String({
        minLength: 1,
        description:
          'SVG author model. Supply this object only with SVG output and access to SVG model selection; otherwise omit it.',
      }),
      reasoning: Type.Optional(
        Type.Object({
          effort: Type.Optional(
            Type.Union([
              Type.Literal('none'),
              Type.Literal('minimal'),
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high'),
              Type.Literal('xhigh'),
              Type.Literal('max'),
            ]),
          ),
        }),
      ),
    }),
  ),
  n: Type.Optional(
    Type.Number({
      description: `Number of images to create. Defaults to 1. Maximum ${MAX_IMAGES} to avoid accidental high-cost calls.`,
      minimum: 1,
      maximum: MAX_IMAGES,
    }),
  ),
  outputDir: Type.Optional(
    Type.String({
      description: `Directory where created image files are saved. Relative paths resolve under the current project. Defaults to process.env.OPENAI_IMAGE_OUTPUT_DIR or ${DEFAULT_OUTPUT_DIR}.`,
    }),
  ),
  filenamePrefix: Type.Optional(
    Type.String({
      description:
        'Optional filename prefix for saved images. The tool adds a timestamp, image index, and random suffix.',
    }),
  ),
  outputFormat: Type.Optional(
    Type.String({
      description: `Output format: png, jpeg, webp, gif, or svg. GIF requires preview access; SVG requires project access, n=1, and no output compression. Defaults to process.env.OPENAI_IMAGE_OUTPUT_FORMAT or ${DEFAULT_OUTPUT_FORMAT}.`,
    }),
  ),
  background: Type.Optional(
    Type.String({
      description:
        'Optional background: auto, opaque, or transparent. Transparent backgrounds require png or webp output.',
    }),
  ),
  outputCompression: Type.Optional(
    Type.Number({
      description:
        'Optional output compression for jpeg/webp on supported models, 0-100.',
      minimum: 0,
      maximum: 100,
    }),
  ),
  moderation: Type.Optional(
    Type.String({
      description:
        'Optional moderation strictness for supported models, for example auto or low.',
    }),
  ),
  safetyIdentifier: Type.Optional(
    Type.String({
      maxLength: 128,
      description:
        'Stable privacy-preserving end-user identifier for safety monitoring, at most 128 characters. A nonempty value takes precedence over deprecated user.',
    }),
  ),
  user: Type.Optional(
    Type.String({
      description:
        'Deprecated end-user identifier. Used when safetyIdentifier is omitted or empty.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `Request timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}. Maximum ${MAX_TIMEOUT_MS}.`,
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
    }),
  ),
});

type ImageToolParams = Static<typeof openAIImageSchema>;
type OutputFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg';

// The installed SDK predates these Images API fields. Its edit method still
// serializes file uploads correctly, including the new multipart markup field.
type ImageRequest = {
  model: string;
  prompt: string;
  size: string;
  quality?: ImageToolParams['quality'];
  complexity?: ImageToolParams['complexity'];
  n: number;
  output_format: OutputFormat;
  background?: string;
  output_compression?: number;
  moderation?: string;
  frame_count?: number;
  frame_duration_ms?: number;
  svg?: ImageToolParams['svg'];
  safety_identifier?: string;
  user?: string;
};
type ImageEditRequest = ImageRequest & {
  image: Uploadable | Uploadable[];
  markup?: Uploadable;
  mask?: Uploadable;
};
type ImageResponse = Omit<OpenAI.Images.ImagesResponse, 'output_format'> & {
  output_format?: OutputFormat;
};
type ImageEndpoints = {
  generate(
    body: ImageRequest,
    options: {signal: AbortSignal; timeout: number},
  ): Promise<ImageResponse>;
  edit(
    body: ImageEditRequest,
    options: {signal: AbortSignal; timeout: number},
  ): Promise<ImageResponse>;
};

type GeneratedImageDetails = {
  path: string;
  mimeType: string;
  bytes: number;
  source: 'base64' | 'url';
  revisedPrompt?: string;
};

type InputImageDetails = {
  path: string;
  mimeType: string;
  bytes: number;
};

type InputImagePayload = InputImageDetails & {
  upload: Uploadable;
  data: Buffer;
};

type OpenAIImageToolDetails = {
  request: {
    operation: 'generate' | 'edit';
    model: string;
    size: string;
    quality?: string;
    complexity?: ImageToolParams['complexity'];
    frameCount?: number;
    frameDurationMs?: number;
    svg?: ImageToolParams['svg'];
    markupImage?: InputImageDetails;
    maskImage?: InputImageDetails;
    n: number;
    outputDir: string;
    outputFormat: string;
    timeoutMs: number;
    apiKeyEnvVar?: string;
    baseURL?: string;
    inputImages?: InputImageDetails[];
  };
  images: GeneratedImageDetails[];
};

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getApiKey(): {apiKey: string; envVarName: string} {
  const apiKey = trimEnv(API_KEY_ENV_VAR);
  if (apiKey) return {apiKey, envVarName: API_KEY_ENV_VAR};
  throw new Error(
    'OpenAI image generation and editing require OPENAI_API_KEY. Set it in Environment settings or the process environment.',
  );
}

function envOrDefault(name: string, fallback: string): string {
  return trimEnv(name) ?? fallback;
}

function normalizeTimeout(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs))
    return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(timeoutMs), 1), MAX_TIMEOUT_MS);
}

function normalizeImageCount(n?: number): number {
  if (n === undefined || !Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.round(n), 1), MAX_IMAGES);
}

function stripAtPath(rawPath: string): string {
  return rawPath.startsWith('@') ? rawPath.slice(1) : rawPath;
}

export function resolveInputImagePath(
  cwd: string,
  inputImagePath: string,
): string {
  const trimmedPath = inputImagePath.trim();
  if (!trimmedPath) throw new Error('Input image path cannot be empty.');
  return resolve(cwd, stripAtPath(trimmedPath));
}

function detectInputImageMimeType(filePath: string, bytes: Buffer): string {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const extensionMimeTypes: Record<string, string> = {
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  const mimeType = extensionMimeTypes[extname(filePath).toLowerCase()];
  if (mimeType) return mimeType;

  throw new Error('Unsupported input image type. Use PNG, JPEG, or WebP.');
}

async function readInputImagePayload(
  cwd: string,
  inputImagePath: string,
  signal?: AbortSignal,
): Promise<InputImagePayload> {
  const path = resolveInputImagePath(cwd, inputImagePath);
  const imageBytes = await readFile(path, {signal});
  if (imageBytes.byteLength === 0)
    throw new Error(`Input image is empty: ${path}`);
  if (imageBytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(
      `Input image is too large: ${formatSize(imageBytes.byteLength)}. Maximum is ${formatSize(MAX_INPUT_IMAGE_BYTES)}.`,
    );
  }

  const mimeType = detectInputImageMimeType(path, imageBytes);
  const base64 = imageBytes.toString('base64');
  // Tool inputs stay as local paths only. For edit requests, build the OpenAI upload from
  // each base64 payload internally so callers never pass raw base64 through parameters.
  return {
    path,
    mimeType,
    bytes: imageBytes.byteLength,
    data: imageBytes,
    upload: await toFile(Buffer.from(base64, 'base64'), basename(path), {
      type: mimeType,
    }),
  };
}

async function readInputImagePayloads(
  cwd: string,
  inputImagePaths: string[] = [],
  signal?: AbortSignal,
): Promise<InputImagePayload[]> {
  if (inputImagePaths.length > MAX_INPUT_IMAGES) {
    throw new Error(
      `Too many input images: ${inputImagePaths.length}. Maximum is ${MAX_INPUT_IMAGES}.`,
    );
  }

  return Promise.all(
    inputImagePaths.map(inputImagePath =>
      readInputImagePayload(cwd, inputImagePath, signal),
    ),
  );
}

export function resolveOutputDir(cwd: string, outputDir?: string): string {
  return resolve(
    cwd,
    stripAtPath(
      outputDir?.trim() ||
        envOrDefault('OPENAI_IMAGE_OUTPUT_DIR', DEFAULT_OUTPUT_DIR),
    ),
  );
}

function sanitizeFilenamePart(
  value: string | undefined,
  fallback: string,
): string {
  const sanitized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return sanitized || fallback;
}

function normalizeOutputFormat(value: string | undefined): OutputFormat {
  const format = (
    value ?? envOrDefault('OPENAI_IMAGE_OUTPUT_FORMAT', DEFAULT_OUTPUT_FORMAT)
  )
    .trim()
    .toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (
    format === 'png' ||
    format === 'jpeg' ||
    format === 'webp' ||
    format === 'gif' ||
    format === 'svg'
  )
    return format;
  throw new Error(
    'Unsupported output format. Use PNG, JPEG, WebP, GIF, or SVG.',
  );
}

function validateImageOptions(
  params: ImageToolParams,
  outputFormat: OutputFormat,
  size: string,
): void {
  const editing = Boolean(params.inputImagePaths?.length);
  if (params.markupImagePath && params.maskImagePath)
    throw new Error('markupImagePath cannot be combined with maskImagePath.');
  if ((params.markupImagePath || params.maskImagePath) && !editing)
    throw new Error('Markup and mask require inputImagePaths for an edit.');
  if (params.safetyIdentifier && params.safetyIdentifier.length > 128)
    throw new Error('safetyIdentifier must be at most 128 characters.');
  if (
    params.outputCompression !== undefined &&
    outputFormat !== 'jpeg' &&
    outputFormat !== 'webp'
  )
    throw new Error('outputCompression requires JPEG or WebP output.');
  if (
    params.background?.trim() === 'transparent' &&
    outputFormat !== 'png' &&
    outputFormat !== 'webp'
  )
    throw new Error('Transparent backgrounds require PNG or WebP output.');
  if (params.svg && outputFormat !== 'svg')
    throw new Error('svg options require SVG output.');
  if (outputFormat === 'svg') {
    if (params.n !== undefined && params.n !== 1)
      throw new Error('SVG output requires n=1.');
    if (params.svg && !params.svg.model.trim())
      throw new Error('svg.model must name an SVG author model.');
  }
  if (outputFormat !== 'gif') {
    if (params.frameCount !== undefined || params.frameDurationMs !== undefined)
      throw new Error('frameCount and frameDurationMs require GIF output.');
    return;
  }
  if (params.maskImagePath)
    throw new Error('GIF output does not support masks.');
  if (
    params.frameCount !== undefined &&
    (!Number.isInteger(params.frameCount) ||
      params.frameCount < 2 ||
      params.frameCount > 16)
  )
    throw new Error('frameCount must be an integer from 2 through 16.');
  if (
    params.frameDurationMs !== undefined &&
    (!Number.isSafeInteger(params.frameDurationMs) ||
      params.frameDurationMs < 20)
  )
    throw new Error('frameDurationMs must be an integer of at least 20.');
  if (size !== 'auto') {
    const dimensions = /^(\d+)x(\d+)$/.exec(size);
    if (
      !dimensions ||
      dimensions.slice(1).some(value => {
        const edge = Number(value);
        return !Number.isSafeInteger(edge) || edge <= 0 || edge % 16 !== 0;
      })
    )
      throw new Error(
        'GIF size must be auto or positive WIDTHxHEIGHT dimensions divisible by 16.',
      );
  }
}

async function readEditLayer(
  cwd: string,
  path: string,
  firstImage: InputImagePayload,
  kind: 'markup' | 'mask',
  signal: AbortSignal,
): Promise<InputImagePayload> {
  const layer = await readInputImagePayload(cwd, path, signal);
  const limitInputPixels = kind === 'markup' ? 16_777_216 : 40_000_000;
  const {metadata: first} = await processImage(
    {input: firstImage.data, output: 'metadata', limitInputPixels},
    signal,
  );
  const decoded = await processImage(
    {input: layer.data, output: 'raw', limitInputPixels},
    signal,
  );
  if (decoded.metadata.format !== 'png')
    throw new Error(`${kind} must be a PNG image.`);
  if (!decoded.metadata.hasAlpha)
    throw new Error(`${kind} must contain an alpha channel.`);
  if (
    first.autoOrient.width !== decoded.info.width ||
    first.autoOrient.height !== decoded.info.height
  )
    throw new Error(
      `${kind} dimensions must match the first input image after orientation.`,
    );
  if (kind === 'markup') {
    let transparent = false;
    for (let index = 3; index < decoded.data.length; index += 4) {
      if (decoded.data[index] < 255) {
        transparent = true;
        break;
      }
    }
    if (!transparent)
      throw new Error('markup must contain transparent pixels.');
  }
  return layer;
}

function inputImageDetails(image: InputImagePayload): InputImageDetails {
  return {path: image.path, mimeType: image.mimeType, bytes: image.bytes};
}

function mimeTypeForFormat(format: string): string {
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'gif') return 'image/gif';
  if (format === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function extensionForMimeType(
  mimeType: string,
  fallbackFormat: string,
): string {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/svg+xml') return 'svg';
  if (fallbackFormat === 'jpeg' || fallbackFormat === 'jpg') return 'jpg';
  if (fallbackFormat === 'webp') return 'webp';
  if (fallbackFormat === 'gif') return 'gif';
  if (fallbackFormat === 'svg') return 'svg';
  return 'png';
}

function createOutputPath(
  outputDir: string,
  prefix: string,
  index: number,
  extension: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(
    outputDir,
    `${prefix}-${timestamp}-${index + 1}-${randomUUID().slice(0, 8)}.${extension}`,
  );
}

function decodeBase64Image(data: string): Buffer {
  const commaIndex = data.indexOf(',');
  const base64 = commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
  return Buffer.from(base64, 'base64');
}

async function fetchImageFromUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{bytes: Buffer; mimeType: string}> {
  const response = await fetch(url, {signal});
  if (!response.ok) {
    throw new Error(
      `Failed to download OpenAI image: ${response.status} ${response.statusText}`,
    );
  }

  const mimeType = response.headers.get('content-type') ?? 'image/png';
  return {bytes: Buffer.from(await response.arrayBuffer()), mimeType};
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as {unref?: () => void}).unref?.();
  }
}

function createTimeoutSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): {signal: AbortSignal; cleanup: () => void} {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(`OpenAI image request timed out after ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  unrefTimer(timeout);

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, {once: true});
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function makeImageRequest(
  params: ImageToolParams,
  model: string,
  size: string,
  n: number,
  outputFormat: OutputFormat,
): ImageRequest {
  const request: ImageRequest = {
    model,
    prompt: params.prompt,
    n,
    size,
    quality: params.quality ?? DEFAULT_IMAGE_QUALITY,
    output_format: outputFormat,
  };
  if (params.complexity) request.complexity = params.complexity;
  if (params.background?.trim()) request.background = params.background.trim();
  if (params.outputCompression !== undefined)
    request.output_compression = Math.round(params.outputCompression);
  if (params.moderation?.trim()) request.moderation = params.moderation.trim();
  if (params.frameCount !== undefined) request.frame_count = params.frameCount;
  if (params.frameDurationMs !== undefined)
    request.frame_duration_ms = params.frameDurationMs;
  if (params.svg) request.svg = params.svg;
  const safetyIdentifier = params.safetyIdentifier?.trim();
  if (safetyIdentifier) request.safety_identifier = safetyIdentifier;
  else if (params.user?.trim()) request.user = params.user.trim();
  return request;
}

function formatResultText(images: GeneratedImageDetails[]): string {
  const lines = [
    `Saved ${images.length} OpenAI image${images.length === 1 ? '' : 's'}.`,
  ];

  for (const [index, image] of images.entries()) {
    lines.push(
      `- ${image.path} (${image.mimeType}, ${formatSize(image.bytes)})`,
    );
    if (image.revisedPrompt) {
      const revisedPrompt = truncateHead(image.revisedPrompt, {
        maxLines: 6,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      lines.push(`  revised prompt ${index + 1}: ${revisedPrompt.content}`);
    }
  }

  return lines.join('\n');
}

export function registerOpenAIImageTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof openAIImageSchema, OpenAIImageToolDetails>({
    name: OPENAI_IMAGE_TOOL_NAME,
    label: 'OpenAI Image',
    description:
      "Create or edit images using the user's chosen OpenAI image model and save them in the current project. Requires OPENAI_API_KEY from Environment settings or the process environment.",
    promptSnippet:
      'Create or edit images with the OpenAI Images API and save them to project files.',
    promptGuidelines: [
      'Use openai_image when the user asks to generate, edit, transform, restyle, or use input images with OpenAI.',
      `Use the configured image model unless the user requests an override. First GUI use offers presets; headless use defaults to ${DEFAULT_IMAGE_MODEL}.`,
      'openai_image authenticates only with OPENAI_API_KEY from Environment settings or the process environment, independently of Accounts. Never ask the user to paste the API key into tool arguments.',
      'When the user wants to use existing local images, pass their paths as inputImagePaths. Do not pass raw base64; the tool reads each path and builds the base64-backed OpenAI edit payloads internally.',
      'openai_image returns saved file paths; refer to those paths instead of embedding base64 image data in the final answer.',
      `Choose the quality parameter from the user's requested speed/detail/cost preference; use ${DEFAULT_IMAGE_QUALITY} when unspecified.`,
      'If you notice unexpected or unfinished behavior when using openai_image, report it to the user.',
    ],
    parameters: openAIImageSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const {apiKey, envVarName} = getApiKey();
      const model = await selectToolModel(
        'openai-image',
        params.model,
        ctx,
        signal,
      );
      const outputFormat = normalizeOutputFormat(params.outputFormat);
      const size =
        params.size?.trim() ||
        envOrDefault(
          'OPENAI_IMAGE_SIZE',
          outputFormat === 'gif' ? 'auto' : DEFAULT_IMAGE_SIZE,
        );
      const quality = params.quality ?? DEFAULT_IMAGE_QUALITY;
      const n = normalizeImageCount(params.n);
      const outputDir = resolveOutputDir(ctx.cwd, params.outputDir);
      const timeoutMs = normalizeTimeout(params.timeoutMs);
      const baseURL = trimEnv('OPENAI_BASE_URL');
      validateImageOptions(params, outputFormat, size);
      const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {})});
      const imagesApi = client.images as unknown as ImageEndpoints;
      const {signal: requestSignal, cleanup} = createTimeoutSignal(
        timeoutMs,
        signal,
      );

      try {
        requestSignal.throwIfAborted();
        const inputImages = await readInputImagePayloads(
          ctx.cwd,
          params.inputImagePaths ?? [],
          requestSignal,
        );
        const markupImage = params.markupImagePath
          ? await readEditLayer(
              ctx.cwd,
              params.markupImagePath,
              inputImages[0],
              'markup',
              requestSignal,
            )
          : undefined;
        const maskImage = params.maskImagePath
          ? await readEditLayer(
              ctx.cwd,
              params.maskImagePath,
              inputImages[0],
              'mask',
              requestSignal,
            )
          : undefined;
        requestSignal.throwIfAborted();
        const operation = inputImages.length > 0 ? 'edit' : 'generate';
        const requestDetails: OpenAIImageToolDetails['request'] = {
          operation,
          model,
          size,
          quality,
          n,
          outputDir,
          outputFormat,
          timeoutMs,
          apiKeyEnvVar: envVarName,
          baseURL,
          ...(params.complexity ? {complexity: params.complexity} : {}),
          ...(params.frameCount !== undefined
            ? {frameCount: params.frameCount}
            : {}),
          ...(params.frameDurationMs !== undefined
            ? {frameDurationMs: params.frameDurationMs}
            : {}),
          ...(params.svg ? {svg: params.svg} : {}),
          ...(inputImages.length
            ? {inputImages: inputImages.map(inputImageDetails)}
            : {}),
          ...(markupImage ? {markupImage: inputImageDetails(markupImage)} : {}),
          ...(maskImage ? {maskImage: inputImageDetails(maskImage)} : {}),
        };
        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `Creating ${n} image${n === 1 ? '' : 's'} with ${model}${inputImages.length > 0 ? ` from ${inputImages.length} input image${inputImages.length === 1 ? '' : 's'}` : ''}...`,
            },
          ],
          details: {request: requestDetails, images: []},
        });
        const request = makeImageRequest(params, model, size, n, outputFormat);
        const requestOptions = {signal: requestSignal, timeout: timeoutMs};
        const response =
          inputImages.length > 0
            ? await imagesApi.edit(
                {
                  ...request,
                  image:
                    inputImages.length === 1
                      ? inputImages[0].upload
                      : inputImages.map(image => image.upload),
                  ...(markupImage ? {markup: markupImage.upload} : {}),
                  ...(maskImage ? {mask: maskImage.upload} : {}),
                },
                requestOptions,
              )
            : await imagesApi.generate(request, requestOptions);
        requestSignal.throwIfAborted();
        const data = Array.isArray(response.data) ? response.data : [];

        if (data.length === 0) {
          throw new Error('OpenAI returned no images.');
        }

        await mkdir(outputDir, {recursive: true});
        onUpdate?.({
          content: [
            {
              type: 'text',
              text: `Saving ${data.length} image${data.length === 1 ? '' : 's'}...`,
            },
          ],
          details: {request: requestDetails, images: []},
        });

        const filenamePrefix = sanitizeFilenamePart(
          params.filenamePrefix,
          'openai-image',
        );
        const images: GeneratedImageDetails[] = [];

        for (const [index, image] of data.entries()) {
          let bytes: Buffer;
          requestSignal.throwIfAborted();
          let mimeType = mimeTypeForFormat(
            response.output_format ?? outputFormat,
          );
          let source: GeneratedImageDetails['source'];

          if (typeof image.b64_json === 'string' && image.b64_json.length > 0) {
            bytes = decodeBase64Image(image.b64_json);
            source = 'base64';
          } else if (typeof image.url === 'string' && image.url.length > 0) {
            const downloaded = await fetchImageFromUrl(
              image.url,
              requestSignal,
            );
            bytes = downloaded.bytes;
            mimeType = downloaded.mimeType;
            source = 'url';
          } else {
            throw new Error(
              `OpenAI image ${index + 1} did not include b64_json or url data.`,
            );
          }

          const extension = extensionForMimeType(mimeType, outputFormat);
          const outputPath = createOutputPath(
            outputDir,
            filenamePrefix,
            index,
            extension,
          );

          await withFileMutationQueue(outputPath, async () => {
            requestSignal.throwIfAborted();
            await writeFile(outputPath, bytes, {
              flag: 'wx',
              signal: requestSignal,
            });
          });

          images.push({
            path: outputPath,
            mimeType,
            bytes: bytes.byteLength,
            source,
            revisedPrompt:
              typeof image.revised_prompt === 'string'
                ? image.revised_prompt
                : undefined,
          });
        }

        return {
          content: [{type: 'text', text: formatResultText(images)}],
          details: {
            request: requestDetails,
            images,
          },
        };
      } finally {
        cleanup();
      }
    },
  });
}
