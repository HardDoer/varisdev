import {
  type ExtensionAPI,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import {Type} from 'typebox';

const downloadSchema = Type.Object({
  url: Type.String({description: 'HTTP or HTTPS URL to download from.'}),
  path: Type.String({
    description: 'Local path where the downloaded file should be saved.',
  }),
});

type DownloadToolDetails = {
  requestUrl: string;
  responseUrl: string;
  path: string;
  bytes: number;
  contentType?: string;
};

function normalizeHttpUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('download only supports http:// and https:// URLs.');
  }
  return url.toString();
}

function resolveDownloadPath(cwd: string, rawPath: string): string {
  const trimmedPath = rawPath.trim();
  const path = trimmedPath.startsWith('@') ? trimmedPath.slice(1) : trimmedPath;
  if (!path) throw new Error('download path cannot be empty.');
  return resolve(cwd, path);
}

export function registerDownloadTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof downloadSchema, DownloadToolDetails>({
    name: 'download',
    label: 'Download',
    description: 'Download a file from a URL and save it to a local path.',
    promptSnippet:
      'Download files from URLs directly to the local file system.',
    promptGuidelines: [
      'Use download to save remote files, images, or archives to the local project directory.',
      'Ensure the destination path includes the correct file extension.',
    ],
    parameters: downloadSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const requestUrl = normalizeHttpUrl(params.url);
      const outputPath = resolveDownloadPath(ctx.cwd, params.path);

      return withFileMutationQueue(outputPath, async () => {
        const response = await fetch(requestUrl, {signal});
        if (!response.ok) {
          throw new Error(
            `Download failed with status ${response.status}: ${response.statusText}`,
          );
        }
        if (!response.body) throw new Error('Response body is empty.');

        const outputDirectory = dirname(outputPath);
        await mkdir(outputDirectory, {recursive: true});
        const temporaryPath = join(
          outputDirectory,
          `.${basename(outputPath)}.${randomUUID()}.download`,
        );

        try {
          const source = Readable.fromWeb(
            response.body as unknown as NodeReadableStream,
          );
          const destination = createWriteStream(temporaryPath, {flags: 'wx'});
          await pipeline(source, destination, {signal});
          const fileStats = await stat(temporaryPath);
          await rename(temporaryPath, outputPath);

          const responseUrl = response.url || requestUrl;
          const contentType = response.headers.get('content-type') ?? undefined;
          return {
            content: [
              {
                type: 'text',
                text: `Successfully downloaded ${responseUrl} to ${outputPath}`,
              },
            ],
            details: {
              requestUrl,
              responseUrl,
              path: outputPath,
              bytes: fileStats.size,
              contentType,
            },
          };
        } finally {
          await rm(temporaryPath, {force: true}).catch(() => {});
        }
      });
    },
  });
}
