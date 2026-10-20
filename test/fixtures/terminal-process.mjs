import {spawn} from 'node:child_process';
import {join} from 'node:path';
import process from 'node:process';
import {clearTimeout, setTimeout} from 'node:timers';
import {fileURLToPath} from 'node:url';

/**
 * Keep terminal checks bounded, including Electron, ConPTY and shell children.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs: number, env?: NodeJS.ProcessEnv, cwd?: string}} options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runTerminalProcess(command, args, {timeoutMs, env, cwd}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => (stdout += chunk.toString()));
    child.stderr.on('data', chunk => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(
        `Terminal check timed out after ${timeoutMs} ms: ${command}\n`,
      );
      if (process.platform === 'win32' && child.pid) {
        // The restricted PATH used by the regression must not hide taskkill.
        const killer = spawn(
          join(
            process.env.SystemRoot || process.env.windir || 'C:\\Windows',
            'System32',
            'taskkill.exe',
          ),
          ['/PID', String(child.pid), '/T', '/F'],
          {windowsHide: true, stdio: 'ignore', timeout: 5000},
        );
        killer.on('error', error => {
          process.stderr.write(
            `Could not stop terminal process tree: ${error.message}\n`,
          );
          child.kill('SIGKILL');
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0)
        reject(
          new Error(
            `${timedOut ? 'Terminal check timed out' : `Terminal check exited ${code}`}\n${stdout}${stderr}`,
          ),
        );
      else resolve({stdout, stderr});
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTerminalProcess(process.execPath, process.argv.slice(3), {
    timeoutMs: Number(process.argv[2]),
  }).then(
    ({stdout, stderr}) => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    },
    error => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    },
  );
}
