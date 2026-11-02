/* global process, console */
import {readFile, readdir, readlink, realpath} from 'node:fs/promises';
import {basename, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Run /proc inspection in a separate, bounded process so a stalled read cannot
// leave startup waiting indefinitely. Only paths needed for cleanup are returned.
/** @param {string} [procDirectory] @param {(path: string) => Promise<string>} [readLink] */
export async function readLinuxRuntimeProcesses(
  procDirectory = '/proc',
  readLink = readlink,
) {
  if (procDirectory === '/proc') {
    const mounts = await readFile('/proc/mounts', 'utf8');
    if (/(?:^|,)hidepid=(?!0(?:,|\s))[^,\s]+/m.test(mounts))
      throw new Error('Process visibility is restricted.');
  }
  const rows = [];
  for (const name of await readdir(procDirectory)) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const directory = `${procDirectory}/${name}`;
      const status = await readFile(`${directory}/status`, 'utf8');
      if (/^State:\s+Z/m.test(status)) continue;
      const args = (await readFile(`${directory}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean);
      const host = /^(?:node(?:js)?|electron|varisdev|npm)(?:[.-]|$)/i.test(
        basename(args[0] || ''),
      );
      const paths = [...args];
      let cwd;
      for (const field of ['exe', 'cwd']) {
        try {
          const path = await readLink(`${directory}/${field}`);
          paths.push(path);
          if (field === 'cwd') cwd = path;
        } catch (error) {
          if (error.code === 'ENOENT') {
            // Kernel threads have no userspace executable or command line.
            if (!args.length) break;
            throw error;
          }
          if (host || !['EACCES', 'EPERM'].includes(error.code)) throw error;
        }
      }
      if (host) {
        for (let index = 0; index < args.length; index++) {
          const argument = args[index];
          if (
            argument.startsWith('-') ||
            argument.includes('://') ||
            ['--eval', '-e', '--print', '-p'].includes(args[index - 1])
          )
            continue;
          if (!isAbsolute(argument) && !cwd) continue;
          try {
            // /proc supplies exact argv tokens. Retain canonical path evidence
            // for process files, including paths reached through symlinks.
            paths.push(
              await realpath(
                isAbsolute(argument) ? argument : resolve(cwd, argument),
              ),
            );
          } catch (error) {
            if (
              !['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(
                error.code,
              )
            )
              throw error;
          }
        }
        const environment = (
          await readFile(`${directory}/environ`, 'utf8')
        ).split('\0');
        for (const value of environment) {
          if (/^(?:PATH|NODE_PATH|VARISDEV_INSTALL_ROOT)=/.test(value))
            paths.push(...value.slice(value.indexOf('=') + 1).split(':'));
        }
      }
      rows.push({pid: Number(name), paths, command: args.join('\0')});
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      // Inaccessible runtime processes must never look like exited processes.
      throw error;
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await readLinuxRuntimeProcesses()));
  } catch {
    process.exitCode = 1;
  }
}
