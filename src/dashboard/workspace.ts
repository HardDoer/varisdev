import {spawn} from 'node:child_process';
import {lstat, open} from 'node:fs/promises';
import {isAbsolute, relative, resolve} from 'node:path';

export interface WorkspaceDiff {
  cwd: string;
  git: boolean;
  files: Array<{path: string; status: string}>;
  diff: string;
  truncated: boolean;
}

const outputLimit = 200000;

function git(
  cwd: string,
  args: string[],
  limit = outputLimit,
): Promise<{code: number; text: string; truncated: boolean}> {
  return new Promise((yes, no) => {
    const child = spawn('git', ['--no-optional-locks', '-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      env: {...process.env, GIT_PAGER: 'cat'},
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = limit - size;
      chunks.push(chunk.subarray(0, Math.max(0, remaining)));
      size += chunk.length;
      if (size > limit) {
        truncated = true;
        child.kill();
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      no(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      yes({
        code: code ?? -1,
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
      });
    });
  });
}

export async function readWorkspaceDiff(cwd: string): Promise<WorkspaceDiff> {
  const result: WorkspaceDiff = {
    cwd,
    git: false,
    files: [],
    diff: '',
    truncated: false,
  };
  const root = await git(cwd, ['rev-parse', '--show-toplevel'], 8192);
  if (root.code !== 0) return result;
  result.git = true;
  const status = await git(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  if (status.code !== 0 && !status.truncated)
    throw new Error('Could not read workspace status.');
  const entries = status.text.split('\0');
  for (let index = 0; index < entries.length; index++) {
    const line = entries[index];
    if (line.length < 4) continue;
    const flags = line.slice(0, 2);
    result.files.push({path: line.slice(3), status: flags.trim()});
    if (/[RC]/.test(flags)) index++; // Porcelain -z also includes the source path.
  }
  result.truncated = status.truncated || result.files.length > 200;
  result.files = result.files.slice(0, 200);
  const args = [
    '--no-pager',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
  ];
  let diff = await git(cwd, [...args, 'HEAD', '--', '.']);
  if (diff.code !== 0 && !diff.truncated) {
    // A new repository has no HEAD; staged and working changes are still useful.
    const staged = await git(cwd, [...args, '--cached', '--', '.']);
    const working = await git(cwd, [...args, '--', '.']);
    if (staged.code !== 0 || working.code !== 0)
      throw new Error('Could not read workspace diff.');
    diff = {
      code: 0,
      text: staged.text + working.text,
      truncated: staged.truncated || working.truncated,
    };
  }
  let output = diff.text;
  result.truncated ||= diff.truncated;
  for (const file of result.files.filter(file => file.status === '??')) {
    if (output.length >= outputLimit) {
      result.truncated = true;
      break;
    }
    const path = resolve(root.text.trim(), file.path);
    const local = relative(root.text.trim(), path);
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('../') ||
      local.startsWith('..\\')
    )
      continue;
    output += `\n--- /dev/null\n+++ ${file.path}\n`;
    try {
      // Do not follow an untracked symlink to files outside the workspace.
      if (!(await lstat(path)).isFile()) {
        output += '[Untracked symlink or non-regular file]\n';
        continue;
      }
      const handle = await open(path, 'r');
      try {
        const bytes = Buffer.alloc(8193);
        const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
        if (bytes.subarray(0, bytesRead).includes(0))
          output += '[Binary file]\n';
        else {
          const content = bytes
            .subarray(0, Math.min(8192, bytesRead))
            .toString('utf8');
          output +=
            content
              .split('\n')
              .map(line => `+${line}`)
              .join('\n') + '\n';
        }
        if (bytesRead > 8192) {
          output += '[File preview truncated]\n';
          result.truncated = true;
        }
      } finally {
        await handle.close();
      }
    } catch {
      output += '[File changed or could not be read]\n';
    }
  }
  result.truncated ||= output.length > outputLimit;
  result.diff = output.slice(0, outputLimit);
  return result;
}
