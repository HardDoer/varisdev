import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {
  ProcessTracker,
  runCommand,
  stopPosixProcesses,
} from '../scripts/test-installer.mjs';

const runner = new URL('../scripts/test-installer.mjs', import.meta.url);
const preload = new URL(
  '../scripts/installer-process-registry.cjs',
  import.meta.url,
);
const registryVariable = 'VARISDEV_INSTALLER_PROCESS_REGISTRY';
const manager = new URL('../src/runtime/manager.ts', import.meta.url).href;
const cwd = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';

async function processFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'installer runner '));
  const record = join(directory, 'pids.json');
  t.after(async () => {
    const pids = await readFile(record, 'utf8').then(
      value => JSON.parse(value) as number[],
      () => [] as number[],
    );
    for (const pid of pids) {
      if (windows) {
        spawnSync(
          join(
            process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
            'System32/taskkill.exe',
          ),
          ['/PID', String(pid), '/T', '/F'],
          {stdio: 'ignore', timeout: 1000, killSignal: 'SIGKILL'},
        );
      } else {
        for (const target of [-pid, pid]) {
          try {
            process.kill(target, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
    }
    await rm(directory, {recursive: true, force: true});
  });
  return {record, directory};
}

function alive(pid: number): boolean {
  if (!windows) {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
      killSignal: 'SIGKILL',
    });
    if (result.error) throw result.error;
    return result.status === 0 && !result.stdout.trim().startsWith('Z');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

async function assertStopped(record: string) {
  const pids = JSON.parse(await readFile(record, 'utf8')) as number[];
  assert.ok(pids.length >= 2, 'fixture started its descendants');
  for (let attempt = 0; attempt < 20; attempt++) {
    if (pids.every(pid => !alive(pid))) return;
    await delay(50);
  }
  assert.deepEqual(pids.filter(alive), [], 'runner left descendants running');
}

void test(
  'installer runner imports with a non-path argv[1]',
  {timeout: 10000},
  async () => {
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.argv[1] = '--prefix'; await import(${JSON.stringify(runner.href)});`,
      ],
      {timeoutMs: 5000},
    );
  },
);

void test(
  'installer runner starts through a directory alias and selects all installer tests',
  {timeout: 15000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'installer entry '));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const fixture = join(directory, 'package');
    const alias = join(directory, 'alias');
    const record = join(directory, 'selected-tests.txt');
    await mkdir(join(fixture, 'scripts'), {recursive: true});
    await mkdir(join(fixture, 'test'));
    await copyFile(runner, join(fixture, 'scripts/test-installer.mjs'));
    await copyFile(
      preload,
      join(fixture, 'scripts/installer-process-registry.cjs'),
    );
    const names = [
      'installer-runner',
      'install-desktop',
      'install-path',
      'web-install',
      'release-web',
      'runtime-updates',
      'node-version',
      'windows-environment',
      'installer-package',
    ];
    for (const name of names)
      await writeFile(
        join(fixture, 'test', `${name}.test.ts`),
        `import {appendFileSync} from 'node:fs';
       appendFileSync(${JSON.stringify(record)}, ${JSON.stringify(`${name}\n`)});`,
      );
    await symlink(fixture, alias, windows ? 'junction' : 'dir');
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    await runCommand(
      process.execPath,
      [join(alias, 'scripts/test-installer.mjs')],
      {
        timeoutMs: 10000,
        env,
      },
    );
    assert.deepEqual(
      (await readFile(record, 'utf8')).trim().split('\n').sort(),
      names.sort(),
    );
  },
);

void test(
  'installer runner propagates a failed command exit',
  {timeout: 10000},
  async () => {
    await assert.rejects(
      runCommand(process.execPath, ['-e', 'process.exit(7)'], {
        timeoutMs: 5000,
      }),
      error => {
        assert.equal((error as Error & {exitCode: number}).exitCode, 7);
        return true;
      },
    );
  },
);

void test(
  'installer runner deadline stops runRuntimeCommand and nested detached groups',
  {timeout: 15000},
  async t => {
    const {record} = await processFixture(t);
    const worker = `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32', stdio: 'ignore',
    });
    writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.ppid, process.pid, leaf.pid]));
    setInterval(() => {}, 1000);
  `;
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runRuntimeCommand} from ${JSON.stringify(manager)};
         await runRuntimeCommand(process.execPath, ['-e', ${JSON.stringify(worker)}], {
           cwd: ${JSON.stringify(cwd)}, env: process.env, timeoutMs: 60000,
         });`,
        ],
        {cwd, timeoutMs: 3000},
      ),
      {code: 'ETIMEDOUT'},
    );
    await assertStopped(record);
  },
);

void test(
  'installer runner remembers detached descendants after their parent exits',
  {timeout: 10000, skip: windows},
  async t => {
    const {record} = await processFixture(t);
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          `const {spawn} = require('node:child_process');
         const {writeFileSync} = require('node:fs');
         const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
           detached: true, stdio: 'ignore',
         });
         leaf.unref();
         writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, leaf.pid]));
         setTimeout(() => process.exit(7), 700);`,
        ],
        {timeoutMs: 5000},
      ),
      {exitCode: 7},
    );
    await assertStopped(record);
  },
);

void test(
  'installer runner stops detached descendants when their parent exits immediately',
  {timeout: 20000},
  async t => {
    for (const method of ['spawn', 'execFile', 'fork']) {
      await t.test(method, {timeout: 6000}, async t => {
        const {record, directory} = await processFixture(t);
        const worker = join(directory, 'worker.cjs');
        const metadata = join(directory, 'registry.json');
        await writeFile(worker, 'setInterval(() => {}, 1000);');
        const env = {...process.env, INSTALLER_RUNNER_SENTINEL: 'preserved'};
        const before = {...env};
        await assert.rejects(
          runCommand(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import {${method}} from 'node:child_process';
               import {writeFileSync} from 'node:fs';
               const options = {
                 detached: true,
                 stdio: ${method === 'fork' ? "['ignore', 'ignore', 'ignore', 'ipc']" : "'ignore'"},
               };
               const leaf = ${method === 'fork' ? `fork(${JSON.stringify(worker)}, [], options)` : `${method}(process.execPath, [${JSON.stringify(worker)}], options)`};
               leaf.unref();
               writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, leaf.pid]));
               writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({
                 registry: process.env.${registryVariable},
                 sentinel: process.env.INSTALLER_RUNNER_SENTINEL,
               }));
               process.exit(7);`,
            ],
            {timeoutMs: 5000, env},
          ),
          {exitCode: 7},
        );
        await assertStopped(record);
        const info = JSON.parse(await readFile(metadata, 'utf8')) as {
          registry: string;
          sentinel: string;
        };
        assert.equal(info.sentinel, 'preserved');
        assert.deepEqual(
          env,
          before,
          'runner must not mutate the supplied environment',
        );
        if (process.env[registryVariable]) {
          assert.equal(info.registry, process.env[registryVariable]);
          assert.ok(
            existsSync(info.registry),
            'nested calls retain the shared registry',
          );
        } else {
          assert.equal(
            existsSync(info.registry),
            false,
            'owner removes its registry',
          );
        }
      });
    }
  },
);

void test(
  'installer runner shares a registry with nested commands and removes its owned registry',
  {timeout: 15000},
  async t => {
    const {record, directory} = await processFixture(t);
    const metadata = join(directory, 'registry.json');
    const env = {...process.env};
    // Let the inner runner own this registry even when the installer suite itself
    // already runs under runCommand. Keep the inherited Node options intact.
    delete env[registryVariable];
    const worker = `
      const {spawn} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore',
      });
      leaf.unref();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, leaf.pid]));
      writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({registry: process.env.${registryVariable}}));
      process.exit(7);`;
    // The isolated Node process creates an owner runCommand, which launches a
    // second runCommand. Its early-exiting child must share the owner's registry.
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
         import {existsSync, readFileSync} from 'node:fs';
         import {runCommand} from ${JSON.stringify(runner.href)};
         delete process.env.${registryVariable};
         await runCommand(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
           import assert from 'node:assert/strict';
           import {existsSync, readFileSync} from 'node:fs';
           import {runCommand} from ${JSON.stringify(runner.href)};
           const registry = process.env.${registryVariable};
           await assert.rejects(runCommand(process.execPath, ['-e', ${JSON.stringify(worker)}], {timeoutMs: 5000}), {exitCode: 7});
           assert.equal(JSON.parse(readFileSync(${JSON.stringify(metadata)}, 'utf8')).registry, registry);
           assert.ok(existsSync(registry), 'nested cleanup must retain the owner registry');
         `)}], {timeoutMs: 8000});
         const {registry} = JSON.parse(readFileSync(${JSON.stringify(metadata)}, 'utf8'));
         assert.equal(existsSync(registry), false, 'owner cleanup must remove its registry');`,
      ],
      {timeoutMs: 12000, env},
    );
    await assertStopped(record);
    const {registry} = JSON.parse(await readFile(metadata, 'utf8')) as {
      registry: string;
    };
    assert.equal(existsSync(registry), false);
  },
);

void test(
  'installer runner records Node descendants entered through a synchronous spawn',
  {timeout: 10000},
  async t => {
    const {record} = await processFixture(t);
    const worker = `
      const {spawn} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      const leaf = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore',
      });
      leaf.unref();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, leaf.pid]));
      process.exit(7);`;
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          `const {spawnSync} = require('node:child_process');
           const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(worker)}], {
             stdio: 'inherit', timeout: 4000, killSignal: 'SIGKILL',
           });
           if (result.error) throw result.error;
           process.exit(result.status);`,
        ],
        {timeoutMs: 5000},
      ),
      {exitCode: 7},
    );
    await assertStopped(record);
  },
);

void test('installer runner retires departed identities and rejects recycled PIDs', () => {
  const tracker = new ProcessTracker('managed');
  const original = {pid: 101, ppid: 1, started: 1000, precision: 1};
  const descendant = {pid: 102, ppid: 101, started: 1001, precision: 1};
  const registration = {
    type: 'process',
    scope: 'managed',
    pid: 101,
    before: 1000,
    after: 1000,
  };
  assert.deepEqual(tracker.update([original, descendant], [registration]), [
    original,
    descendant,
  ]);

  const recycled = {...original, started: 3000};
  const unrelatedChild = {pid: 103, ppid: 101, started: 3001, precision: 1};
  const orphan = {...descendant, ppid: 1};
  assert.deepEqual(tracker.update([recycled, unrelatedChild, orphan], []), [
    orphan,
  ]);
  assert.deepEqual(
    tracker.update([recycled, unrelatedChild, orphan], [registration]),
    [orphan],
    'stale registry records cannot readopt a recycled PID or its descendants',
  );
  assert.deepEqual(tracker.update([], []), []);
  assert.deepEqual(
    tracker.update([original, descendant], [registration]),
    [],
    'an absent identity remains retired even if its old snapshot and record reappear',
  );
  assert.deepEqual(
    tracker.update([recycled], [{...registration, before: 3000, after: 3000}]),
    [recycled],
    'a fresh registration can identify a new managed lifetime using the same PID',
  );
});

void test('installer runner identifies nested scopes without retaining shell ancestry', () => {
  const tracker = new ProcessTracker('managed');
  const leaf = {pid: 201, ppid: 1, started: 1000, precision: 1};
  const sibling = {pid: 202, ppid: 1, started: 1000, precision: 1};
  const records = [
    {type: 'scope', scope: 'nested', parent: 'managed'},
    {type: 'scope', scope: 'sibling', parent: 'other'},
    {
      type: 'process',
      scope: 'nested',
      pid: leaf.pid,
      before: 1000,
      after: 1000,
    },
    {
      type: 'process',
      scope: 'sibling',
      pid: sibling.pid,
      before: 1000,
      after: 1000,
    },
  ];
  assert.deepEqual(tracker.update([leaf, sibling], records), [leaf]);
});

void test(
  'installer runner stops detached native descendants entered through a synchronous shell',
  {timeout: 10000, skip: windows},
  async t => {
    const {record, directory} = await processFixture(t);
    const worker = join(directory, 'shell worker.cjs');
    await writeFile(
      worker,
      `
      const {spawn} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      const leaf = spawn('/bin/sleep', ['1000'], {detached: true, stdio: 'ignore'});
      leaf.unref();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, leaf.pid]));
      process.exit(7);
    `,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `${quote(process.execPath)} ${quote(worker)}; exit $?`;
    await assert.rejects(
      runCommand(
        process.execPath,
        [
          '-e',
          `
        const {spawnSync} = require('node:child_process');
        const result = spawnSync('/bin/sh', ['-c', ${JSON.stringify(command)}], {
          stdio: 'inherit', timeout: 4000, killSignal: 'SIGKILL',
        });
        if (result.error) throw result.error;
        process.exit(result.status);
      `,
        ],
        {timeoutMs: 5000},
      ),
      {exitCode: 7},
    );
    await assertStopped(record);
  },
);

void test('installer runner kills frozen identities when final inspection cannot run', async t => {
  for (const cause of ['inspection', 'deadline']) {
    await t.test(cause, () => {
      const row = {pid: 301, started: 1000};
      const failure = new Error(`injected ${cause} failure`);
      const signals: Array<[number, string | number | undefined]> = [];
      let inspections = 0;
      let deadlines = 0;
      assert.throws(
        () =>
          stopPosixProcesses(
            () => {
              if (++inspections === 3 && cause === 'inspection') throw failure;
              return [row];
            },
            () => {
              if (++deadlines === 3 && cause === 'deadline') throw failure;
              return 1000;
            },
            (pid: number, signal?: string | number) => {
              signals.push([pid, signal]);
              return true;
            },
          ),
        error => error === failure,
      );
      assert.deepEqual(signals, [
        [301, 'SIGSTOP'],
        [301, 'SIGKILL'],
      ]);
    });
  }
});

void test('installer runner drops retired frozen identities before fallback termination', () => {
  const departed = {pid: 401, started: 1000};
  const survivor = {pid: 402, started: 1000};
  const failure = new Error('injected final snapshot failure');
  const signals: Array<[number, string | number | undefined]> = [];
  let inspections = 0;
  assert.throws(
    () =>
      stopPosixProcesses(
        () => {
          inspections++;
          if (inspections === 1) return [departed, survivor];
          if (inspections === 2) return [survivor];
          throw failure;
        },
        () => 1000,
        (pid: number, signal?: string | number) => {
          signals.push([pid, signal]);
          return true;
        },
      ),
    error => error === failure,
  );
  assert.deepEqual(signals, [
    [402, 'SIGSTOP'],
    [401, 'SIGSTOP'],
    [402, 'SIGKILL'],
  ]);
});

void test('installer runner adopts only identity-anchored owned process groups', () => {
  const tracker = new ProcessTracker('managed');
  const keeper = {pid: 502, ppid: 1, group: 501, started: 1001, precision: 1};
  const native = {pid: 503, ppid: 1, group: 501, started: 1002, precision: 1};
  const unrelated = {
    pid: 504,
    ppid: 1,
    group: 900,
    started: 1002,
    precision: 1,
  };
  const records = [
    {type: 'process', scope: 'managed', pid: 502, before: 1001, after: 1001},
    {
      type: 'group',
      scope: 'managed',
      group: 501,
      leaderStarted: 1000,
      keeper: 502,
      before: 1001,
      after: 1001,
    },
  ];
  assert.deepEqual(tracker.update([keeper, native, unrelated], records), [
    keeper,
    native,
  ]);
  const replacement = {
    pid: 501,
    ppid: 1,
    group: 501,
    started: 3000,
    precision: 1,
  };
  const replacementChild = {
    pid: 505,
    ppid: 1,
    group: 501,
    started: 3001,
    precision: 1,
  };
  assert.deepEqual(
    tracker.update(
      [replacement, replacementChild, keeper, native, unrelated],
      records,
    ),
    [keeper, native],
    'a replaced leader retires group ownership without adopting its new members',
  );
  assert.deepEqual(tracker.update([], []), []);
  assert.deepEqual(
    tracker.update([{...keeper, started: 4000}, replacementChild], records),
    [],
    'an empty group and recycled keeper cannot be reclaimed by stale records',
  );

  const ordinary = new ProcessTracker('managed');
  assert.deepEqual(
    ordinary.update(
      [unrelated, {...native, group: 900}],
      [
        {
          type: 'process',
          scope: 'managed',
          pid: 504,
          before: 1002,
          after: 1002,
        },
      ],
    ),
    [unrelated],
    'a registered process in an existing group does not confer ownership of that group',
  );
  const detached = new ProcessTracker('managed');
  const leader = {...replacement, started: 1000};
  assert.deepEqual(
    detached.update(
      [leader, native],
      [
        {
          type: 'process',
          scope: 'managed',
          pid: 501,
          before: 1000,
          after: 1000,
          detached: true,
        },
      ],
    ),
    [leader, native],
    'a verified registered detached leader explicitly owns its group',
  );
});

void test(
  'installer runner stops native background children of a synchronous shell',
  {timeout: 20000, skip: windows},
  async t => {
    for (const ending of ['deadline', 'immediate exit']) {
      await t.test(ending, {timeout: 8000}, async t => {
        const {record} = await processFixture(t);
        await assert.rejects(
          runCommand(
            process.execPath,
            [
              '-e',
              `
            const {spawnSync} = require('node:child_process');
            const {readFileSync, writeFileSync} = require('node:fs');
            const result = spawnSync('/bin/sh', ['-c', '/bin/sleep 8 >/dev/null 2>&1 & echo $!'], {
              encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL',
            });
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(result.stderr);
            const groups = readFileSync(process.env.${registryVariable}, 'utf8')
              .trim().split('\\n').map(line => JSON.parse(line));
            const keeper = groups.find(row => row.type === 'group' && row.group === process.pid);
            if (!keeper) throw new Error('Missing dedicated group keeper');
            writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, Number(result.stdout.trim()), keeper.keeper]));
            ${ending === 'deadline' ? 'setInterval(() => {}, 1000);' : 'process.exit(7);'}
          `,
            ],
            {timeoutMs: ending === 'deadline' ? 1000 : 5000},
          ),
          ending === 'deadline' ? {code: 'ETIMEDOUT'} : {exitCode: 7},
        );
        await assertStopped(record);
      });
    }
  },
);

void test('installer runner retires idle keepers across shared trackers', () => {
  const keeper = {pid: 702, ppid: 1, group: 701, started: 1001, precision: 1};
  const native = {pid: 703, ppid: 1, group: 701, started: 1002, precision: 1};
  const zombie = {
    pid: 701,
    ppid: 1,
    group: 701,
    started: 1000,
    precision: 1,
    state: 'Z',
  };
  const records = [
    {type: 'process', scope: 'managed', pid: 702, before: 1001, after: 1001},
    {
      type: 'group',
      scope: 'managed',
      group: 701,
      leaderStarted: 1000,
      keeper: 702,
      before: 1001,
      after: 1001,
    },
  ];
  const tracker = new ProcessTracker('managed');
  tracker.update([keeper, native], records);
  assert.deepEqual(
    tracker.retireIdleKeepers([keeper, native]),
    [],
    'native members retain their keeper',
  );
  tracker.update([keeper, zombie], []);
  assert.deepEqual(tracker.retireIdleKeepers([keeper, zombie]), [keeper]);
  const other = new ProcessTracker('managed');
  assert.deepEqual(
    other.update(
      [keeper, zombie],
      [...records, {type: 'retire', pid: keeper.pid, started: keeper.started}],
    ),
    [],
    'another tracker cannot readopt an already reaped keeper from old records',
  );
});

void test(
  'installer runner promptly reaps keepers from many short commands in a shared registry',
  {timeout: 30000, skip: windows},
  async t => {
    const {record, directory} = await processFixture(t);
    const metadata = join(directory, 'keeper-counts.json');
    await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import {spawn, spawnSync} from 'node:child_process';
      import {readFileSync, writeFileSync} from 'node:fs';
      import {setTimeout as delay} from 'node:timers/promises';
      const groups = () => readFileSync(process.env.${registryVariable}, 'utf8')
        .split('\\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.type === 'group' && row.scope === process.env.VARISDEV_INSTALLER_PROCESS_SCOPE);
      const liveKeepers = () => {
        const snapshot = spawnSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,stat='], {
          encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL',
        });
        if (snapshot.error) throw snapshot.error;
        assert.equal(snapshot.status, 0);
        const rows = snapshot.stdout.trim().split('\\n').map(line => line.trim().split(/\\s+/));
        return groups().filter(owner => rows.some(([pid, group, state]) =>
          Number(pid) === owner.keeper && Number(group) === owner.group && !state.startsWith('Z')));
      };
      const baseline = liveKeepers().length;
      assert.equal(baseline, 1);
      for (let index = 0; index < 20; index++) {
        await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', ''], {detached: true, stdio: 'ignore'});
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new Error('Short command failed: ' + code)));
        });
      }
      const registered = groups();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, ...registered.map(row => row.keeper)]));
      assert.equal(registered.length, baseline + 20);
      const deadline = Date.now() + 3000;
      let remaining;
      for (;;) {
        remaining = liveKeepers().length;
        if (remaining === baseline) break;
        assert.ok(Date.now() < deadline, 'idle keepers did not return to baseline: ' + remaining);
        await delay(50);
      }
      writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({baseline, created: registered.length - baseline, remaining}));
    `,
      ],
      {timeoutMs: 20000},
    );
    assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), {
      baseline: 1,
      created: 20,
      remaining: 1,
    });
    await assertStopped(record);
  },
);
