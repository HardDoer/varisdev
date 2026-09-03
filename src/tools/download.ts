import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {createWriteStream} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {dirname} from 'node:path';

const downloadSchema = Type.Object({
  url: Type.String({description: 'HTTP or HTTPS URL to download from.'}),
  path: Type.String({description: 'Local path where the downloaded file should be saved.'}),
});

export function registerDownloadTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof downloadSchema, {url: string; path: string}>({
    name: 'download',
    label: 'Download',
    description: 'Download a file from a URL and save it to a local path.',
    promptSnippet: 'Download files from URLs directly to the local file system.',
    promptGuidelines: [
      'Use download to save remote files, images, or archives to the local project directory.',
      'Ensure the destination path includes the correct file extension.',
    ],
    parameters: downloadSchema,
    async execute(_toolCallId, params, signal) {
      const {url, path} = params;

      const response = await fetch(url, {signal});
      if (!response.ok) {
        throw new Error(`Download failed with status ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const dir = dirname(path);
      await mkdir(dir, {recursive: true});

      const fileStream = createWriteStream(path);
      
      // response.body is a Web ReadableStream.
      // Readable.fromWeb converts it to a Node.js Readable stream.
      await pipeline(
        Readable.fromWeb(response.body as any),
        fileStream,
      );

      return {
        content: [{type: 'text', text: `Successfully downloaded ${url} to ${path}`}],
      };
    },
  });
}
