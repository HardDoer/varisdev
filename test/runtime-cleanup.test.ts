import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs, {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {pathToFileURL} from 'node:url';
import {
  cleanupRuntimeGenerations,
  containsRuntimePath,
  macRuntimeProcesses,
  runtimeProcesses,
  type RuntimeProcess,
} from '../src/runtime/cleanup.ts';
import {RuntimeManager} from '../src/runtime/manager.ts';
import {readLinuxRuntimeProcesses} from '../src/runtime/process-probe.mjs';

async function put(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, contents);
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function fixture(t: TestContext) {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), 'varisdev-cleanup-')),
  );
  t.after(() => rm(temp, {recursive: true, force: true}));
  const installRoot = join(temp, 'install');
  const dataDir = join(temp, 'data');
  await put(
    join(installRoot, 'package.json'),
    '{"name":"varisdev","version":"1.0.0","type":"module"}',
  );
  const processes = async (): Promise<RuntimeProcess[]> => [
    {pid: process.pid, paths: [process.execPath], command: ''},
  ];
  const options = {installRoot, dataDir, processes};
  const generation = async (number: number, extra: object = {}) => {
    const name = `app-${number.toString(16).padStart(16, '0')}`;
    const root = join(dataDir, 'runtimes', name);
    const owner = {
      generation: name,
      baseRoot: installRoot,
      fingerprint: 'a'.repeat(64),
      version: '1.0.0',
      revision: 'b'.repeat(40),
      platform: process.platform,
      ...extra,
    };
    await put(join(root, 'runtime.json'), JSON.stringify(owner));
    await put(
      join(root, 'partial-download'),
      'incomplete or installed contents',
    );
    return {name, root, owner};
  };
  return {temp, installRoot, dataDir, options, generation};
}

void test('cleanup removes obsolete and incomplete owned generations, preserving the pointer regardless of its fingerprint', async t => {
  const f = await fixture(t);
  const active = await f.generation(1);
  const old = await f.generation(2);
  const incomplete = await f.generation(3);
  await put(
    join(f.dataDir, 'active.json'),
    JSON.stringify({...active.owner, fingerprint: 'invalid'}),
  );
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(active.root), true);
  assert.equal(await exists(old.root), false);
  assert.equal(await exists(incomplete.root), false);
});

void test('unknown ownership, other installations, foreign platforms and recovery stages are retained', async t => {
  const f = await fixture(t);
  const foreign = await f.generation(1, {
    baseRoot: join(f.temp, 'other-install'),
  });
  const malformed = await f.generation(2, {generation: '../foreign'});
  const wrongFingerprint = await f.generation(3, {fingerprint: 'unknown'});
  const wrongPlatform = await f.generation(4, {
    platform: process.platform === 'win32' ? 'linux' : 'win32',
  });
  const recovery = await f.generation(5);
  await put(join(recovery.root, 'recovery.json'), '{}');
  const unmarked = join(f.dataDir, 'runtimes', 'app-0000000000000006');
  await put(join(unmarked, 'download'), 'old updater stage');
  const unknown = join(f.dataDir, 'runtimes', 'user-files');
  await put(join(unknown, 'keep'), 'foreign data');
  await cleanupRuntimeGenerations(f.options);
  for (const root of [
    foreign.root,
    malformed.root,
    wrongFingerprint.root,
    wrongPlatform.root,
    recovery.root,
    unmarked,
    unknown,
  ])
    assert.equal(await exists(root), true, root);
});

for (const generation of ['runtime-0.86.0-12345678', 'app-0000000000000001']) {
  void test(`legacy ${generation} ownership recognizes the installed root Electron layout`, async t => {
    const f = await fixture(t);
    const legacy = join(f.dataDir, 'runtimes', generation);
    const owner = {
      generation,
      baseRoot: f.installRoot,
      fingerprint: 'a'.repeat(64),
      version: '0.86.0',
    };
    await put(join(legacy, 'runtime.json'), JSON.stringify(owner));
    await cleanupRuntimeGenerations(f.options);
    assert.equal(await exists(legacy), true);
    const binary =
      process.platform === 'win32'
        ? 'electron.exe'
        : process.platform === 'darwin'
          ? 'Electron.app/Contents/MacOS/Electron'
          : 'electron';
    const root = generation.startsWith('app-')
      ? join(
          legacy,
          process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
          'varisdev',
        )
      : legacy;
    await put(join(root, 'node_modules/electron/dist', binary), 'executable');
    await cleanupRuntimeGenerations(f.options);
    assert.equal(await exists(legacy), false);
  });
}

void test('shipped legacy dependency links are recognized only when they target the owning base installation', async t => {
  const f = await fixture(t);
  const binary =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  const baseBinary = join(f.installRoot, 'node_modules/electron/dist', binary);
  await put(baseBinary, 'base executable');
  for (const trusted of [true, false]) {
    const generation = trusted
      ? 'runtime-0.86.0-12345678'
      : 'runtime-0.86.0-abcdef12';
    const root = join(f.dataDir, 'runtimes', generation);
    await put(
      join(root, 'runtime.json'),
      JSON.stringify({
        generation,
        baseRoot: f.installRoot,
        fingerprint: 'a'.repeat(64),
        version: '0.86.0',
      }),
    );
    await put(
      join(
        root,
        'desktop/node_modules/@earendil-works/pi-coding-agent/package.json',
      ),
      '{"version":"0.86.0"}',
    );
    const target = trusted
      ? join(f.installRoot, 'node_modules')
      : join(f.temp, 'foreign/node_modules');
    await put(join(target, 'electron/dist', binary), 'dependency executable');
    await symlink(
      target,
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await cleanupRuntimeGenerations(f.options);
    assert.equal(await exists(root), !trusted);
    assert.equal(
      await readFile(join(target, 'electron/dist', binary), 'utf8'),
      'dependency executable',
    );
  }
});

for (const generation of ['runtime-0.86.0-12345678', 'app-0000000000000001']) {
  void test(`legacy ${generation} retains platform proof across partial deletion and retry`, async t => {
    const f = await fixture(t);
    const root = join(f.dataDir, 'runtimes', generation);
    await put(
      join(root, 'runtime.json'),
      JSON.stringify({
        generation,
        baseRoot: f.installRoot,
        fingerprint: 'a'.repeat(64),
        version: '0.86.0',
      }),
    );
    const binary =
      process.platform === 'win32'
        ? 'electron.exe'
        : process.platform === 'darwin'
          ? 'Electron.app/Contents/MacOS/Electron'
          : 'electron';
    let dependencies: string;
    if (generation.startsWith('runtime-')) {
      await put(
        join(f.installRoot, 'node_modules/electron/dist', binary),
        'shared executable',
      );
      dependencies = join(root, 'node_modules');
      await symlink(
        join(f.installRoot, 'node_modules'),
        dependencies,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } else {
      dependencies = join(
        root,
        process.platform === 'win32' ? 'node_modules' : 'lib',
      );
      const appRoot = join(
        root,
        process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
        'varisdev',
      );
      await put(
        join(appRoot, 'node_modules/electron/dist', binary),
        'generation executable',
      );
    }
    const locked = join(root, 'z-locked');
    await put(locked, 'temporary deletion failure');
    const remove = fs.rm;
    const mocked = t.mock.method(
      fs,
      'rm',
      async (...args: Parameters<typeof remove>) => {
        if (String(args[0]) === locked)
          throw Object.assign(new Error('Locked file'), {code: 'EPERM'});
        return remove(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await cleanupRuntimeGenerations(f.options);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(await exists(dependencies), false);
    assert.equal(
      JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')).platform,
      process.platform,
    );
    await cleanupRuntimeGenerations(f.options);
    assert.equal(await exists(root), false);
    if (generation.startsWith('runtime-'))
      assert.equal(
        await readFile(
          join(f.installRoot, 'node_modules/electron/dist', binary),
          'utf8',
        ),
        'shared executable',
      );
  });
}

void test('legacy cleanup preserves contents when recording inferred platform fails', async t => {
  const f = await fixture(t);
  const old = await f.generation(1, {platform: undefined});
  const binary =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  const appRoot = join(
    old.root,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    'varisdev',
  );
  const executable = join(appRoot, 'node_modules/electron/dist', binary);
  await put(executable, 'platform evidence');
  const original = await readFile(join(old.root, 'runtime.json'), 'utf8');
  const mocked = t.mock.method(fs, 'rename', async () => {
    throw Object.assign(new Error('Metadata is locked'), {code: 'EPERM'});
  });
  syncBuiltinESMExports();
  try {
    await cleanupRuntimeGenerations(f.options);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(
    await readFile(join(old.root, 'runtime.json'), 'utf8'),
    original,
  );
  assert.equal(await readFile(executable, 'utf8'), 'platform evidence');
  assert.equal(await exists(join(old.root, 'partial-download')), true);
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), false);
});

void test('live old runtimes and explicit running roots survive until their users exit', async t => {
  const f = await fixture(t);
  const running = await f.generation(1);
  const other = await f.generation(2);
  const stale = await f.generation(3);
  await cleanupRuntimeGenerations({
    ...f.options,
    runningRoot: join(running.root, 'lib/node_modules/varisdev'),
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [
          join(other.root, 'desktop/node_modules/electron/dist/electron'),
        ],
        command: '',
      },
    ],
  });
  assert.equal(await exists(running.root), true);
  assert.equal(await exists(other.root), true);
  assert.equal(await exists(stale.root), false);
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(running.root), false);
  assert.equal(await exists(other.root), false);
});

void test('Darwin relative bootstrap evidence defers cleanup despite unrelated runtime-directory arguments', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const pid = process.pid + 1;
  for (const command of [
    'node bin/varisdev.mjs',
    'node bin/varisdev.mjs Helper/project',
    'node "./bin/varisdev.mjs"',
    'node .bin/varisdev',
    'node .bin/varisdev Helper/project',
    "Electron '../package/bin/varisdev.mjs'",
    'VarisDev varisdev.mjs',
  ]) {
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () =>
        macRuntimeProcesses(
          `${pid} /usr/bin/node`,
          `${pid} ${command} --runtime-dir ${join(f.dataDir, 'runtimes')}`,
        ),
    });
    assert.equal(await exists(old.root), true, command);
  }
  const foreign = join(f.temp, 'foreign install/bin/varisdev.mjs');
  await put(foreign, 'export const foreign = true;');
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(
        `${pid} /usr/bin/node`,
        `${pid} node "${pathToFileURL(foreign).href}"`,
      ),
  });
  assert.equal(await exists(old.root), true);
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(
        `${pid} /usr/bin/node`,
        `${pid} node /foreign/server.mjs`,
      ),
  });
  assert.equal(await exists(old.root), false);
});

void test(
  'Windows VarisDev bootstrap paths defer cleanup regardless of their current target',
  {skip: process.platform !== 'win32'},
  async t => {
    const f = await fixture(t);
    const old = await f.generation(1);
    const executable = 'C:\\Program Files\\nodejs\\node.exe';
    for (const script of [
      'bin/varisdev.mjs',
      '.\\bin\\varisdev.mjs',
      'folder with spaces\\bin\\varisdev.mjs',
      'C:bin\\varisdev.mjs',
      'C:varisdev.mjs',
      '\\bin\\varisdev.mjs',
      '/bin/varisdev.mjs',
    ]) {
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: async () => [
          {
            pid: process.pid + 1,
            paths: [executable],
            command: `"${executable}" "${script}" --runtime-dir "${join(f.dataDir, 'runtimes')}"`,
          },
        ],
      });
      assert.equal(await exists(old.root), true, script);
    }
    const missing = join(f.temp, 'removed-alias/bin/varisdev.mjs');
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => [
        {
          pid: process.pid + 1,
          paths: [executable],
          command: `"${executable}" "${missing}"`,
        },
      ],
    });
    assert.equal(await exists(old.root), true);
    const foreign = join(f.temp, 'Foreign Install/bin/varisdev.mjs');
    await put(foreign, 'export const foreign = true;');
    for (const script of [foreign]) {
      const unused = await f.generation(2);
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: async () => [
          {
            pid: process.pid + 1,
            paths: [executable],
            command: `"${executable}" "${script}"`,
          },
        ],
      });
      assert.equal(await exists(unused.root), true, script);
    }
    assert.equal(await exists(old.root), true);
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => [
        {
          pid: process.pid + 1,
          paths: [executable],
          command: `"${executable}" "C:\\Foreign Install\\server.mjs"`,
        },
      ],
    });
    assert.equal(await exists(old.root), false);
  },
);

void test('generation CLI bootstraps defer cleanup for every possibly loaded generation', async t => {
  const f = await fixture(t);
  const running = await f.generation(1);
  const unused = await f.generation(2);
  await put(
    join(running.root, 'bin/varisdev.mjs'),
    'export const running = true;',
  );
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [process.execPath],
        command: `"${process.execPath}" "${join(running.root, 'bin/varisdev.mjs')}" --runtime-dir "${join(f.dataDir, 'runtimes')}"`,
      },
    ],
  });
  assert.equal(await exists(running.root), true);
  assert.equal(await exists(unused.root), true);
});

void test('Darwin VIS bootstrap aliases defer cleanup for every possibly loaded generation', async t => {
  const f = await fixture(t);
  const first = await f.generation(1);
  const second = await f.generation(2);
  const unused = await f.generation(3);
  const parent = join(f.temp, 'literal-M-CM-$');
  await mkdir(parent);
  for (const [name, root] of [
    ['stage-ä', first.root],
    ['stage-M-CM-$', second.root],
  ]) {
    await put(join(root, 'bin/varisdev.mjs'), 'export const active = true;');
    await symlink(
      root,
      join(parent, name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const script = join(parent, 'stage-M-CM-$/bin/varisdev.mjs').replaceAll(
    '\\',
    '/',
  );
  const pid = process.pid + 1;
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(
        `${pid} /usr/bin/node`,
        `${pid} node "${script}" --runtime-dir "${join(f.dataDir, 'runtimes')}"`,
      ),
  });
  assert.equal(await exists(first.root), true);
  assert.equal(await exists(second.root), true);
  assert.equal(await exists(unused.root), true);
});

void test('Darwin VIS aliases to the base defer cleanup even after their target disappears', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const unused = await f.generation(2);
  await put(
    join(f.installRoot, 'bin/varisdev.mjs'),
    'export const bootstrap = true;',
  );
  const alias = join(f.temp, 'base-ä');
  await symlink(
    f.installRoot,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const script = join(alias, 'bin/varisdev.mjs')
    .replaceAll('\\', '/')
    .replaceAll('ä', 'M-CM-$');
  const pid = process.pid + 1;
  const processes = async () =>
    macRuntimeProcesses(
      `${pid} /usr/bin/node`,
      `${pid} node "${script}" --runtime-dir "${join(f.dataDir, 'runtimes')}"`,
    );
  await cleanupRuntimeGenerations({...f.options, processes});
  assert.equal(await exists(old.root), true);
  assert.equal(await exists(unused.root), true);
  await rm(alias, {recursive: true, force: true});
  await cleanupRuntimeGenerations({...f.options, processes});
  assert.equal(await exists(old.root), true);
});

void test('macOS process snapshots reclaim obsolete copies when ps exits and retain surviving and new runtime users', async t => {
  const f = await fixture(t);
  const running = await f.generation(1);
  const launched = await f.generation(2);
  const unused = await f.generation(3);
  const executable = join(running.root, 'Electron.app/Contents/MacOS/Electron');
  await mkdir(dirname(executable), {recursive: true});
  const pid = process.pid + 1;
  const processes = macRuntimeProcesses(
    ` ${pid} ${executable}\n ${pid + 1} /bin/ps\n`,
    ` ${pid} Electron\n ${pid + 2} node "${join(launched.root, 'session.js')}"\n ${pid + 3} /bin/ps -Aww -o pid=,args=\n`,
  );
  assert.deepEqual(
    processes.map(row => row.pid),
    [pid, pid + 2, pid + 3],
  );
  assert.deepEqual(processes[0].paths, [executable]);
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => processes,
  });
  assert.equal(await exists(running.root), true);
  assert.equal(await exists(launched.root), true);
  assert.equal(await exists(unused.root), false);
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(
        ` ${pid + 4} /bin/ps\n`,
        ` ${pid + 5} /bin/ps -Aww -o pid=,args=\n`,
      ),
  });
  assert.equal(await exists(running.root), false);
  assert.equal(await exists(launched.root), false);
});

for (const name of ['data-ä', 'literal-M-CM-$/data-ä']) {
  void test(`Darwin escaped paths protect live runtimes under ${name}`, async t => {
    const f = await fixture(t);
    const running = await f.generation(1);
    const unused = await f.generation(2);
    const dataDir = join(f.temp, name);
    await mkdir(dirname(dataDir), {recursive: true});
    await fs.rename(f.dataDir, dataDir);
    const root = join(dataDir, 'runtimes', running.name);
    const stale = join(dataDir, 'runtimes', unused.name);
    const pid = process.pid + 1;
    const encoded = root.replaceAll('ä', 'M-CM-$');
    const processes = macRuntimeProcesses(
      `${pid} node`,
      `${pid} node ${encoded}/session.js`,
    );
    await cleanupRuntimeGenerations({
      ...f.options,
      dataDir,
      processes: async () => processes,
    });
    assert.equal(await exists(root), true);
    assert.equal(await exists(stale), false);
    await cleanupRuntimeGenerations({...f.options, dataDir});
    assert.equal(await exists(root), false);
  });
}

void test('Darwin path matching handles control bytes and mixed literal escape-like names without decoding', () => {
  const generation = 'app-0123456789abcdef';
  const root = `/literal-M-CM-$/data-ä-\t\n\u0001\u007f\u00a0/runtimes/${generation}`;
  const output = `node /literal-M-CM-$/data-M-CM-$-\\011\\012^A^?M-B\\240/runtimes/${generation}/session.js`;
  assert.equal(containsRuntimePath(output, root, 'darwin', 'darwin-vis'), true);
  assert.equal(containsRuntimePath(output, root, 'darwin'), false);
  assert.equal(
    containsRuntimePath(
      `${output.replace(generation, generation + '0')}`,
      root,
      'darwin',
      'darwin-vis',
    ),
    false,
  );
});

void test('Darwin runtime-host fallbacks defer cleanup for new and partially observed processes', async t => {
  const f = await fixture(t);
  const running = await f.generation(1);
  const pid = process.pid + 1;
  const snapshots = [
    ['(node)', '(node)'],
    ['', '(node)'],
    ['/usr/bin/node', '(systemdaemon)'],
    ['(node)', 'node /outside/server.js'],
    ['/Applications/Electron.app/Contents/MacOS/Electron', '(Electron)'],
    ['', '(varisdev)'],
  ];
  for (const [executable, command] of snapshots) {
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () =>
        macRuntimeProcesses(
          executable ? `${pid} ${executable}` : '',
          `${pid} ${command}`,
        ),
    });
    assert.equal(await exists(running.root), true, `${executable}; ${command}`);
  }
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(`${pid} (systemdaemon)`, `${pid} (systemdaemon)`),
  });
  assert.equal(await exists(running.root), false);
});

void test('Darwin proven helper identities allow cleanup and ambiguous commands defer', async t => {
  const f = await fixture(t);
  const pid = process.pid + 1;
  const snapshots = [
    ['(Electron Helper)', '(Electron Helper)', false],
    ['/usr/bin/node', 'node /foreign/VarisDev Helper/session.js', true],
    ['', '/foreign/VarisDev Helper --type=renderer', true],
  ] as const;
  for (const [executable, command, retain] of snapshots) {
    const old = await f.generation(1);
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () =>
        macRuntimeProcesses(
          executable ? `${pid} ${executable}` : '',
          `${pid} ${command}`,
        ),
    });
    assert.equal(await exists(old.root), retain, command);
  }
});

void test('new Darwin command-only main and CLI evidence defers cleanup despite spaces, VIS and Helper arguments', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const pid = process.pid + 1;
  for (const command of [
    '/Applications/Copied VarisDev.app/Contents/MacOS/VarisDev',
    '/Applications/M-CM-$/Copy With Spaces.app/Contents/MacOS/VarisDev',
    '/Applications/Dev Tools/node bin/varisdev.mjs',
    '/Applications/Dev Tools/node .bin/varisdev',
  ]) {
    const rows = macRuntimeProcesses('', `${pid} ${command} Helper/project`);
    assert.deepEqual(rows[0].paths, []);
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => rows,
    });
    assert.equal(await exists(old.root), true, command);
  }
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses('', `${pid} /bin/ps -Aww -o pid=,args=`),
  });
  assert.equal(await exists(old.root), false);
});

void test('Windows helper roles using VarisDev.exe allow cleanup', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const executable = 'C:\\Applications\\VarisDev.exe';
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [executable],
        command: `"${executable}" --type=renderer Helper/project`,
      },
    ],
  });
  assert.equal(await exists(old.root), false);
});

void test('Darwin defunct rows release runtimes even when the executable snapshot preceded exit', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const pid = process.pid + 1;
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(
        `${pid} ${join(old.root, 'node')}`,
        `${pid} <defunct>`,
      ),
  });
  assert.equal(await exists(old.root), false);
});

void test('the manager protects its own loaded generation without runningRoot or generation argv', async t => {
  const f = await fixture(t);
  const loaded = await f.generation(1);
  const unused = await f.generation(2);
  for (const name of [
    'manager.ts',
    'cleanup.ts',
    'mac-launcher.ts',
    'environment.mjs',
    'distribution.mjs',
    'process-probe.mjs',
  ])
    await copyFile(
      new URL(`../src/runtime/${name}`, import.meta.url),
      join(loaded.root, name),
    );
  const module = await import(
    pathToFileURL(join(loaded.root, 'manager.ts')).href
  );
  await new module.RuntimeManager({
    installRoot: f.installRoot,
    dataDir: f.dataDir,
    hooks: {processes: f.options.processes},
  }).cleanupRuntimes();
  assert.equal(await exists(loaded.root), true);
  assert.equal(await exists(unused.root), false);
});

void test('legacy bootstrap and direct base importers without generation evidence defer all pruning', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  for (const command of [
    join(f.installRoot, 'bin/varisdev.mjs'),
    `node --eval import(${JSON.stringify(join(f.installRoot, 'desktop/build/src/runtime/cli.js'))})`,
  ]) {
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => [{pid: process.pid + 1, paths: [], command}],
    });
    assert.equal(await exists(old.root), true);
  }
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), false);
});

void test('a copied live macOS launcher retains generations even after launch.json changes', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const latest = await f.generation(2);
  const bundle = join(f.temp, 'Copied VarisDev.app');
  await put(
    join(bundle, 'Contents/Resources/app/launch.json'),
    JSON.stringify({installRoot: f.installRoot, runtimeRoot: latest.root}),
  );
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [join(bundle, 'Contents/MacOS/VarisDev')],
        command: '',
      },
    ],
  });
  assert.equal(await exists(old.root), true);
  assert.equal(await exists(latest.root), true);
  for (const config of [
    {installRoot: '/foreign-install', runtimeRoot: '/foreign-runtime'},
    {runtimeRoot: '/another-runtime'},
  ]) {
    await put(
      join(bundle, 'Contents/Resources/app/launch.json'),
      JSON.stringify(config),
    );
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => [
        {
          pid: process.pid + 1,
          paths: [join(bundle, 'Contents/MacOS/VarisDev')],
          command: '',
        },
      ],
    });
    assert.equal(await exists(old.root), true);
    assert.equal(await exists(latest.root), true);
  }
});

void test('a live shipped Mac main retains generations after config removal and bundle alias retargeting', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const bundle = join(f.temp, 'Copied VarisDev.app');
  const config = join(bundle, 'Contents/Resources/app/launch.json');
  await put(
    config,
    JSON.stringify({installRoot: f.installRoot, runtimeRoot: old.root}),
  );
  const alias = join(f.temp, 'Launcher Alias.app');
  await symlink(
    bundle,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const executable = join(alias, 'Contents/MacOS/VarisDev').replaceAll(
    '\\',
    '/',
  );
  const pid = process.pid + 1;
  const rows = macRuntimeProcesses(
    `${pid} ${executable}`,
    `${pid} ${executable} Helper/project`,
  );
  for (const state of ['original', 'removed', 'retargeted']) {
    if (state === 'removed') await rm(config);
    if (state === 'retargeted') {
      const empty = join(f.temp, 'Empty.app');
      await mkdir(empty);
      await rm(alias, {recursive: true, force: true});
      await symlink(
        empty,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => rows,
    });
    assert.equal(await exists(old.root), true, state);
  }
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), false);
});

for (const directory of ['VarisDev-ä.app', 'literal-M-CM-$/VarisDev-ä.app']) {
  void test(`escaped copied Darwin launcher protects its installation under ${directory}`, async t => {
    const f = await fixture(t);
    const old = await f.generation(1);
    const bundle = join(f.temp, directory);
    await put(
      join(bundle, 'Contents/Resources/app/launch.json'),
      JSON.stringify({
        installRoot: f.installRoot,
        runtimeRoot: '/obsolete-config-root',
      }),
    );
    const executable = join(bundle, 'Contents/MacOS/VarisDev').replaceAll(
      '\\',
      '/',
    );
    const pid = process.pid + 1;
    for (const path of [executable, executable.replaceAll('ä', 'M-CM-$')]) {
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: async () =>
          macRuntimeProcesses(`${pid} ${path}`, `${pid} ${path}`),
      });
      assert.equal(await exists(old.root), true);
    }
  });
}

void test('Darwin launcher configs defer cleanup regardless of their current installation or runtime root', async t => {
  const f = await fixture(t);
  const unicode = await f.generation(1);
  const literal = await f.generation(2);
  const unused = await f.generation(3);
  for (const [name, runtimeRoot] of [
    ['VarisDev-ä.app', unicode.root],
    ['VarisDev-M-CM-$.app', literal.root],
  ]) {
    await put(
      join(f.temp, name, 'Contents/Resources/app/launch.json'),
      JSON.stringify({installRoot: join(f.temp, 'other-install'), runtimeRoot}),
    );
    await put(
      join(f.temp, name, 'Contents/MacOS/VarisDev'),
      'launcher executable',
    );
  }
  const path = join(
    f.temp,
    'VarisDev-M-CM-$.app/Contents/MacOS/VarisDev',
  ).replaceAll('\\', '/');
  const pid = process.pid + 1;
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(`${pid} ${path}`, `${pid} ${path}`),
  });
  assert.equal(await exists(unicode.root), true);
  assert.equal(await exists(literal.root), true);
  assert.equal(await exists(unused.root), true);
});

void test('own Darwin main process and helpers without launcher configs allow obsolete generations to be removed', async t => {
  const f = await fixture(t);
  const running = await f.generation(1);
  const unused = await f.generation(2);
  const bundle = join(f.temp, 'VarisDev-ä.app');
  await put(
    join(bundle, 'Contents/Resources/app/launch.json'),
    JSON.stringify({installRoot: f.installRoot, runtimeRoot: running.root}),
  );
  const main = join(bundle, 'Contents/MacOS/VarisDev')
    .replaceAll('\\', '/')
    .replaceAll('ä', 'M-CM-$');
  const helper = join(
    bundle,
    'Contents/Frameworks/VarisDev Helper.app/Contents/MacOS/VarisDev Helper',
  );
  await mkdir(dirname(helper), {recursive: true});
  const displayed = helper.replaceAll('\\', '/').replaceAll('ä', 'M-CM-$');
  const snapshots = `${process.pid} ${main}\n${process.pid + 1} ${displayed}`;
  await cleanupRuntimeGenerations({
    ...f.options,
    runningRoot: running.root,
    processes: async () => macRuntimeProcesses(snapshots, snapshots),
  });
  assert.equal(await exists(running.root), true);
  assert.equal(await exists(unused.root), false);
});

void test('unresolved and excessively ambiguous Darwin launcher paths defer deletion', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const pid = process.pid + 1;
  const missing = join(f.temp, 'missing-ä.app/Contents/MacOS/VarisDev')
    .replaceAll('\\', '/')
    .replaceAll('ä', 'M-CM-$');
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(`${pid} ${missing}`, `${pid} ${missing}`),
  });
  assert.equal(await exists(old.root), true);
  let parents = [join(f.temp, 'ambiguous')];
  await mkdir(parents[0]);
  for (let index = 0; index < 7; index++) {
    parents = parents.flatMap(parent => [
      join(parent, 'ä'),
      join(parent, 'M-CM-$'),
    ]);
    await Promise.all(parents.map(parent => mkdir(parent, {recursive: true})));
  }
  await Promise.all(
    parents.map(parent =>
      mkdir(join(parent, 'VarisDev.app'), {recursive: true}),
    ),
  );
  const ambiguous = join(
    f.temp,
    'ambiguous',
    ...Array<string>(7).fill('M-CM-$'),
    'VarisDev.app/Contents/MacOS/VarisDev',
  ).replaceAll('\\', '/');
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () =>
      macRuntimeProcesses(`${pid} ${ambiguous}`, `${pid} ${ambiguous}`),
  });
  assert.equal(await exists(old.root), true);
});

void test('process inspection errors, incomplete active metadata and a busy old updater defer cleanup', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const manager = new RuntimeManager({
    installRoot: f.installRoot,
    dataDir: f.dataDir,
    hooks: {
      processes: async () => {
        throw new Error('Permission denied while inspecting runtime process');
      },
    },
  });
  await manager.cleanupRuntimes();
  assert.equal(await exists(old.root), true);
  await put(join(f.dataDir, 'active.json'), '{partial');
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), true);
  await rm(join(f.dataDir, 'active.json'));
  await put(
    join(f.dataDir, 'update.lock/owner.json'),
    JSON.stringify({pid: process.pid, token: 'older-updater'}),
  );
  await new RuntimeManager({
    installRoot: f.installRoot,
    dataDir: f.dataDir,
    hooks: {processes: f.options.processes},
  }).cleanupRuntimes();
  assert.equal(await exists(old.root), true);
  assert.equal(
    JSON.parse(
      await readFile(join(f.dataDir, 'update.lock/owner.json'), 'utf8'),
    ).token,
    'older-updater',
  );
  await rm(join(f.dataDir, 'update.lock'), {recursive: true});
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), false);
});

void test('startup cleanup recovers dead and abandoned incomplete update locks without waiting for live owners', async t => {
  const f = await fixture(t);
  const manager = new RuntimeManager({
    installRoot: f.installRoot,
    dataDir: f.dataDir,
    hooks: {processes: f.options.processes},
  });
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await once(child, 'exit');
  assert.throws(() => process.kill(pid!, 0), {code: 'ESRCH'});
  const abandoned = await f.generation(1);
  const lock = join(f.dataDir, 'update.lock');
  await put(join(lock, 'owner.json'), JSON.stringify({pid, token: 'dead'}));
  await manager.cleanupRuntimes();
  assert.equal(await exists(abandoned.root), false);
  assert.equal(await exists(lock), false);

  const incomplete = await f.generation(2);
  await put(join(lock, 'owner.json'), '{partial');
  await manager.cleanupRuntimes();
  assert.equal(await exists(incomplete.root), true);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await manager.cleanupRuntimes();
  assert.equal(await exists(incomplete.root), false);
  assert.equal(await exists(lock), false);
});

void test('generation, metadata and runtimes links never redirect deletion', async t => {
  const f = await fixture(t);
  const external = join(f.temp, 'external');
  await put(join(external, 'keep'), 'outside');
  const owned = await f.generation(1);
  // Directory junctions do not require Windows Developer Mode.
  await symlink(
    external,
    join(f.dataDir, 'runtimes', 'app-0000000000000002'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await symlink(
    external,
    join(owned.root, 'linked-child'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(owned.root), false);
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'outside');
  assert.equal(
    await exists(join(f.dataDir, 'runtimes', 'app-0000000000000002')),
    true,
  );
  await rm(join(f.dataDir, 'runtimes'), {recursive: true});
  await symlink(
    external,
    join(f.dataDir, 'runtimes'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'outside');
});

void test('failed deletion retains ownership and retries partially removed generations', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  await put(join(old.root, 'a-removable'), 'temporary');
  const remove = fs.rm;
  const mocked = t.mock.method(
    fs,
    'rm',
    async (...args: Parameters<typeof remove>) => {
      if (String(args[0]) === join(old.root, 'partial-download'))
        throw Object.assign(new Error('Locked file'), {code: 'EPERM'});
      return remove(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await cleanupRuntimeGenerations(f.options);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await exists(join(old.root, 'runtime.json')), true);
  assert.equal(await exists(join(old.root, 'a-removable')), false);
  await cleanupRuntimeGenerations(f.options);
  assert.equal(await exists(old.root), false);
});

void test('dynamic file URLs identify runtime and base paths without decoding unrelated arguments', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const unused = await f.generation(2);
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [],
        command: `node --eval import(${JSON.stringify(pathToFileURL(join(old.root, 'session.mjs')).href)})`,
      },
    ],
  });
  assert.equal(await exists(old.root), true);
  assert.equal(await exists(unused.root), false);
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => [
      {
        pid: process.pid + 1,
        paths: [],
        command: `node --eval import(${JSON.stringify(pathToFileURL(join(f.installRoot, 'bin/varisdev.mjs')).href)})`,
      },
    ],
  });
  assert.equal(await exists(old.root), true);
  assert.equal(
    containsRuntimePath(
      'import("file:///data%20with%20spaces/runtime/main.js")',
      '/data with spaces/runtime',
      'linux',
    ),
    true,
  );
  assert.equal(
    containsRuntimePath(
      'import("file:///c:/Data%20With%20Spaces/runtime/main.js")',
      'C:\\Data With Spaces\\runtime',
      'win32',
    ),
    true,
  );
  assert.equal(
    containsRuntimePath(
      '%2Fdata%20with%20spaces%2Fruntime',
      '/data with spaces/runtime',
      'linux',
    ),
    false,
  );
});

void test('runtime path matching handles Windows casing, separators, spaces and generation boundaries', () => {
  const root =
    'C:\\Users\\User\\AppData\\Local\\VarisDev\\runtimes\\app-0123456789abcdef';
  assert.equal(
    containsRuntimePath(
      '"c:/users/USER/appdata/local/varisdev/runtimes/app-0123456789abcdef/node_modules/varisdev/main.js"',
      root,
      'win32',
    ),
    true,
  );
  assert.equal(
    containsRuntimePath(
      '\\\\?\\C:\\Users\\User\\AppData\\Local\\VarisDev\\runtimes\\app-0123456789abcdef\\main.js',
      root,
      'win32',
    ),
    true,
  );
  assert.equal(containsRuntimePath(`${root}0/main.js`, root, 'win32'), false);
  assert.equal(
    containsRuntimePath(
      'node --eval import("/data with spaces/runtimes/app-0123456789abcdef/main.js")',
      '/data with spaces/runtimes/app-0123456789abcdef',
      'linux',
    ),
    true,
  );
  assert.equal(
    containsRuntimePath(
      '/DATA/runtimes/app-0123456789abcdef/main.js',
      '/data/runtimes/app-0123456789abcdef',
      'linux',
    ),
    false,
  );
});

void test('Linux bootstrap protection uses raw argv when known paths are missing', async t => {
  const f = await fixture(t);
  const proc = join(f.temp, 'proc');
  await put(join(proc, '123/status'), 'State:\tS (sleeping)\n');
  await put(join(proc, '123/environ'), '');
  const link = async (path: string) =>
    path.endsWith('/cwd') ? f.temp : process.execPath;
  for (const argument of [
    './missing.conf',
    '.bin/varisdev',
    'bin/varisdev.mjs',
  ]) {
    const old = await f.generation(1);
    await put(join(proc, '123/cmdline'), `/usr/bin/node\0${argument}\0`);
    const processes = await readLinuxRuntimeProcesses(proc, link);
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: async () => processes,
    });
    assert.equal(await exists(old.root), argument !== './missing.conf');
  }
});

void test('Linux inspection tolerates inaccessible unrelated sandboxes and fails closed for runtime hosts', async t => {
  const f = await fixture(t);
  const proc = join(f.temp, 'proc');
  await put(
    join(proc, '123/status'),
    'State:\tS (sleeping)\nUid:\t1000 1000 1000 1000\n',
  );
  await put(
    join(proc, '123/cmdline'),
    '/usr/bin/chrome\0--type=renderer\0/root/private.conf\0',
  );
  const denied = async (): Promise<string> => {
    throw Object.assign(new Error('Permission denied'), {code: 'EACCES'});
  };
  const canonical = t.mock.method(fs, 'realpath', denied);
  syncBuiltinESMExports();
  try {
    const rows = await readLinuxRuntimeProcesses(proc, denied);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pid, 123);
    assert.equal(canonical.mock.callCount(), 0);
  } finally {
    canonical.mock.restore();
    syncBuiltinESMExports();
  }
  await put(join(proc, '123/cmdline'), '/usr/bin/node\0/old/runtime/cli.js\0');
  await assert.rejects(readLinuxRuntimeProcesses(proc, denied), {
    code: 'EACCES',
  });
});

void test(
  'POSIX npm symlink launches retain dynamically imported runtimes until exit',
  {skip: process.platform === 'win32'},
  async t => {
    const f = await fixture(t);
    const prefix = join(f.temp, 'prefix with spaces');
    const installRoot = join(prefix, 'lib/node_modules/varisdev');
    const old = await f.generation(1, {baseRoot: installRoot});
    await put(join(old.root, 'loaded.mjs'), 'export const loaded = true;');
    const entrypoint = join(installRoot, 'bin/varisdev.mjs');
    await put(
      entrypoint,
      `await import(${JSON.stringify(pathToFileURL(join(old.root, 'loaded.mjs')).href)}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
    );
    const alias = join(prefix, 'bin/varisdev');
    await mkdir(dirname(alias), {recursive: true});
    await symlink('../lib/node_modules/varisdev/bin/varisdev.mjs', alias);
    const launches =
      process.platform === 'linux' ? [alias, 'bin/varisdev'] : [alias];
    for (const script of launches) {
      const child = spawn(
        process.execPath,
        [script, join(f.dataDir, 'runtimes')],
        {
          cwd: prefix,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
      });
      await new Promise<void>((fulfill, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Symlink launcher did not start.')),
          5000,
        );
        child.stdout.once('data', () => {
          clearTimeout(timer);
          fulfill();
        });
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Symlink launcher exited before readiness.'));
        });
      });
      const snapshot = await runtimeProcesses();
      const observed = snapshot.find(row => row.pid === child.pid);
      assert.ok(observed);
      if (process.platform === 'linux')
        assert.ok(observed.paths.includes(entrypoint));
      await cleanupRuntimeGenerations({
        ...f.options,
        installRoot,
        processes: async () => snapshot,
      });
      assert.equal(await exists(old.root), true);
      // macOS ps preserves the full alias in its flattened command string, but
      // does not reliably retain argv quoting for paths containing spaces.
      await cleanupRuntimeGenerations({
        ...f.options,
        installRoot,
        processes: async () => [
          {
            pid: child.pid!,
            paths: [process.execPath],
            command: `${process.execPath} ${alias} --runtime-dir ${join(f.dataDir, 'runtimes')}`,
          },
        ],
      });
      assert.equal(await exists(old.root), true);
      child.kill('SIGKILL');
      await once(child, 'close');
    }
    await cleanupRuntimeGenerations({
      ...f.options,
      installRoot,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), false);
  },
);

for (const generationAlias of [false, true]) {
  void test(`live absolute ${generationAlias ? 'generation' : 'base'} aliases retain loaded runtimes after retargeting and unlink`, async t => {
    const f = await fixture(t);
    const old = await f.generation(1);
    const unused = await f.generation(2);
    const target = generationAlias ? old.root : f.installRoot;
    await put(join(old.root, 'loaded.mjs'), 'export const loaded = true;');
    await put(
      join(old.root, 'after-cleanup.mjs'),
      'export const ready = true;',
    );
    await put(
      join(target, 'bin/varisdev.mjs'),
      `await import(${JSON.stringify(pathToFileURL(join(old.root, 'loaded.mjs')).href)}); let checks = 0; process.on('message', async () => { try { await import(${JSON.stringify(pathToFileURL(join(old.root, 'after-cleanup.mjs')).href)} + '?check=' + checks++); process.send({ready: true}); } catch (error) { process.send({error: error.message}); } }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
    );
    const alias = join(f.temp, 'install-alias');
    await symlink(
      target,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const child = spawn(
      process.execPath,
      [join(alias, 'bin/varisdev.mjs'), join(f.dataDir, 'runtimes')],
      {
        cwd: f.temp,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'close');
      }
    });
    await new Promise<void>((fulfill, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Aliased bootstrap did not start.')),
        5000,
      );
      child.stdout!.once('data', () => {
        clearTimeout(timer);
        fulfill();
      });
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Aliased bootstrap exited before readiness.'));
      });
    });
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), true);
    assert.equal(await exists(unused.root), true);
    const foreign = join(f.temp, 'foreign');
    await put(
      join(foreign, 'bin/varisdev.mjs'),
      'export const foreign = true;',
    );
    for (const state of ['original', 'retargeted', 'removed']) {
      if (state !== 'original') {
        await rm(alias, {recursive: true, force: true});
        if (state === 'retargeted')
          await symlink(
            foreign,
            alias,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        await cleanupRuntimeGenerations({
          ...f.options,
          processes: runtimeProcesses,
        });
        assert.equal(await exists(old.root), true);
        assert.equal(await exists(unused.root), true);
      }
      const reply = once(child, 'message');
      child.send!('verify');
      assert.deepEqual((await reply)[0], {ready: true});
    }
    child.kill('SIGKILL');
    await once(child, 'close');
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), false);
  });
}

void test(
  'custom extensionless npm aliases protect loaded runtimes after retargeting and unlink',
  {skip: process.platform === 'win32'},
  async t => {
    const f = await fixture(t);
    const old = await f.generation(1);
    const entrypoint = join(f.installRoot, 'bin/varisdev.mjs');
    await put(join(old.root, 'loaded.mjs'), 'export const loaded = true;');
    await put(
      join(old.root, 'after-cleanup.mjs'),
      'export const ready = true;',
    );
    await put(
      entrypoint,
      `await import(${JSON.stringify(pathToFileURL(join(old.root, 'loaded.mjs')).href)}); let checks = 0; process.on('message', async () => { try { await import(${JSON.stringify(pathToFileURL(join(old.root, 'after-cleanup.mjs')).href)} + '?check=' + checks++); process.send({ready: true}); } catch (error) { process.send({error: error.message}); } }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
    );
    const alias = join(f.temp, '.bin/varisdev');
    await mkdir(dirname(alias));
    for (const script of [alias, '.bin/varisdev']) {
      await symlink(entrypoint, alias);
      const child = spawn(
        process.execPath,
        [script, join(f.dataDir, 'runtimes')],
        {cwd: f.temp, stdio: ['ignore', 'pipe', 'pipe', 'ipc']},
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
      });
      await new Promise<void>((fulfill, reject) => {
        const timer = setTimeout(
          () => reject(new Error('npm alias did not start.')),
          5000,
        );
        child.stdout!.once('data', () => {
          clearTimeout(timer);
          fulfill();
        });
        child.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('npm alias exited before readiness.'));
        });
      });
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: runtimeProcesses,
      });
      assert.equal(await exists(old.root), true);
      const pid = child.pid!;
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: async () =>
          macRuntimeProcesses(
            `${pid} /usr/bin/node`,
            `${pid} node "${pathToFileURL(alias).href}" --runtime-dir "${join(f.dataDir, 'runtimes')}"`,
          ),
      });
      assert.equal(await exists(old.root), true);
      const foreign = join(f.temp, 'foreign/bin/varisdev.mjs');
      await put(foreign, 'export const foreign = true;');
      for (const state of ['original', 'retargeted', 'removed']) {
        if (state !== 'original') {
          await rm(alias);
          if (state === 'retargeted') await symlink(foreign, alias);
          await cleanupRuntimeGenerations({
            ...f.options,
            processes: runtimeProcesses,
          });
          assert.equal(await exists(old.root), true);
        }
        const reply = once(child, 'message');
        child.send!('verify');
        assert.deepEqual((await reply)[0], {ready: true});
      }
      child.kill('SIGKILL');
      await once(child, 'close');
    }
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), false);
  },
);

void test(
  'foreign Linux CLI bootstraps defer cleanup until they exit',
  {skip: process.platform !== 'linux'},
  async t => {
    const f = await fixture(t);
    const old = await f.generation(1);
    const foreign = join(f.temp, 'foreign/bin/varisdev.mjs');
    await put(
      foreign,
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    );
    const alias = join(f.temp, '.bin/varisdev');
    await mkdir(dirname(alias));
    await symlink(foreign, alias);
    const child = spawn(
      process.execPath,
      ['.bin/varisdev', join(f.dataDir, 'runtimes')],
      {cwd: f.temp, stdio: ['ignore', 'pipe', 'pipe']},
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'close');
      }
    });
    await once(child.stdout, 'data');
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), true);
    child.kill('SIGKILL');
    await once(child, 'close');
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), false);
  },
);

void test('ordinary foreign Node programs allow cleanup while they remain alive', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const script = join(f.temp, 'foreign/server.cjs');
  await put(
    script,
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  );
  const child = spawn(process.execPath, [script], {
    cwd: dirname(script),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  });
  await once(child.stdout, 'data');
  try {
    await cleanupRuntimeGenerations({
      ...f.options,
      processes: runtimeProcesses,
    });
    assert.equal(await exists(old.root), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  }
});

for (const relative of [false, true]) {
  void test(
    `live ${relative ? 'relative' : 'absolute'} base bootstraps with Helper/project arguments retain fresh imports until exit`,
    {skip: relative && process.platform !== 'win32'},
    async t => {
      const f = await fixture(t);
      const old = await f.generation(1);
      await put(join(old.root, 'loaded.mjs'), 'export const loaded = true;');
      await put(
        join(old.root, 'after-cleanup.mjs'),
        'export const ready = true;',
      );
      const entrypoint = join(f.installRoot, 'bin/varisdev.mjs');
      await put(
        entrypoint,
        `await import(${JSON.stringify(pathToFileURL(join(old.root, 'loaded.mjs')).href)});
        process.on('message', async () => {
          try {
            const fresh = await import(${JSON.stringify(pathToFileURL(join(old.root, 'after-cleanup.mjs')).href)});
            process.send({fresh: fresh.ready});
          } catch (error) { process.send({error: error.code || error.message}); }
        });
        process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
      );
      const child = spawn(
        process.execPath,
        [
          relative ? 'bin/varisdev.mjs' : entrypoint,
          'Helper/project',
          join(f.dataDir, 'runtimes'),
        ],
        {
          cwd: f.installRoot,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
        },
      );
      try {
        await new Promise<void>((fulfill, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Bootstrap did not start.')),
            5000,
          );
          child.stdout!.once('data', () => {
            clearTimeout(timer);
            fulfill();
          });
          child.once('error', error => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Bootstrap exited before readiness.'));
          });
        });
        const snapshot = await runtimeProcesses();
        assert.ok(snapshot.some(row => row.pid === child.pid));
        await cleanupRuntimeGenerations({
          ...f.options,
          processes: async () => snapshot,
        });
        assert.equal(await exists(old.root), true);
        const reply = once(child, 'message');
        child.send!('verify');
        assert.deepEqual((await reply)[0], {fresh: true});
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
      }
      await cleanupRuntimeGenerations({
        ...f.options,
        processes: runtimeProcesses,
      });
      assert.equal(await exists(old.root), false);
    },
  );
}

void test('host process inspection protects an older runtime and permits cleanup after exit', async t => {
  const f = await fixture(t);
  const old = await f.generation(1);
  const script = join(old.root, 'live.cjs');
  await put(
    script,
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  );
  const child = spawn(process.execPath, [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  });
  await once(child.stdout, 'data');
  const snapshot = await runtimeProcesses();
  assert.ok(
    snapshot.some(
      row =>
        row.pid === child.pid &&
        [...row.paths, row.command].some(path =>
          containsRuntimePath(path, old.root),
        ),
    ),
  );
  await cleanupRuntimeGenerations({
    ...f.options,
    processes: async () => snapshot,
  });
  assert.equal(await exists(old.root), true);
  child.kill('SIGKILL');
  await once(child, 'close');
  for (const name of ['cleanup.ts', 'process-probe.mjs'])
    await copyFile(
      new URL(`../src/runtime/${name}`, import.meta.url),
      join(f.installRoot, name),
    );
  const base = await import(
    pathToFileURL(join(f.installRoot, 'cleanup.ts')).href
  );
  // A base installation's Linux probe must not count its own short-lived
  // inspector as another opaque launcher of that installation.
  await base.cleanupRuntimeGenerations({...f.options, processes: undefined});
  assert.equal(await exists(old.root), false);
});
