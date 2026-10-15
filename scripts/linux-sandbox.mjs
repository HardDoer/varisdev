import {randomUUID} from 'node:crypto';
import {
  access,
  chmod,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import process from 'node:process';
import sandboxFix from 'electron-builder-sandbox-fix';

const marker = '# VarisDev electron-builder-sandbox-fix';

/** @param {string} executable */
export async function applyLinuxSandboxFix(
  executable,
  platform = process.platform,
) {
  if (platform !== 'linux') return;
  const file = await open(executable, 'r');
  let prefix;
  try {
    const {buffer, bytesRead} = await file.read({length: 512, position: 0});
    prefix = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const binary = `${executable}.bin`;
  if (prefix.includes(marker)) {
    await access(binary, constants.X_OK);
    return;
  }
  // A previous interrupted install may already have the upstream wrapper.
  if (
    prefix.startsWith('#!/usr/bin/env bash\n') &&
    prefix.includes('UNPRIVILEGED_USERNS_ENABLED=')
  ) {
    await access(binary, constants.X_OK);
  } else {
    await sandboxFix({
      electronPlatformName: platform,
      appOutDir: dirname(executable),
      packager: {
        executableName: basename(executable),
        appInfo: {productName: 'VarisDev'},
      },
    });
  }
  const loader = await readFile(executable, 'utf8');
  const optionalFlag = `"$([ "$APPLY_NO_SANDBOX_FLAG" == 1 ] && echo '--no-sandbox')"`;
  if (!loader.includes(optionalFlag))
    throw new Error('The Electron sandbox wrapper has an unexpected format.');
  // Upstream emits an empty argument when sandboxing is available. Electron's
  // development launcher treats that as an app path, so omit it entirely.
  // Append the flag to keep the application path at argv[1].
  const fixed = loader
    .replace('set -u', `${marker}\nset -u`)
    .replace(
      'exec "$SCRIPT_DIR/',
      'if [ "$APPLY_NO_SANDBOX_FLAG" == 1 ]; then\n\tset -- "$@" --no-sandbox\nfi\n\nexec "$SCRIPT_DIR/',
    )
    .replace(` ${optionalFlag}`, '');
  const temporary = join(dirname(executable), `.sandbox-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, fixed, {mode: 0o755});
    await chmod(temporary, 0o755);
    await rename(temporary, executable);
  } finally {
    await rm(temporary, {force: true});
  }
}
