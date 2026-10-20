import {spawn} from 'node:child_process';
import {release} from 'node:os';
import {clearTimeout, setTimeout} from 'node:timers';
import {URL} from 'node:url';
import process from 'node:process';

/**
 * @typedef {{platform?: string, env?: NodeJS.ProcessEnv, kernel?: string}} BrowserHost
 * @typedef {BrowserHost & {run?: (command: string, args: string[]) => Promise<void>, fallback?: (url: string) => Promise<void>, timeoutMs?: number}} BrowserOptions
 */

/**
 * WSL can run with or without a Linux desktop and Windows PATH entries.
 * @param {BrowserHost} [options]
 */
export function isWSL({
  platform = process.platform,
  env = process.env,
  kernel = release(),
} = {}) {
  return (
    platform === 'linux' &&
    Boolean(
      env.WSL_INTEROP || env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(kernel),
    )
  );
}

/** @param {string} command @param {string[]} args @param {number} timeoutMs */
function runInteropLauncher(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The launcher may have exited while its timeout was being handled.
      }
      reject(new Error('Browser launcher timed out.'));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Browser launcher exited with status ${code}.`));
    });
  });
}

/** @param {string} command @param {string[]} args */
function startBrowser(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Open auth links in the Windows browser under WSL, retaining the host fallback.
 * @param {string} url
 * @param {BrowserOptions} [options]
 */
export async function openBrowser(url, options = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Browser links must use HTTP or HTTPS.');
  if (isWSL(options)) {
    const execute =
      options.run ??
      ((command, args) =>
        runInteropLauncher(command, args, options.timeoutMs ?? 10000));
    // Pass the entire URL as one argument; cmd.exe would reinterpret OAuth '&'s.
    for (const [command, args] of [
      ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
      [
        '/mnt/c/Windows/System32/rundll32.exe',
        ['url.dll,FileProtocolHandler', url],
      ],
      ['wslview', [url]],
    ]) {
      try {
        await execute(command, args);
        return;
      } catch {
        // Interop or a particular launcher may be unavailable in this distro.
      }
    }
  }
  if (options.fallback) return options.fallback(url);
  const execute = options.run ?? startBrowser;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') await execute('open', [url]);
  else if (platform === 'win32')
    await execute('rundll32', ['url.dll,FileProtocolHandler', url]);
  else await execute('xdg-open', [url]);
}
