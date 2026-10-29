import {Buffer} from 'node:buffer';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from 'node:timers';
import {fileURLToPath, URL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const preload = fileURLToPath(
  new URL('./installer-process-registry.cjs', import.meta.url),
);
const registryVariable = 'VARISDEV_INSTALLER_PROCESS_REGISTRY';
const scopeVariable = 'VARISDEV_INSTALLER_PROCESS_SCOPE';
const deadlineVariable = 'VARISDEV_INSTALLER_PROCESS_DEADLINE';
const windows = process.platform === 'win32';
const snapshotTimeoutMs = windows ? 3000 : 1000;
const cleanupTimeoutMs = windows ? 15000 : 5000;
const powershell = join(
  process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function checkedOutput(result) {
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Cannot manage installer processes: ${result.stderr}`);
  return result.stdout;
}

function runPowerShell(script, timeout) {
  return checkedOutput(
    spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          `$ErrorActionPreference = 'Stop'; ${script}`,
          'utf16le',
        ).toString('base64'),
      ],
      {encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL'},
    ),
  );
}

function processTable(timeout = snapshotTimeoutMs) {
  if (windows) {
    return runPowerShell(
      `Get-CimInstance Win32_Process | ForEach-Object {
        if ($_.CreationDate) {
          '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId,
            ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
        }
      }`,
      timeout,
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [pid, ppid, started] = line.trim().split(/\s+/).map(Number);
        return {pid, ppid, started, precision: 1};
      });
  }
  const output = checkedOutput(
    spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
      encoding: 'utf8',
      env: {...process.env, LC_ALL: 'C', TZ: 'UTC'},
      timeout,
      killSignal: 'SIGKILL',
    }),
  );
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      const started = match && Date.parse(`${match[5]} UTC`);
      if (!Number.isFinite(started))
        throw new Error(`Cannot read installer process identity: ${line}`);
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        group: Number(match[3]),
        state: match[4],
        started,
        precision: 1000,
      };
    });
}

const identity = row => `${row.pid}:${row.started}`;

/** Track process lifetimes within one command and its nested command scopes. */
export class ProcessTracker {
  constructor(scope) {
    this.scopes = new Set([scope]);
    this.parents = new Map();
    this.live = new Map();
    this.retired = new Set();
    this.groups = new Map();
  }

  retire(row) {
    this.retired.add(identity(row));
    if (this.live.get(row.pid)?.started === row.started)
      this.live.delete(row.pid);
    for (const [group, ownership] of this.groups) {
      if (ownership.keeper && identity(ownership.keeper) === identity(row))
        this.groups.delete(group);
    }
  }

  retireIdleKeepers(rows) {
    const idle = [];
    for (const [group, ownership] of this.groups) {
      if (!ownership.keeper) continue;
      const members = rows.filter(
        row => row.group === group && !row.state?.startsWith('Z'),
      );
      if (
        members.length === 1 &&
        identity(members[0]) === identity(ownership.keeper)
      )
        idle.push(members[0]);
    }
    for (const row of idle) this.retire(row);
    return idle;
  }

  update(rows, records) {
    const current = new Map(
      rows
        .filter(row => !row.state?.startsWith('Z'))
        .map(row => [row.pid, row]),
    );
    for (const record of records) {
      if (record.type === 'retire') this.retire(record);
      if (record.type === 'scope')
        this.parents.set(record.scope, record.parent);
    }
    let changed;
    do {
      changed = false;
      for (const [scope, parent] of this.parents) {
        if (this.scopes.has(parent) && !this.scopes.has(scope)) {
          this.scopes.add(scope);
          changed = true;
        }
      }
    } while (changed);
    for (const [pid, previous] of this.live) {
      if (current.get(pid)?.started !== previous.started) {
        this.retired.add(identity(previous));
        this.live.delete(pid);
      }
    }
    for (const [group, ownership] of this.groups) {
      const leader = current.get(group);
      const anchored = [...ownership.anchors].some(
        ([pid, started]) =>
          this.live.has(pid) &&
          current.get(pid)?.started === started &&
          current.get(pid)?.group === group,
      );
      if (
        !anchored ||
        (leader &&
          ownership.leader !== undefined &&
          leader.started !== ownership.leader)
      )
        this.groups.delete(group);
    }
    const claimGroup = (
      group,
      anchor,
      leader = this.live.get(group)?.started,
      keeper = false,
    ) => {
      if (
        !Number.isSafeInteger(group) ||
        group <= 0 ||
        !Number.isFinite(leader) ||
        anchor.group !== group ||
        this.live.get(anchor.pid)?.started !== anchor.started ||
        (current.has(group) && current.get(group).started !== leader)
      )
        return;
      const ownership = this.groups.get(group) || {leader, anchors: new Map()};
      ownership.anchors.set(anchor.pid, anchor.started);
      if (keeper) ownership.keeper = anchor;
      this.groups.set(group, ownership);
    };
    const adopt = row => {
      if (this.retired.has(identity(row)) || this.live.has(row.pid))
        return false;
      this.live.set(row.pid, row);
      return true;
    };
    for (const record of records) {
      if (
        !['process', 'group'].includes(record.type) ||
        !this.scopes.has(record.scope)
      )
        continue;
      const row = current.get(
        record.type === 'group' ? record.keeper : record.pid,
      );
      if (
        row &&
        row.started <= record.after &&
        row.started + row.precision > (record.before ?? -Infinity)
      ) {
        adopt(row);
        if (record.type === 'group')
          claimGroup(record.group, row, record.leaderStarted, true);
        else if (record.detached && row.group === row.pid)
          claimGroup(row.pid, row);
      }
    }
    do {
      changed = false;
      for (const row of current.values()) {
        const parent = this.live.get(row.ppid);
        if (
          this.groups.has(row.group) ||
          (parent && row.started + row.precision > parent.started)
        )
          changed = adopt(row) || changed;
      }
    } while (changed);
    for (const [group, ownership] of this.groups) {
      ownership.anchors = new Map(
        rows
          .filter(row => row.group === group && this.live.has(row.pid))
          .map(row => [row.pid, row.started]),
      );
    }
    // Return only identities validated by this snapshot, never historical PIDs.
    return [...this.live.keys()].map(pid => current.get(pid));
  }
}

/** Freeze validated POSIX identities and finish terminating them on inspection failure. */
export function stopPosixProcesses(inspect, remaining, kill = process.kill) {
  let failure;
  const frozen = new Map();
  const snapshot = () => {
    const rows = inspect(Math.min(snapshotTimeoutMs, remaining()));
    const current = new Set(rows.map(identity));
    for (const key of frozen.keys()) {
      if (!current.has(key)) frozen.delete(key);
    }
    return rows;
  };
  const signal = (rows, name) => {
    for (const row of [...rows].reverse()) {
      const key = identity(row);
      try {
        kill(row.pid, name);
        if (name === 'SIGSTOP') frozen.set(key, row);
      } catch (error) {
        if (error.code === 'ESRCH') frozen.delete(key);
        else failure ??= error;
      }
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const added = snapshot().filter(row => !frozen.has(identity(row)));
      if (added.length === 0) break;
      signal(added, 'SIGSTOP');
    }
  } catch (error) {
    failure ??= error;
  } finally {
    let targets;
    try {
      targets = snapshot();
    } catch (error) {
      failure ??= error;
      // Successfully stopped identities cannot cooperatively exit or recycle.
      targets = [...frozen.values()];
    }
    signal(targets, 'SIGKILL');
  }
  if (failure) throw failure;
}

/**
 * Run a command with live output and a deadline covering its descendants.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs: number, cwd?: string, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<void>}
 */
export function runCommand(command, args, {timeoutMs, cwd, env}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new Error('A positive command timeout is required.'));

  return new Promise((fulfill, reject) => {
    // Check ps before starting work; cleanup must also work with a restricted PATH.
    if (!windows) processTable();
    const inheritedRegistry =
      process.env[registryVariable] || env?.[registryVariable];
    const directory = inheritedRegistry
      ? undefined
      : mkdtempSync(join(tmpdir(), 'varisdev installer processes '));
    const registry = inheritedRegistry || join(directory, 'children.jsonl');
    const scope = randomUUID();
    const tracker = new ProcessTracker(scope);
    const removeRegistry = () => {
      if (directory) rmSync(directory, {recursive: true, force: true});
    };
    let child;
    try {
      if (directory) writeFileSync(registry, '', {mode: 0o600});
      appendFileSync(
        registry,
        `${JSON.stringify({
          type: 'scope',
          scope,
          parent: process.env[scopeVariable] || env?.[scopeVariable],
        })}\n`,
      );
      const childEnv = {
        ...(env || process.env),
        [registryVariable]: registry,
        [scopeVariable]: scope,
        [deadlineVariable]: String(
          Math.min(
            Number(process.env[deadlineVariable] || env?.[deadlineVariable]) ||
              Infinity,
            Date.now() + timeoutMs + cleanupTimeoutMs,
          ),
        ),
      };
      const requireOption = `--require ${JSON.stringify(preload)}`;
      if (!childEnv.NODE_OPTIONS?.includes(requireOption))
        childEnv.NODE_OPTIONS = [childEnv.NODE_OPTIONS, requireOption]
          .filter(Boolean)
          .join(' ');
      const before = Date.now();
      child = spawn(command, args, {
        cwd,
        env: childEnv,
        stdio: 'inherit',
        windowsHide: true,
        detached: !windows,
      });
      if (child.pid)
        appendFileSync(
          registry,
          `${JSON.stringify({
            type: 'process',
            scope,
            pid: child.pid,
            ppid: process.pid,
            before,
            after: Date.now(),
            detached: !windows,
          })}\n`,
        );
    } catch (error) {
      child?.kill('SIGKILL');
      removeRegistry();
      throw error;
    }
    let finished = false;
    let offset = 0;
    const inspect = (timeout = snapshotTimeoutMs, reapKeepers = false) => {
      const contents = readFileSync(registry, 'utf8');
      const end = contents.lastIndexOf('\n') + 1;
      const records = contents
        .slice(offset, end)
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const snapshot = processTable(timeout);
      const rows = tracker.update(snapshot, records);
      for (const row of reapKeepers
        ? tracker.retireIdleKeepers(snapshot)
        : []) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        appendFileSync(
          registry,
          `${JSON.stringify({type: 'retire', pid: row.pid, started: row.started})}\n`,
        );
      }
      offset = end;
      return rows.filter(
        row => tracker.live.get(row.pid)?.started === row.started,
      );
    };

    const stopTree = () => {
      if (!child.pid) return;
      const cleanupDeadline = Date.now() + cleanupTimeoutMs;
      const remaining = () => {
        const timeout = cleanupDeadline - Date.now();
        if (timeout <= 0) throw new Error('Process cleanup timed out.');
        return timeout;
      };
      if (windows) {
        for (;;) {
          const rows = inspect(Math.min(snapshotTimeoutMs, remaining()));
          if (rows.length === 0) return;
          for (let index = 0; index < rows.length; index += 128) {
            const targets = JSON.stringify(
              rows
                .slice(index, index + 128)
                .map(({pid, started}) => ({pid, started})),
            );
            // Retain each process handle while checking creation time and killing.
            // A recycled numeric PID must never identify the termination target.
            runPowerShell(
              `
              $targets = ConvertFrom-Json '${targets}';
              foreach ($target in $targets) {
                $p = Get-Process -Id $target.pid -ErrorAction SilentlyContinue;
                if ($p) {
                  try {
                    $null = $p.Handle;
                    if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq $target.started) { $p.Kill() }
                  } catch { if (!$p.HasExited) { throw } }
                  finally { $p.Dispose() }
                }
              }`,
              Math.min(snapshotTimeoutMs, remaining()),
            );
          }
        }
      }
      stopPosixProcesses(inspect, remaining);
    };

    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(watcher);
      try {
        stopTree();
      } catch (cleanupError) {
        error = new Error(
          `${error ? `${error.message}\n` : ''}Process cleanup failed: ${cleanupError.message}`,
        );
      } finally {
        try {
          removeRegistry();
        } catch (cleanupError) {
          error = new Error(
            `${error ? `${error.message}\n` : ''}Cannot remove process registry: ${cleanupError.message}`,
          );
        }
      }
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      // A failed OS termination must not keep this runner alive indefinitely.
      child.unref();
      if (error) reject(error);
      else fulfill();
    };
    const interrupt = signal => {
      finish(
        Object.assign(
          new Error(`Command interrupted by ${signal}: ${command}`),
          {
            exitCode: signal === 'SIGINT' ? 130 : 143,
          },
        ),
      );
    };
    const deadline = setTimeout(() => {
      const message = `Command timed out after ${timeoutMs} ms: ${command}`;
      process.stderr.write(`${message}\n`);
      finish(Object.assign(new Error(message), {code: 'ETIMEDOUT'}));
    }, timeoutMs);
    const watcher = windows
      ? undefined
      : setInterval(() => {
          try {
            inspect(snapshotTimeoutMs, true);
          } catch (error) {
            finish(error);
          }
        }, 200);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', finish);
    child.once('exit', (code, signal) => {
      finish(
        code === 0
          ? undefined
          : Object.assign(
              new Error(
                `Command ${signal ? `received ${signal}` : `exited with code ${code}`}: ${command}`,
              ),
              {exitCode: code || 1},
            ),
      );
    });
  });
}

let invokedDirectly = false;
try {
  invokedDirectly =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url));
} catch {
  // An imported runner can receive an option or a missing path as argv[1].
}
if (invokedDirectly) {
  const tests = [
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
  runCommand(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--test',
      '--test-concurrency=1',
      ...tests.map(name => `test/${name}.test.ts`),
    ],
    {cwd: root, timeoutMs: 20 * 60 * 1000},
  ).catch(error => {
    if (error.code !== 'ETIMEDOUT') process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
