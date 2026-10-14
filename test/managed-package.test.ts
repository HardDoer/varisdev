import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, access, cp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

void test(
  'production install builds and launches standalone and extension entry points without checkout dependencies',
  {timeout: 240_000},
  async t => {
    // Outside the checkout: Node and TypeScript cannot find its node_modules.
    const temporary = await mkdtemp(join(tmpdir(), 'varisdev-package-'));
    const prefix = join(temporary, 'installation');
    const directory = join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'varisdev',
    );
    t.after(() => rm(temporary, {recursive: true, force: true}));
    const npm =
      process.env.npm_execpath ||
      fileURLToPath(
        new URL('../node_modules/npm/bin/npm-cli.js', import.meta.url),
      );
    // Pack exactly the published files, then install globally into a temporary
    // prefix. This also checks that npm's inherited global setting cannot make
    // the nested runtime installer write to a global location.
    const packed = await run(
      process.execPath,
      [npm, 'pack', '--json', '--pack-destination', temporary],
      {cwd: root},
    );
    const [{filename, files}] = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: {path: string}[];
    }>;
    await run(
      process.execPath,
      [
        npm,
        'install',
        '--global',
        '--prefix',
        prefix,
        join(temporary, filename),
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: temporary,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );
    for (const name of Object.keys(manifest.dependencies))
      await access(join(directory, 'node_modules', name, 'package.json'));
    assert.match(
      JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'))
        .revision,
      /^[a-f0-9]{40}$/,
    );
    for (const name of Object.keys(manifest.peerDependencies)) {
      assert.equal(manifest.peerDependencies[name], '*');
      assert.equal(manifest.dependencies[name], undefined);
      await assert.rejects(access(join(directory, 'node_modules', name)), {
        code: 'ENOENT',
      });
      await access(join(directory, 'desktop/node_modules', name));
    }
    // The binary must already exist before any launch can trigger a download.
    const electronExecutable = await readFile(
      join(directory, 'node_modules/electron/path.txt'),
      'utf8',
    );
    await access(
      join(directory, 'node_modules/electron/dist', electronExecutable),
    );
    // postinstall must compile both entry points even when only production
    // dependencies are present and native TypeScript loading is unavailable.
    await access(join(directory, 'desktop/build/src/runtime/cli.js'));
    await access(join(directory, 'desktop/build/src/desktop/main.js'));
    for (const path of [
      'assets/dashboard/accounts.js',
      'assets/dashboard/accounts.css',
      'desktop/build/src/desktop/accounts.js',
      'desktop/build/src/tools/model-selection.js',
      'assets/dashboard/visualizations.js',
      'assets/dashboard/robot-whip.js',
      'examples/project-board/index.mjs',
      'docs/plugins.md',
    ])
      await access(join(directory, path));
    const version = await run(
      process.execPath,
      [join(directory, 'bin/varisdev.mjs'), '--version'],
      {cwd: directory},
    );
    assert.match(version.stdout, /^VarisDev /);
    // Exercise the entire session runtime import graph, even without a display.
    await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(pathToFileURL(join(directory, 'desktop/build/src/dashboard/parent.js')).href)}); await import('varisdev/visualizations');`,
      ],
      {cwd: directory},
    );
    const {RuntimeManager} = await import('../src/runtime/manager.ts');
    const updateData = join(temporary, 'updates');
    const repository = join(temporary, 'repository');
    const hooksDirectory = join(temporary, 'empty-hooks');
    await mkdir(hooksDirectory);
    const git = async (args: string[]) =>
      run('git', ['-c', `core.hooksPath=${hooksDirectory}`, ...args], {
        cwd: temporary,
      });
    await git(['init', repository]);
    for (const file of files) {
      await mkdir(dirname(join(repository, file.path)), {recursive: true});
      await cp(join(root, file.path), join(repository, file.path));
    }
    await git(['-C', repository, 'add', '.']);
    await git([
      '-C',
      repository,
      '-c',
      'user.name=VarisDev Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Application update fixture',
    ]);
    const manager = new RuntimeManager({
      installRoot: directory,
      dataDir: updateData,
      hooks: {
        run: async (command, args, options) => {
          const actualArgs =
            command === 'git'
              ? [
                  '-c',
                  `core.hooksPath=${hooksDirectory}`,
                  ...args.map(arg =>
                    [
                      'ssh://git@github.com/HardDoer/varisdev.git',
                      'https://github.com/HardDoer/varisdev.git',
                    ].includes(arg)
                      ? repository
                      : arg,
                  ),
                ]
              : args;
          const result = await run(command, actualArgs, {
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeoutMs,
            maxBuffer: 1024 * 1024,
          });
          return result.stdout;
        },
      },
    });
    const updated = await manager.update();
    assert.equal(updated.phase, 'ready', updated.error);
    const active = await manager.currentRoot();
    assert.notEqual(active, directory);
    for (const name of Object.keys(manifest.dependencies))
      await access(join(active, 'node_modules', name, 'package.json'));
    const updatedVersion = await run(
      process.execPath,
      [join(directory, 'bin/varisdev.mjs'), '--version'],
      {
        cwd: temporary,
        env: {...process.env, VARISDEV_DATA_DIR: updateData},
      },
    );
    assert.equal(updatedVersion.stdout.trim(), `VarisDev ${manifest.version}`);
    assert.equal(
      await new RuntimeManager({
        installRoot: directory,
        dataDir: updateData,
      }).currentRoot(),
      active,
    );
    const env = {
      ...process.env,
      PI_TEST_PACKAGE_DIR: active,
      VARISDEV_TEST_PACKAGE_DIR: active,
    };
    delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
    const result = await run(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        join(root, 'test/desktop-startup.test.ts'),
        join(root, 'test/standalone.test.ts'),
        join(root, 'test/desktop-accounts.test.ts'),
      ],
      {
        cwd: directory,
        env,
        maxBuffer: 1024 * 1024,
      },
    ).catch(error => {
      throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`);
    });
    assert.match(result.stdout, /# fail 0/);
  },
);
