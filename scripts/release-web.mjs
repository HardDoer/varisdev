import {execFileSync} from 'node:child_process';
import console from 'node:console';
import {createHash} from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import process from 'node:process';
import {fileURLToPath, URL} from 'node:url';
import {releaseURL} from '../src/runtime/distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error('Usage: npm run release:web -- /path/to/output-directory');
  process.exit(1);
}
const destination = resolve(target);
const npm = join(root, 'node_modules/npm/bin/npm-cli.js');
function pack(args, cwd) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [npm, 'pack', '--ignore-scripts', '--json', ...args],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    ),
  )[0];
}
const temporary = await mkdtemp(join(root, '.web-release-'));
try {
  const staging = join(temporary, 'package');
  await mkdir(staging);
  const {files} = pack(['--dry-run'], root);
  const hash = createHash('sha1');
  for (const {path} of files.sort((a, b) => a.path.localeCompare(b.path))) {
    if (path === 'build-info.json') continue;
    const contents = await readFile(join(root, path));
    hash.update(path).update('\0').update(contents).update('\0');
    await mkdir(dirname(join(staging, path)), {recursive: true});
    await copyFile(join(root, path), join(staging, path));
  }
  // npm publishes shrinkwrap files and uses them to pin transitive dependencies.
  const lock = await readFile(join(root, 'package-lock.json'));
  hash.update('npm-shrinkwrap.json\0').update(lock).update('\0');
  await writeFile(join(staging, 'npm-shrinkwrap.json'), lock);
  // Identify the packaged content, including local edits and releases without
  // a version bump. This avoids treating a changed archive as already installed.
  const revision = hash.digest('hex');
  await writeFile(
    join(staging, 'build-info.json'),
    JSON.stringify({revision, source: releaseURL}) + '\n',
  );
  const {filename, version} = pack(['--pack-destination', temporary], staging);
  const archive = await readFile(join(temporary, filename));
  const name = `varisdev-${version}-${revision}.tgz`;
  await mkdir(destination, {recursive: true});
  await writeFile(join(destination, name), archive);
  await copyFile(
    join(root, 'src/runtime/distribution.mjs'),
    join(destination, 'install.mjs'),
  );
  await copyFile(
    join(root, 'scripts/install.sh'),
    join(destination, 'install.sh'),
  );
  await copyFile(
    join(root, 'scripts/install.ps1'),
    join(destination, 'install.ps1'),
  );
  await copyFile(
    join(root, 'scripts/install.cmd'),
    join(destination, 'install.cmd'),
  );
  const manifest = {
    version,
    revision,
    url: './download',
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
  await writeFile(
    join(destination, 'latest.json.tmp'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  await rename(
    join(destination, 'latest.json.tmp'),
    join(destination, 'latest.json'),
  );
  console.log(
    `Prepared local release files in ${destination}\n${name} (${archive.length} bytes)`,
  );
} finally {
  await rm(temporary, {recursive: true, force: true, maxRetries: 5});
}
