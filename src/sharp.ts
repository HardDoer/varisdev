import {createRequire} from 'node:module';
import type sharp from 'sharp';

const require = createRequire(import.meta.url);

/** Load Sharp's CommonJS entry through Node, outside Pi's extension loader. */
export function getSharp(): typeof sharp {
  // Defer native library loading until an image is used. A missing or broken
  // binary must not prevent the rest of the extension from starting.
  return require('sharp') as typeof sharp;
}
