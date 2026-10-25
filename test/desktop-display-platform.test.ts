import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';
import {parseDesktopArguments} from '../src/runtime/cli.ts';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

void test('desktop arguments retain defaults and accept a backend around the launch target', () => {
  assert.deepEqual(parseDesktopArguments([], 'linux'), {
    project: process.cwd(),
    ozonePlatform: undefined,
  });
  assert.deepEqual(parseDesktopArguments(['--overview'], 'win32'), {
    project: undefined,
    ozonePlatform: undefined,
  });
  assert.deepEqual(parseDesktopArguments(['--ozone-platform=x11'], 'linux'), {
    project: process.cwd(),
    ozonePlatform: 'x11',
  });
  for (const args of [
    ['--ozone-platform=x11', 'project'],
    ['project', '--ozone-platform=x11'],
  ]) {
    assert.deepEqual(parseDesktopArguments(args, 'linux'), {
      project: resolve('project'),
      ozonePlatform: 'x11',
    });
  }
  for (const args of [
    ['--ozone-platform=wayland', '--overview'],
    ['--overview', '--ozone-platform=wayland'],
  ]) {
    assert.deepEqual(parseDesktopArguments(args, 'linux'), {
      project: undefined,
      ozonePlatform: 'wayland',
    });
  }
});

void test('desktop arguments reject unsupported backend values, duplicates, platforms and extra flags', () => {
  for (const args of [
    ['--ozone-platform=auto'],
    ['--ozone-platform='],
    ['--ozone-platform', 'x11'],
  ]) {
    assert.throws(
      () => parseDesktopArguments(args, 'linux'),
      /Use --ozone-platform=x11 or --ozone-platform=wayland/,
    );
  }
  for (const second of ['x11', 'wayland']) {
    assert.throws(
      () =>
        parseDesktopArguments(
          ['--ozone-platform=x11', `--ozone-platform=${second}`],
          'linux',
        ),
      /only once/,
    );
  }
  for (const platform of ['win32', 'darwin'] as const) {
    assert.throws(
      () => parseDesktopArguments(['--ozone-platform=x11'], platform),
      /only supported on Linux/,
    );
  }
  for (const args of [
    ['--no-sandbox'],
    ['project', '--disable-gpu'],
    ['--overview', 'project'],
  ]) {
    assert.throws(
      () => parseDesktopArguments(args, 'linux'),
      /Usage: varisdev/,
    );
  }
});

void test('openDesktop supplies the chosen backend in the spawned Electron arguments', async t => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-display-platform-')),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  const electron = join(directory, 'node_modules/electron');
  const desktop = join(directory, 'desktop/build/src/desktop');
  const project = join(directory, 'project');
  const report = join(directory, 'arguments.json');
  await Promise.all(
    [electron, desktop, project].map(path => mkdir(path, {recursive: true})),
  );
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(electron, 'package.json'), '{"main":"index.cjs"}');
  await writeFile(
    join(electron, 'index.cjs'),
    `module.exports = ${JSON.stringify(process.execPath)};`,
  );
  const main = join(desktop, 'main.js');
  await writeFile(
    main,
    `
    import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(report)}, JSON.stringify({
      argv: process.argv.slice(1),
      cwd: process.cwd(),
    }));
    process.on('disconnect', () => process.exit(0));
    process.send({type: 'ready'});
  `,
  );
  for (const {args, backend, folder} of [
    {args: [project], backend: undefined, folder: project},
    {args: ['--ozone-platform=x11', project], backend: 'x11', folder: project},
    {
      args: ['--overview', '--ozone-platform=wayland'],
      backend: 'wayland',
      folder: undefined,
    },
  ]) {
    const source = `
      import {openDesktop, parseDesktopArguments} from ${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)};
      const {project, ozonePlatform} = parseDesktopArguments(${JSON.stringify(args)}, 'linux');
      await openDesktop(${JSON.stringify(directory)}, ${JSON.stringify(directory)}, project, ozonePlatform);
    `;
    await runRuntimeCommand(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        cwd: directory,
        env: {
          ...process.env,
          PIDEV_DESKTOP_DATA_DIR: join(directory, 'profile'),
          VARISDEV_DATA_DIR: join(directory, 'data'),
          VARISDEV_SETTINGS_DIR: join(directory, 'settings'),
          VARISDEV_RESTART_PID: '',
        },
        timeoutMs: 10000,
      },
    );
    assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), {
      argv: [
        main,
        ...(backend ? [`--ozone-platform=${backend}`] : []),
        '--varisdev-launcher',
        ...(folder ? [`--varisdev-project=${folder}`] : []),
      ],
      cwd: folder ?? directory,
    });
  }
});
