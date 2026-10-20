import {copyFile, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {URL} from 'node:url';

const marker = '// VarisDev: open WSL auth links in the Windows browser (v1).';

/** Keep Pi's auth dialogs and flows; adapt only their browser host. */
export function patchBrowser(source) {
  if (source.startsWith(marker)) return source;
  const signature = 'export function openBrowser(target) {';
  if (source.split(signature).length !== 2)
    throw new Error('Pi browser launcher changed; review the WSL adapter.');
  return `${marker}
import {isWSL, openBrowser as openWSLBrowser} from "./varisdev-browser.mjs";
${source.replace(
  signature,
  `${signature}
    if (isWSL() && /^https?:/i.test(target)) {
        void openWSLBrowser(target).catch(() => {});
        return;
    }`,
)}`;
}

export async function patchBundledBrowser(desktop) {
  const directory = join(
    desktop,
    'node_modules/@earendil-works/pi-coding-agent/dist/utils',
  );
  const path = join(directory, 'open-browser.js');
  const original = await readFile(path, 'utf8');
  const patched = patchBrowser(original);
  await copyFile(
    new URL('../src/runtime/browser.mjs', import.meta.url),
    join(directory, 'varisdev-browser.mjs'),
  );
  if (patched !== original) await writeFile(path, patched);
}
