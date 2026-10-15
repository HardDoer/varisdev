import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Give the private Pi runtime its own project settings and resource directory. */
export async function configureBundledPi(desktop) {
  const path = join(
    desktop,
    'node_modules/@earendil-works/pi-coding-agent/package.json',
  );
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.piConfig = {
    ...manifest.piConfig,
    name: 'varisdev',
    configDir: '.varisdev',
  };
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
}
