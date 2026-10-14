import {execFileSync} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, URL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(join(root, '.git'))) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Could not determine the VarisDev revision.');
  let source;
  try {
    const remote = execFileSync(
      'git',
      ['config', '--get', 'remote.origin.url'],
      {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']},
    )
      .trim()
      .replace(/^git\+/, '');
    if (
      remote === 'git@github.com:HardDoer/varisdev.git' ||
      remote === 'ssh://git@github.com/HardDoer/varisdev.git'
    )
      source = 'ssh://git@github.com/HardDoer/varisdev.git';
    else if (remote === 'https://github.com/HardDoer/varisdev.git')
      source = remote;
  } catch {
    /* A checkout fetched directly by revision has no origin. */
  }
  writeFileSync(
    join(root, 'build-info.json'),
    JSON.stringify({revision, source}) + '\n',
  );
}
