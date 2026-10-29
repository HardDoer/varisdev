'use strict';

const {ChildProcess, spawn, spawnSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const {syncBuiltinESMExports} = require('node:module');
const process = require('node:process');

const registryVariable = 'VARISDEV_INSTALLER_PROCESS_REGISTRY';
const scopeVariable = 'VARISDEV_INSTALLER_PROCESS_SCOPE';
const registry = process.env[registryVariable];
const scope = process.env[scopeVariable];
const installed = Symbol.for('varisdev.installerProcessRegistry');

if (registry && scope && !ChildProcess.prototype[installed]) {
  const record = (file, value) =>
    appendFileSync(file, `${JSON.stringify({type: 'process', ...value})}\n`);
  // Scope membership survives short-lived shells and synchronous spawning.
  record(registry, {
    scope,
    pid: process.pid,
    ppid: process.ppid,
    after: Date.now(),
  });
  // All asynchronous child_process APIs, including promisified execFile and
  // fork, use this method. Keep their argument handling and return values.
  ChildProcess.prototype.spawn = new Proxy(ChildProcess.prototype.spawn, {
    apply(spawn, child, args) {
      const before = Date.now();
      const result = Reflect.apply(spawn, child, args);
      if (child.pid) {
        const environment = name => {
          const prefix = `${name}=`;
          return args[0].envPairs
            ?.find(pair => pair.startsWith(prefix))
            ?.slice(prefix.length);
        };
        record(environment(registryVariable) || registry, {
          scope: environment(scopeVariable) || scope,
          pid: child.pid,
          ppid: process.pid,
          detached: !!args[0].detached,
          before,
          after: Date.now(),
        });
      }
      return result;
    },
  });
  Object.defineProperty(ChildProcess.prototype, installed, {value: true});
  syncBuiltinESMExports();

  const deadline = Number(process.env.VARISDEV_INSTALLER_PROCESS_DEADLINE);
  if (process.platform !== 'win32' && Number.isFinite(deadline)) {
    const result = spawnSync(
      '/bin/ps',
      ['-p', String(process.pid), '-o', 'pgid=,lstart='],
      {
        encoding: 'utf8',
        env: {...process.env, LC_ALL: 'C', TZ: 'UTC'},
        timeout: 1000,
        killSignal: 'SIGKILL',
      },
    );
    if (result.error) throw result.error;
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (result.status !== 0 || !match)
      throw new Error('Cannot identify installer process group.');
    if (Number(match[1]) === process.pid) {
      const leaderStarted = Date.parse(`${match[2]} UTC`);
      if (!Number.isFinite(leaderStarted))
        throw new Error('Cannot identify installer group leader.');
      const before = Date.now();
      // Keep this existing group identifiable after its command exits. The
      // private keeper has no child processes and expires with the registry/deadline.
      const keeper = spawn(
        process.execPath,
        [
          '-e',
          `
        const {existsSync} = require('node:fs');
        setInterval(() => {
          if (Date.now() >= ${deadline} || !existsSync(${JSON.stringify(registry)})) process.exit(0);
        }, 250);
      `,
        ],
        {stdio: 'ignore', env: {...process.env, NODE_OPTIONS: undefined}},
      );
      keeper.unref();
      record(registry, {
        type: 'group',
        scope,
        group: process.pid,
        leaderStarted,
        keeper: keeper.pid,
        before,
        after: Date.now(),
      });
    }
  }
}
