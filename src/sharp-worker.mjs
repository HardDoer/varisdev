// @ts-check
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

// A terminated parent must not leave a child holding the native library open.
process.once('disconnect', () => process.exit(1));

/** @param {import('./sharp.ts').ImageResponse} response */
function finish(response) {
  process.send?.(response, error => process.exit(error ? 1 : 0));
}

process.once(
  'message',
  /** @param {import('./sharp.ts').ImageRequest} request */
  async request => {
    try {
      /** @type {typeof import('sharp').default} */
      const sharp = require('sharp');
      const image = sharp(request.input, {
        failOn: 'error',
        limitInputPixels: request.limitInputPixels,
        sequentialRead: true,
      });
      const metadata = await image.metadata();
      if (request.output === 'metadata') {
        finish({metadata});
        return;
      }
      let pipeline = image.rotate();
      if (request.resize) {
        pipeline = pipeline.resize(
          request.resize.width,
          request.resize.height,
          {fit: 'inside', withoutEnlargement: true},
        );
      }
      pipeline =
        request.output === 'png'
          ? pipeline.png()
          : pipeline.toColourspace('srgb').ensureAlpha().raw();
      const decoded = await pipeline.toBuffer({resolveWithObject: true});
      finish({metadata, ...decoded});
    } catch (error) {
      finish({error: error instanceof Error ? error.message : String(error)});
    }
  },
);
