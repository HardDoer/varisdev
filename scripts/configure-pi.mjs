import {readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath, URL} from 'node:url';
import process from 'node:process';
import {patchBundledOpenAIRegistration} from './patch-openai-registration.mjs';
import {patchBundledBrowser} from './patch-browser.mjs';

/** Give the private Pi runtime its own project settings and resource directory. */
export async function configureBundledPi(desktop) {
  await patchBundledOpenAIRegistration(desktop);
  await patchBundledBrowser(desktop);
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await configureBundledPi(
    fileURLToPath(new URL('../desktop/', import.meta.url)),
  );
}
