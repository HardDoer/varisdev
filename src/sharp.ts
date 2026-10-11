import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Metadata, OutputInfo} from 'sharp';

export type ImageRequest = {
  input: Buffer;
  output: 'metadata' | 'raw' | 'png';
  limitInputPixels: number;
  resize?: {width: number; height: number};
};

type ImageMetadata = {metadata: Metadata};
type DecodedImage = ImageMetadata & {data: Buffer; info: OutputInfo};
export type ImageResponse = ImageMetadata | DecodedImage | {error: string};

export function processImage(
  request: ImageRequest & {output: 'metadata'},
  signal?: AbortSignal,
): Promise<ImageMetadata>;
export function processImage(
  request: ImageRequest & {output: 'raw' | 'png'},
  signal?: AbortSignal,
): Promise<DecodedImage>;
/**
 * Sharp must never load in Pi's process: Windows locks its DLLs until exit,
 * preventing Pi's package updater from removing node_modules. Wait for the
 * child to close before returning, including on errors and cancellation.
 */
export function processImage(
  request: ImageRequest,
  signal?: AbortSignal,
): Promise<ImageMetadata> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./sharp-worker.mjs', import.meta.url))],
      {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    let response: ImageResponse | undefined;
    let failure: {reason: unknown} | undefined;
    let stderr = '';
    const stop = (error: unknown) => {
      failure ??= {reason: error};
      child.kill('SIGKILL');
    };
    const abort = () => stop(signal?.reason);
    const timeout = setTimeout(
      () => stop(new Error('Image processing timed out after 60 seconds.')),
      60_000,
    );
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once('message', (message: ImageResponse) => {
      response = message;
    });
    child.on('error', stop);
    child.once('close', (code, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure.reason);
      else if (response && 'error' in response)
        reject(new Error(response.error));
      else if (code !== 0 || !response)
        reject(
          new Error(
            `Image process exited (${exitSignal ?? code})${stderr ? `: ${stderr.trim()}` : '.'}`,
          ),
        );
      else resolve(response);
    });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    else
      child.send(request, error => {
        if (error) stop(error);
      });
  });
}
