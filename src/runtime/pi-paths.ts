import {getPackageDir} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Private SDK files belong to the Pi host that supplies extension imports. */
export function piModuleURL(path: string): URL {
  return pathToFileURL(join(getPackageDir(), 'dist', path));
}
