import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

void test('development and private desktop Pi dependencies stay on the same release', async () => {
  const [development, desktop, developmentLock, desktopLock] =
    await Promise.all(
      [
        'package.json',
        'desktop/package.json',
        'package-lock.json',
        'desktop/package-lock.json',
      ].map(async path => JSON.parse(await readFile(join(root, path), 'utf8'))),
    );
  const release =
    developmentLock.packages['node_modules/@earendil-works/pi-coding-agent']
      .version;
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const dependency = `@earendil-works/${name}`;
    const key = `node_modules/${dependency}`;
    assert.equal(
      desktop.dependencies[dependency],
      development.devDependencies[dependency],
      `${dependency}: update both manifests together`,
    );
    assert.equal(developmentLock.packages[key].version, release, dependency);
    assert.equal(
      desktopLock.packages[key].version,
      release,
      `${dependency}: desktop must run the release verified by development tests`,
    );
  }
});

void test('desktop build reports TypeScript stdout diagnostics from the installed package', async t => {
  const tempRoot = join(root, '.pi/tmp');
  await mkdir(tempRoot, {recursive: true});
  const directory = await mkdtemp(join(tempRoot, 'desktop-build-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = join(directory, 'src/desktop/build.ts');
  await mkdir(join(directory, 'src/desktop'), {recursive: true});
  await cp(join(root, 'src/desktop/build.ts'), source);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(directory, 'tsconfig.desktop.json'),
    JSON.stringify({
      compilerOptions: {noEmit: true, types: []},
      files: ['broken.ts'],
    }),
  );
  await writeFile(join(directory, 'broken.ts'), 'const value: number = "bad";');
  const {buildDesktop} = (await import(pathToFileURL(source).href)) as {
    buildDesktop(): Promise<void>;
  };
  await assert.rejects(buildDesktop(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Desktop build failed:/);
    assert.match(error.message, /broken\.ts\(1,7\): error TS2322/);
    assert.match(
      error.message,
      /Type 'string' is not assignable to type 'number'/,
    );
    return true;
  });
});
