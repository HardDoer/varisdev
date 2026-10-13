import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

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
