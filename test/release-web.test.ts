import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {releaseURL} from '../src/runtime/distribution.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

void test('standalone release contains the verified package and installers and retains older archives', async t => {
  const output = await mkdtemp(join(tmpdir(), 'varisdev-release-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  const previous = `varisdev-0.0.1-${'0'.repeat(40)}.tgz`;
  await writeFile(join(output, previous), 'previous release');

  await run(process.execPath, ['scripts/release-web.mjs', output], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const manifest = JSON.parse(
    await readFile(join(output, 'latest.json'), 'utf8'),
  );
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  const archiveName = `varisdev-${manifest.version}-${manifest.revision}.tgz`;
  assert.equal(manifest.url, `./${archiveName}`);
  const archive = join(output, archiveName);
  assert.equal(
    manifest.sha256,
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  );
  assert.deepEqual(
    (await readdir(output)).sort(),
    [
      archiveName,
      previous,
      'latest.json',
      'install.mjs',
      'install.sh',
      'install.ps1',
      'install.cmd',
    ].sort(),
  );
  assert.equal(
    await readFile(join(output, previous), 'utf8'),
    'previous release',
  );

  const unpack = async (path: string) =>
    (
      await run('tar', ['-xOf', archive, `package/${path}`], {
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  assert.deepEqual(JSON.parse(await unpack('build-info.json')), {
    revision: manifest.revision,
    source: releaseURL,
  });
  assert.deepEqual(
    JSON.parse(await unpack('npm-shrinkwrap.json')),
    JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')),
  );
  assert.equal(JSON.parse(await unpack('package.json')).name, 'varisdev');
  const {stdout: entries} = await run('tar', ['-tzf', archive]);
  assert.doesNotMatch(entries, /(?:^|\/)node_modules\//m);
  for (const [published, source] of [
    ['install.mjs', 'src/runtime/distribution.mjs'],
    ['install.sh', 'scripts/install.sh'],
    ['install.ps1', 'scripts/install.ps1'],
    ['install.cmd', 'scripts/install.cmd'],
  ]) {
    assert.deepEqual(
      await readFile(join(output, published)),
      await readFile(join(root, source)),
    );
  }
});
