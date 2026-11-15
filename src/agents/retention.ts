import {randomUUID} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  watchFile,
  unwatchFile,
} from 'node:fs';
import {join, resolve} from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import {readToolSettings, subscribeToolSettings} from '../tools/settings.ts';
import {
  agentLastUsed,
  agentStorageId as storageId,
  historyLastUsed,
  retainedPrimaryId,
  type RetainedAgent,
} from './retention-policy.ts';

const day = 24 * 60 * 60 * 1000;
export const agentRetentionIntervalMs = 60 * 60 * 1000;
const ownerPattern = /^\.owner-(\d+)-[a-f0-9-]+$/;

export function agentHistoryCutoff(days: number, now = Date.now()): number {
  if (!Number.isSafeInteger(days) || days < 1 || days > 365)
    throw new Error('Agent history retention must be 1 to 365 days.');
  return now - days * day;
}

function rootPath(agentDir: string): string {
  return join(agentDir, 'varisdev', 'agents');
}

function parentPath(agentDir: string, sessionId: string): string {
  if (!storageId.test(sessionId)) throw new Error('Invalid agent session ID.');
  return join(rootPath(agentDir), sessionId);
}

function directory(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function withParentLock<T>(
  agentDir: string,
  sessionId: string,
  action: () => T,
  wait = false,
): T | undefined {
  const root = rootPath(agentDir);
  const path = parentPath(agentDir, sessionId);
  mkdirSync(root, {recursive: true});
  const until = Date.now() + 2000;
  let release: (() => void) | undefined;
  do {
    try {
      release = lockfile.lockSync(path, {
        realpath: false,
        lockfilePath: join(root, `.retention-${sessionId}.lock`),
        stale: 300000,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      if (!wait) return undefined;
      if (Date.now() >= until)
        throw new Error(
          'Agent history is busy. Try opening the session again.',
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } while (!release);
  try {
    return action();
  } finally {
    release();
  }
}

/** Unknown process state is protected; only a definitely dead owner is removed. */
function owners(path: string): string[] {
  const live: string[] = [];
  for (const name of readdirSync(path)) {
    if (!name.startsWith('.owner-')) continue;
    const match = ownerPattern.exec(name);
    const pid = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(pid) || pid < 1) {
      live.push(name);
      continue;
    }
    try {
      process.kill(pid, 0);
      live.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        rmSync(join(path, name), {force: true});
      else live.push(name);
    }
  }
  return live;
}

export interface AgentHistoryPruner {
  isExpired(id: string, before: number): boolean;
  remove(id: string, before: number): boolean;
}

export interface AgentHistoryLease {
  prune(action: (files: AgentHistoryPruner) => Promise<void>): Promise<boolean>;
  release(): void;
}

function registerOwner(path: string, marker: string): void {
  mkdirSync(path, {recursive: true});
  if (!directory(path)) throw new Error('Agent history must be a directory.');
  writeFileSync(join(path, marker), '', {flag: 'wx', mode: 0o600});
}

function historyLease(
  agentDir: string,
  sessionId: string,
  marker: string,
): AgentHistoryLease {
  const path = parentPath(agentDir, sessionId);
  let released = false;
  const isExpired = (id: string, before: number): boolean => {
    if (!storageId.test(id)) return false;
    const worker = join(path, id);
    if (!existsSync(worker)) return true;
    return directory(worker) && newestContent(worker) <= before;
  };
  return {
    async prune(action) {
      if (released) return false;
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(path, {
          realpath: false,
          lockfilePath: join(
            rootPath(agentDir),
            `.retention-${sessionId}.lock`,
          ),
          stale: 300000,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return false;
        throw error;
      }
      try {
        if (
          released ||
          !directory(path) ||
          owners(path).some(name => name !== marker)
        )
          return false;
        const used = historyLastUsed(
          historyAt(join(path, 'history.json'), sessionId) ?? {},
        );
        const expired = (id: string, before: number) =>
          (used.has(id) ? Date.parse(used.get(id)!) : 0) <= before &&
          isExpired(id, before);
        await action({
          isExpired: expired,
          remove(id, before) {
            if (!expired(id, before)) return false;
            rmSync(join(path, id), {recursive: true, force: true});
            return true;
          },
        });
        return true;
      } finally {
        await release();
      }
    },
    release() {
      if (released) return;
      withParentLock(
        agentDir,
        sessionId,
        () => {
          rmSync(join(path, marker), {force: true});
        },
        true,
      );
      released = true;
    },
  };
}

/** Register before restoring a parent and retain ownership through its final save. */
export function claimAgentHistory(
  agentDir: string,
  sessionId: string,
): AgentHistoryLease {
  const marker = `.owner-${process.pid}-${randomUUID()}`;
  withParentLock(
    agentDir,
    sessionId,
    () => registerOwner(parentPath(agentDir, sessionId), marker),
    true,
  );
  return historyLease(agentDir, sessionId, marker);
}

/** Opening a workspace can wait without blocking an in-process cleanup transaction. */
export async function claimAgentHistoryAsync(
  agentDir: string,
  sessionId: string,
): Promise<AgentHistoryLease> {
  const path = parentPath(agentDir, sessionId);
  mkdirSync(rootPath(agentDir), {recursive: true});
  const release = await lockfile.lock(path, {
    realpath: false,
    lockfilePath: join(rootPath(agentDir), `.retention-${sessionId}.lock`),
    stale: 300000,
    retries: {retries: 200, factor: 1, minTimeout: 25, maxTimeout: 25},
  });
  const marker = `.owner-${process.pid}-${randomUUID()}`;
  try {
    registerOwner(path, marker);
  } finally {
    await release();
  }
  return historyLease(agentDir, sessionId, marker);
}

function newestContent(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return Infinity;
  if (info.isFile()) return info.mtimeMs;
  if (!info.isDirectory()) return Infinity;
  const children = readdirSync(path);
  let latest = children.length ? 0 : info.mtimeMs;
  for (const name of children)
    latest = Math.max(latest, newestContent(join(path, name)));
  return latest;
}

interface StoredAgent extends RetainedAgent {
  startedAt?: string;
}
interface StoredHistory {
  version: number;
  sessionId: string;
  agents: StoredAgent[];
  configurations: Record<string, unknown>;
  [key: string]: unknown;
}

function historyAt(path: string, sessionId: string): StoredHistory | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const history = JSON.parse(readFileSync(path, 'utf8')) as StoredHistory;
    if (
      !history ||
      typeof history !== 'object' ||
      Array.isArray(history) ||
      history.version !== 1 ||
      history.sessionId !== sessionId ||
      !Array.isArray(history.agents) ||
      !history.configurations ||
      typeof history.configurations !== 'object' ||
      Array.isArray(history.configurations) ||
      history.agents.some(
        agent =>
          !agent || typeof agent.id !== 'string' || !storageId.test(agent.id),
      )
    )
      return undefined;
    return history;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
}

function publishHistory(path: string, history: StoredHistory): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(history), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {force: true});
  }
}

/** Clean inactive parents without loading the images embedded in Pi transcripts. */
export async function pruneAgentHistory(
  agentDir: string,
  days: number,
  options: {now?: number; protectedSessions?: ReadonlySet<string>} = {},
): Promise<{workers: number; parents: number}> {
  const before = agentHistoryCutoff(days, options.now);
  const root = rootPath(agentDir);
  const result = {workers: 0, parents: 0};
  const failures: unknown[] = [];
  if (!directory(root)) return result;
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const sessionId = entry.name;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !storageId.test(sessionId) ||
      options.protectedSessions?.has(sessionId)
    )
      continue;
    try {
      withParentLock(agentDir, sessionId, () => {
        const path = parentPath(agentDir, sessionId);
        if (!directory(path) || owners(path).length) return;
        const file = join(path, 'history.json');
        let releaseWrite: () => void;
        try {
          releaseWrite = lockfile.lockSync(file, {
            realpath: false,
            lockfilePath: join(root, `.history-${sessionId}.lock`),
            stale: 300000,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return;
          throw error;
        }
        try {
          const history = historyAt(file, sessionId);
          const lastUse = historyLastUsed(history ?? {});
          if (history)
            history.agents = history.agents.map(agent => ({
              ...agent,
              lastUsedAt: lastUse.get(agent.id) ?? agent.lastUsedAt,
            }));
          const records = new Map(
            history?.agents.map(agent => [agent.id, agent]),
          );
          const removed = new Set<string>();
          const workers = readdirSync(path, {withFileTypes: true}).filter(
            child =>
              child.isDirectory() &&
              !child.isSymbolicLink() &&
              storageId.test(child.name),
          );
          const primary = retainedPrimaryId(
            history?.agents ??
              workers.map(child => ({
                id: child.name,
                lastUsedAt: lastUse.get(child.name),
                createdAt: new Date(
                  lstatSync(join(path, child.name)).mtimeMs,
                ).toISOString(),
              })),
          );
          for (const child of workers) {
            if (child.name === primary) continue;
            const worker = join(path, child.name);
            const record = records.get(child.name);
            const used = record ? agentLastUsed(record) : 0;
            const latest = Math.max(
              newestContent(worker),
              Number.isFinite(used) ? used : 0,
              lastUse.has(child.name)
                ? Date.parse(lastUse.get(child.name)!)
                : 0,
            );
            if (latest > before) continue;
            rmSync(worker, {recursive: true, force: true});
            removed.add(child.name);
            result.workers++;
          }
          if (history) {
            for (const agent of history.agents) {
              if (agent.id === primary || existsSync(join(path, agent.id)))
                continue;
              const used = agentLastUsed(agent);
              const latest = Number.isFinite(used)
                ? used
                : lstatSync(file).mtimeMs;
              if (latest <= before) removed.add(agent.id);
            }
            if (removed.size) {
              history.agents = history.agents.filter(
                agent => !removed.has(agent.id),
              );
              for (const id of removed) {
                delete history.configurations[id];
                lastUse.delete(id);
              }
            }
            const remaining = new Set([
              ...history.agents.map(agent => agent.id),
              ...workers
                .map(child => child.name)
                .filter(id => !removed.has(id)),
            ]);
            for (const id of lastUse.keys())
              if (!remaining.has(id)) lastUse.delete(id);
            history.lastUsed = Object.fromEntries(lastUse);
            if (removed.size) {
              if (history.agents.length || lastUse.size)
                publishHistory(file, history);
              else rmSync(file, {force: true});
            }
          }
          if (
            (!history || (!history.agents.length && !lastUse.size)) &&
            existsSync(file) &&
            lstatSync(file).isFile() &&
            lstatSync(file).mtimeMs <= before
          )
            rmSync(file, {force: true});
          // Remove abandoned atomic-save files after the same retention period.
          for (const child of readdirSync(path, {withFileTypes: true})) {
            if (
              child.isFile() &&
              /^history\.json\.[a-f0-9-]+\.tmp$/.test(child.name) &&
              lstatSync(join(path, child.name)).mtimeMs <= before
            )
              rmSync(join(path, child.name), {force: true});
          }
          if (!readdirSync(path).length) {
            rmSync(path, {recursive: true});
            result.parents++;
          }
        } finally {
          releaseWrite();
        }
      });
    } catch (error) {
      failures.push(error);
    }
    await yieldTurn();
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      'Some expired agent history could not be removed.',
    );
  return result;
}

interface RetentionService {
  users: Set<(before: number) => Promise<void>>;
  run: () => Promise<void>;
  idle: () => Promise<void>;
  stop: () => void;
}
const services = new Map<string, RetentionService>();

/** One startup/periodic sweep per profile, shared by its open workspaces. */
export function watchAgentHistory(
  agentDir: string,
  expire: (before: number) => Promise<void>,
): {ready: Promise<void>; close: () => Promise<void>} {
  const key = resolve(agentDir);
  let service = services.get(key);
  if (!service) {
    const users: RetentionService['users'] = new Set();
    let running: Promise<void> | undefined;
    let again = false;
    const run = (): Promise<void> => {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          const settings = await readToolSettings(agentDir);
          const days = settings.agents.historyRetentionDays;
          const before = agentHistoryCutoff(days);
          for (const user of [...users]) {
            if (!users.has(user)) continue;
            try {
              await user(before);
            } catch (error) {
              console.error(
                'Could not clean an open workspace’s agent history:',
                error,
              );
            }
          }
          await pruneAgentHistory(agentDir, days);
        } while (again && users.size);
      })()
        .catch(error => {
          console.error('Could not clean expired agent history:', error);
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    };
    const timer = setInterval(() => {
      void run();
    }, agentRetentionIntervalMs);
    timer.unref();
    const unsubscribe = subscribeToolSettings(() => {
      void run();
    });
    const settingsFile = join(agentDir, 'varisdev', 'tool-settings.json');
    const settingsChanged = () => {
      void run();
    };
    watchFile(
      settingsFile,
      {persistent: false, interval: 1000},
      settingsChanged,
    );
    service = {
      users,
      run,
      idle: () => running ?? Promise.resolve(),
      stop: () => {
        clearInterval(timer);
        unsubscribe();
        unwatchFile(settingsFile, settingsChanged);
      },
    };
    services.set(key, service);
  }
  const active = service;
  active.users.add(expire);
  const ready = active.run();
  return {
    ready,
    async close() {
      active.users.delete(expire);
      if (!active.users.size) {
        active.stop();
        services.delete(key);
      }
      await active.idle();
    },
  };
}
