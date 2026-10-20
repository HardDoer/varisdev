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
import {Type} from 'typebox';
import {selectToolModel} from './model-selection.ts';
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
      description:
        'Image model chosen by the user. Otherwise uses the saved choice, then OPENAI_IMAGE_MODEL; offers presets on first GUI use; defaults to gpt-image-2.5-flare without a UI.',
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
  size: Type.Optional(
    Type.String({
      description: `Image size as WIDTHxHEIGHT or auto. Recommended: 1024x1024, 1024x1536, or 1536x1024. Custom dimensions must be multiples of 16, with an aspect ratio between 1:3 and 3:1, neither edge above 3840 pixels, and 655360–8294400 total pixels. Defaults to process.env.OPENAI_IMAGE_SIZE or ${DEFAULT_IMAGE_SIZE}.`,
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
        description: `Image quality. xhigh and max require GPT Image 2.5. Use low for quick drafts; choose higher settings from the user's requested detail, latency, and cost preferences. Defaults to ${DEFAULT_IMAGE_QUALITY}.`,
        default: DEFAULT_IMAGE_QUALITY,
      },
    ),
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
      description: `Output image format for gpt-image models: png, jpeg, or webp. Defaults to process.env.OPENAI_IMAGE_OUTPUT_FORMAT or ${DEFAULT_OUTPUT_FORMAT}.`,
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
  user: Type.Optional(
    Type.String({
      description:
        'Optional end-user identifier sent to OpenAI for abuse monitoring.',
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
};

type OpenAIImageToolDetails = {
  request: {
    operation: 'generate' | 'edit';
    model: string;
    size: string;
    quality?: string;
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
): Promise<InputImagePayload> {
  const path = resolveInputImagePath(cwd, inputImagePath);
  const imageBytes = await readFile(path);
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
    upload: await toFile(Buffer.from(base64, 'base64'), basename(path), {
      type: mimeType,
    }),
  };
}

async function readInputImagePayloads(
  cwd: string,
  inputImagePaths: string[] = [],
): Promise<InputImagePayload[]> {
  if (inputImagePaths.length > MAX_INPUT_IMAGES) {
    throw new Error(
      `Too many input images: ${inputImagePaths.length}. Maximum is ${MAX_INPUT_IMAGES}.`,
    );
  }

  return Promise.all(
    inputImagePaths.map(inputImagePath =>
      readInputImagePayload(cwd, inputImagePath),
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

function normalizeOutputFormat(value: string | undefined): string {
  const format = (
    value ?? envOrDefault('OPENAI_IMAGE_OUTPUT_FORMAT', DEFAULT_OUTPUT_FORMAT)
  )
    .trim()
    .toLowerCase();
  return format === 'jpg' ? 'jpeg' : format;
}

function mimeTypeForFormat(format: string): string {
  if (format === 'jpg' || format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
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
  if (fallbackFormat === 'jpeg' || fallbackFormat === 'jpg') return 'jpg';
  if (fallbackFormat === 'webp') return 'webp';
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

function makeImageRequest(params: {
  model: string;
  prompt: string;
  size: string;
  quality?: string;
  n: number;
  outputFormat: string;
  inputImages?: InputImagePayload[];
  background?: string;
  outputCompression?: number;
  moderation?: string;
  user?: string;
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    n: params.n,
    size: params.size,
    output_format: params.outputFormat,
  };

  if (params.inputImages?.length) {
    const uploads = params.inputImages.map(inputImage => inputImage.upload);
    request.image = uploads.length === 1 ? uploads[0] : uploads;
  }
  if (params.quality) request.quality = params.quality;
  if (params.background) request.background = params.background;
  if (params.outputCompression !== undefined)
    request.output_compression = Math.round(params.outputCompression);
  if (params.moderation) request.moderation = params.moderation;
  if (params.user) request.user = params.user;

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
      'Use the configured image model unless the user requests an override. First GUI use offers presets; headless use defaults to gpt-image-2.5-flare.',
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
      const size =
        params.size?.trim() ||
        envOrDefault('OPENAI_IMAGE_SIZE', DEFAULT_IMAGE_SIZE);
      const quality = params.quality?.trim() || DEFAULT_IMAGE_QUALITY;
      const n = normalizeImageCount(params.n);
      const outputDir = resolveOutputDir(ctx.cwd, params.outputDir);
      const outputFormat = normalizeOutputFormat(params.outputFormat);
      const timeoutMs = normalizeTimeout(params.timeoutMs);
      const baseURL = trimEnv('OPENAI_BASE_URL');
      const inputImages = await readInputImagePayloads(
        ctx.cwd,
        params.inputImagePaths ?? [],
      );
      const operation: OpenAIImageToolDetails['request']['operation'] =
        inputImages.length > 0 ? 'edit' : 'generate';
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
        ...(inputImages.length > 0
          ? {
              inputImages: inputImages.map(inputImage => ({
                path: inputImage.path,
                mimeType: inputImage.mimeType,
                bytes: inputImage.bytes,
              })),
            }
          : {}),
      };

      const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {})});
      const {signal: requestSignal, cleanup} = createTimeoutSignal(
        timeoutMs,
        signal,
      );

      onUpdate?.({
        content: [
          {
            type: 'text',
            text: `Creating ${n} image${n === 1 ? '' : 's'} with ${model}${inputImages.length > 0 ? ` from ${inputImages.length} input image${inputImages.length === 1 ? '' : 's'}` : ''}...`,
          },
        ],
        details: {request: requestDetails, images: []},
      });

      try {
        const request = makeImageRequest({
          model,
          prompt: params.prompt,
          size,
          quality,
          n,
          outputFormat,
          inputImages,
          background: params.background?.trim() || undefined,
          outputCompression: params.outputCompression,
          moderation: params.moderation?.trim() || undefined,
          user: params.user?.trim() || undefined,
        });

        const requestOptions = {
          signal: requestSignal,
          timeout: timeoutMs,
        } as never;
        const response =
          inputImages.length > 0
            ? await client.images.edit(request as never, requestOptions)
            : await client.images.generate(request as never, requestOptions);
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
          let mimeType = mimeTypeForFormat(outputFormat);
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
            await writeFile(outputPath, bytes, {flag: 'wx'});
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
