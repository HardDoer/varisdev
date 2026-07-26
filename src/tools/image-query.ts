import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {glob, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve} from 'node:path';
import sharp from 'sharp';
import {Type} from 'typebox';

const DEFAULT_MAX_FILES = 100;
const MAX_FILES = 500;
const MAX_EXCLUDE_PATTERNS = 20;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const MAX_GRID_CELL_SIZE = 16_384;
const MAX_GRID_CELLS = 1_024;

const imageQuerySchema = Type.Object({
  path: Type.String({
    description:
      'Image file path or glob pattern, relative to the current project. Prefix with @ if helpful.',
  }),
  exclude: Type.Optional(
    Type.Array(
      Type.String({
        description:
          'Glob pattern to exclude. Patterns are evaluated relative to the current project.',
      }),
      {
        description: `Optional glob patterns to exclude. Maximum ${MAX_EXCLUDE_PATTERNS}.`,
        minItems: 1,
        maxItems: MAX_EXCLUDE_PATTERNS,
      },
    ),
  ),
  alphaThreshold: Type.Optional(
    Type.Integer({
      description:
        'Count pixels whose alpha value is greater than this threshold (0-254). Defaults to 0, meaning any visible pixel.',
      minimum: 0,
      maximum: 254,
    }),
  ),
  grid: Type.Optional(
    Type.Object(
      {
        cellWidth: Type.Integer({
          description: 'Grid cell width in pixels.',
          minimum: 1,
          maximum: MAX_GRID_CELL_SIZE,
        }),
        cellHeight: Type.Integer({
          description: 'Grid cell height in pixels.',
          minimum: 1,
          maximum: MAX_GRID_CELL_SIZE,
        }),
      },
      {
        description:
          'Optional fixed-size grid for per-cell alpha occupancy counts. Edge cells are clipped to the image, and cells are returned in row-major order.',
      },
    ),
  ),
  maxFiles: Type.Optional(
    Type.Integer({
      description: `Maximum files to process. Defaults to ${DEFAULT_MAX_FILES}. Maximum ${MAX_FILES}.`,
      minimum: 1,
      maximum: MAX_FILES,
    }),
  ),
});

type ImageGridRequest = {
  cellWidth: number;
  cellHeight: number;
};

type PixelBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type AlphaDetails = {
  threshold: number;
  matchingPixels: number;
  totalPixels: number;
  transparentPixels: number;
  translucentPixels: number;
  opaquePixels: number;
  minimum: number;
  maximum: number;
  mean: number;
  bounds: PixelBounds | null;
};

type ImageGridDetails = ImageGridRequest & {
  columns: number;
  rows: number;
  matchingPixels: number[][];
  totalPixels: number[][];
};

type ImageQueryFileDetails = {
  path: string;
  bytes?: number;
  format?: string;
  width?: number;
  height?: number;
  channels?: number;
  colourSpace?: string;
  depth?: string;
  sourceHasAlpha?: boolean;
  pages?: number;
  alpha?: AlphaDetails;
  grid?: ImageGridDetails;
  error?: string;
};

type ImageQueryToolDetails = {
  request: {
    path: string;
    exclude?: string[];
    alphaThreshold: number;
    grid?: ImageGridRequest;
    maxFiles: number;
  };
  summary: {
    filesProcessed: number;
    filesSucceeded: number;
    filesFailed: number;
    fileLimitReached: boolean;
    totalPixels: number;
    matchingPixels: number;
  };
  files: ImageQueryFileDetails[];
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

type ImageFile = {
  absolutePath: string;
  displayPath: string;
};

function stripAtPath(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

function normalizePattern(rawPattern: string, label: string): string {
  const pattern = stripAtPath(rawPattern.trim());
  if (!pattern) throw new Error(`${label} cannot be empty.`);
  return pattern;
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function displayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath);
  const output =
    relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
      ? relativePath
      : absolutePath;
  return output.replaceAll('\\', '/');
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('image_query cancelled.');
}

async function findImageFiles(
  cwd: string,
  pattern: string,
  exclude: string[],
  maxFiles: number,
  signal?: AbortSignal,
): Promise<{files: ImageFile[]; limitReached: boolean}> {
  const files: ImageFile[] = [];
  const seen = new Set<string>();
  let limitReached = false;

  for await (const match of glob(pattern, {
    cwd,
    ...(exclude.length > 0 ? {exclude} : {}),
  })) {
    throwIfAborted(signal);
    const absolutePath = resolve(cwd, match);
    if (seen.has(absolutePath)) continue;

    try {
      if (!(await stat(absolutePath)).isFile()) continue;
    } catch {
      // Keep inaccessible or transient matches so their error is reported.
    }

    if (files.length >= maxFiles) {
      limitReached = true;
      break;
    }
    seen.add(absolutePath);
    files.push({
      absolutePath,
      displayPath: displayPath(cwd, absolutePath),
    });
  }

  files.sort((left, right) =>
    left.displayPath.localeCompare(right.displayPath),
  );
  return {files, limitReached};
}

function makeGrid(
  width: number,
  height: number,
  request: ImageGridRequest,
): ImageGridDetails {
  const columns = Math.ceil(width / request.cellWidth);
  const rows = Math.ceil(height / request.cellHeight);
  if (columns * rows > MAX_GRID_CELLS) {
    throw new Error(
      `Grid would contain ${columns * rows} cells; the per-image limit is ${MAX_GRID_CELLS}. Increase cellWidth or cellHeight.`,
    );
  }

  const matchingPixels = Array.from({length: rows}, () =>
    Array<number>(columns).fill(0),
  );
  const totalPixels = Array.from({length: rows}, (_, row) =>
    Array.from({length: columns}, (_, column) => {
      const cellWidth = Math.min(
        request.cellWidth,
        width - column * request.cellWidth,
      );
      const cellHeight = Math.min(
        request.cellHeight,
        height - row * request.cellHeight,
      );
      return cellWidth * cellHeight;
    }),
  );

  return {
    ...request,
    columns,
    rows,
    matchingPixels,
    totalPixels,
  };
}

function inspectPixels(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  threshold: number,
  gridRequest?: ImageGridRequest,
): {alpha: AlphaDetails; grid?: ImageGridDetails} {
  if (channels < 2) {
    throw new Error(
      `Expected an alpha channel, but decoded ${channels} channel.`,
    );
  }

  const totalPixels = width * height;
  const expectedBytes = totalPixels * channels;
  if (data.byteLength < expectedBytes) {
    throw new Error(
      `Decoded pixel buffer is incomplete: expected ${expectedBytes} bytes, received ${data.byteLength}.`,
    );
  }

  const grid = gridRequest ? makeGrid(width, height, gridRequest) : undefined;
  const alphaOffset = channels - 1;
  let matchingPixels = 0;
  let transparentPixels = 0;
  let translucentPixels = 0;
  let opaquePixels = 0;
  let minimum = 255;
  let maximum = 0;
  let alphaSum = 0;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * channels + alphaOffset] ?? 0;
      alphaSum += alpha;
      minimum = Math.min(minimum, alpha);
      maximum = Math.max(maximum, alpha);

      if (alpha === 0) transparentPixels++;
      else if (alpha === 255) opaquePixels++;
      else translucentPixels++;

      if (alpha <= threshold) continue;
      matchingPixels++;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);

      if (grid) {
        const column = Math.floor(x / grid.cellWidth);
        const row = Math.floor(y / grid.cellHeight);
        grid.matchingPixels[row]![column]!++;
      }
    }
  }

  const bounds =
    matchingPixels === 0
      ? null
      : {
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
        };

  return {
    alpha: {
      threshold,
      matchingPixels,
      totalPixels,
      transparentPixels,
      translucentPixels,
      opaquePixels,
      minimum,
      maximum,
      mean: totalPixels > 0 ? alphaSum / totalPixels : 0,
      bounds,
    },
    ...(grid ? {grid} : {}),
  };
}

async function queryImageFile(
  file: ImageFile,
  threshold: number,
  gridRequest: ImageGridRequest | undefined,
  signal?: AbortSignal,
): Promise<ImageQueryFileDetails> {
  try {
    throwIfAborted(signal);
    const fileStats = await stat(file.absolutePath);
    if (!fileStats.isFile()) throw new Error('Path is not a file.');
    if (fileStats.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `File is ${formatSize(fileStats.size)}; the image_query per-file limit is ${formatSize(MAX_IMAGE_BYTES)}.`,
      );
    }

    // Read through Node first so AbortSignal can cancel file I/O. Sharp then decodes
    // from the bounded in-memory buffer without retaining a file descriptor.
    const input = await readFile(file.absolutePath, {signal});
    throwIfAborted(signal);
    const sharpOptions = {
      failOn: 'error' as const,
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    };
    const metadata = await sharp(input, sharpOptions).metadata();
    const decoded = await sharp(input, sharpOptions)
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});
    throwIfAborted(signal);

    const pixels = inspectPixels(
      decoded.data,
      decoded.info.width,
      decoded.info.height,
      decoded.info.channels,
      threshold,
      gridRequest,
    );

    return {
      path: file.displayPath,
      bytes: fileStats.size,
      format: metadata.format,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
      colourSpace: metadata.space,
      depth: metadata.depth,
      sourceHasAlpha: metadata.hasAlpha,
      pages: metadata.pages,
      ...pixels,
    };
  } catch (error) {
    throwIfAborted(signal);
    return {path: file.displayPath, error: describeError(error)};
  }
}

function percentage(count: number, total: number): string {
  if (total === 0) return '0%';
  return `${((count / total) * 100).toFixed(1)}%`;
}

function formatBounds(bounds: PixelBounds | null): string {
  if (!bounds) return '(none)';
  return `x=${bounds.x}, y=${bounds.y}, width=${bounds.width}, height=${bounds.height}`;
}

function formatGrid(grid: ImageGridDetails, threshold: number): string[] {
  const largestCount = Math.max(0, ...grid.matchingPixels.flat());
  const cellWidth = Math.max(1, String(largestCount).length);
  const lines = [
    `  grid alpha>${threshold} (${grid.rows}x${grid.columns} cells, ${grid.cellWidth}x${grid.cellHeight}px; row-major):`,
  ];
  for (const row of grid.matchingPixels) {
    lines.push(
      `    ${row.map(count => String(count).padStart(cellWidth)).join(' ')}`,
    );
  }
  return lines;
}

function formatImageQueryResult(details: ImageQueryToolDetails): string {
  const {summary} = details;
  const lines = [
    `Path: ${details.request.path}`,
    `Files: ${summary.filesProcessed} processed, ${summary.filesSucceeded} succeeded, ${summary.filesFailed} failed${summary.fileLimitReached ? ` (limit ${details.request.maxFiles} reached; more files matched)` : ''}`,
    `Alpha query: alpha > ${details.request.alphaThreshold}`,
    `Totals: ${summary.matchingPixels} of ${summary.totalPixels} pixels matched (${percentage(summary.matchingPixels, summary.totalPixels)})`,
  ];
  if (details.request.exclude?.length) {
    lines.push(`Excluded: ${details.request.exclude.join(', ')}`);
  }

  for (const file of details.files) {
    lines.push('', file.path);
    if (file.error) {
      lines.push(`  error: ${file.error}`);
      continue;
    }

    const alpha = file.alpha!;
    lines.push(
      `  image: ${file.width}x${file.height}, ${file.format ?? 'unknown format'}, ${file.channels} channels, ${formatSize(file.bytes ?? 0)}${file.pages && file.pages > 1 ? `, ${file.pages} pages (first page inspected)` : ''}`,
      `  alpha>${alpha.threshold}: ${alpha.matchingPixels}/${alpha.totalPixels} (${percentage(alpha.matchingPixels, alpha.totalPixels)})`,
      `  alpha classes: transparent=${alpha.transparentPixels}, translucent=${alpha.translucentPixels}, opaque=${alpha.opaquePixels}; range=${alpha.minimum}-${alpha.maximum}, mean=${alpha.mean.toFixed(1)}`,
      `  bounds: ${formatBounds(alpha.bounds)}`,
    );
    if (file.grid) lines.push(...formatGrid(file.grid, alpha.threshold));
  }

  return lines.join('\n');
}

async function truncateImageQueryOutput(
  output: string,
  details: ImageQueryToolDetails,
): Promise<string> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return output;

  const tempDir = await mkdtemp(join(tmpdir(), 'pi-image-query-'));
  const outputPath = join(tempDir, 'output.txt');
  await withFileMutationQueue(outputPath, async () => {
    await writeFile(outputPath, output, 'utf8');
  });
  details.truncation = truncation;
  details.fullOutputPath = outputPath;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

export function registerImageQueryTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof imageQuerySchema, ImageQueryToolDetails>({
    name: 'image_query',
    label: 'Image Query',
    description:
      'Inspect one or many local image files without writing an ad-hoc script. Reports dimensions, format, alpha-channel statistics, visible-pixel bounds, and optional fixed-size grid occupancy counts. Multi-page images inspect the first page. Output is truncated to 2000 lines or 50KB, with full output saved to a temporary file.',
    promptSnippet:
      'Inspect image metadata, alpha occupancy, visible bounds, and per-cell pixel counts across files and globs.',
    promptGuidelines: [
      'Use image_query instead of ad-hoc Python, Node, ImageMagick, or shell scripts when inspecting image dimensions, transparency, visible bounds, or per-region alpha occupancy.',
      'Use image_query path with a glob to inspect many images, exclude to omit unwanted paths, and grid with cellWidth/cellHeight for row-major per-cell counts.',
      'image_query counts pixels whose alpha is strictly greater than alphaThreshold; the default threshold 0 counts every non-fully-transparent pixel.',
      'If you notice unexpected or unfinished behavior when using image_query, report it to the user.',
    ],
    parameters: imageQuerySchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const pattern = normalizePattern(params.path, 'image_query path');
      const exclude = (params.exclude ?? []).map(item =>
        normalizePattern(item, 'image_query exclude pattern'),
      );
      const alphaThreshold = normalizeBoundedInteger(
        params.alphaThreshold,
        0,
        0,
        254,
      );
      const maxFiles = normalizeBoundedInteger(
        params.maxFiles,
        DEFAULT_MAX_FILES,
        1,
        MAX_FILES,
      );
      const grid = params.grid
        ? {
            cellWidth: normalizeBoundedInteger(
              params.grid.cellWidth,
              1,
              1,
              MAX_GRID_CELL_SIZE,
            ),
            cellHeight: normalizeBoundedInteger(
              params.grid.cellHeight,
              1,
              1,
              MAX_GRID_CELL_SIZE,
            ),
          }
        : undefined;
      const found = await findImageFiles(
        ctx.cwd,
        pattern,
        exclude,
        maxFiles,
        signal,
      );
      if (found.files.length === 0) {
        throw new Error(
          `No files matched image_query path ${JSON.stringify(pattern)} from ${ctx.cwd}.`,
        );
      }

      const files: ImageQueryFileDetails[] = [];
      for (const file of found.files) {
        files.push(await queryImageFile(file, alphaThreshold, grid, signal));
      }

      const succeededFiles = files.filter(file => !file.error);
      if (succeededFiles.length === 0) {
        const shownErrors = files
          .slice(0, 5)
          .map(file => `${file.path}: ${file.error}`)
          .join('; ');
        const omittedErrors = files.length - 5;
        throw new Error(
          `Could not inspect any matched image files. ${shownErrors}${omittedErrors > 0 ? `; and ${omittedErrors} more error(s)` : ''}`,
        );
      }

      const details: ImageQueryToolDetails = {
        request: {
          path: pattern,
          ...(exclude.length > 0 ? {exclude} : {}),
          alphaThreshold,
          ...(grid ? {grid} : {}),
          maxFiles,
        },
        summary: {
          filesProcessed: files.length,
          filesSucceeded: succeededFiles.length,
          filesFailed: files.length - succeededFiles.length,
          fileLimitReached: found.limitReached,
          totalPixels: succeededFiles.reduce(
            (total, file) => total + (file.alpha?.totalPixels ?? 0),
            0,
          ),
          matchingPixels: succeededFiles.reduce(
            (total, file) => total + (file.alpha?.matchingPixels ?? 0),
            0,
          ),
        },
        files,
      };
      const output = formatImageQueryResult(details);

      return {
        content: [
          {
            type: 'text',
            text: await truncateImageQueryOutput(output, details),
          },
        ],
        details,
      };
    },
  });
}
