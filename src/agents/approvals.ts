import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {realpathSync, renameSync, unlinkSync} from 'node:fs';
import {mkdir, open, readFile} from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import {basename, dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export type AgentApprovalChoice = 'once' | 'conversation' | 'agent' | 'deny';
export type AgentApprovalDecision = boolean | AgentApprovalChoice;
export interface AgentApprovalScope {
  agentId: string;
  conversationId: string;
  workspace: string;
}
export interface AgentApprovalOperation {
  toolName: string;
  action: string;
  resource: string;
  aliases?: readonly string[];
  input: Readonly<Record<string, unknown>>;
}
export interface AgentApprovalGrant {
  id: string;
  scope: 'conversation' | 'agent';
  agentId: string;
  workspace: string;
  conversationId?: string;
  operation: AgentApprovalOperation;
  createdAt: string;
}

/** Resolve existing ancestors so workspace aliases share the same identity. */
export function canonicalApprovalWorkspace(workspace: string): string {
  let path = resolve(workspace);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(path), ...missing);
    } catch (error) {
      if (!missingPath(error)) throw error;
      const parent = dirname(path);
      if (parent === path) return join(path, ...missing);
      missing.unshift(basename(path));
      path = parent;
    }
  }
}

function missingPath(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Tool inputs are JSON. Sort object keys without changing array order or values.
function stableJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

export function snapshotApprovalOperation(
  operation: AgentApprovalOperation,
): AgentApprovalOperation {
  return JSON.parse(
    stableJSON({
      toolName: operation.toolName,
      action: operation.action,
      resource: operation.resource,
      aliases: [...new Set(operation.aliases ?? [])].sort(),
      input: operation.input,
    }),
  ) as AgentApprovalOperation;
}

function sameOperation(a: AgentApprovalOperation, b: AgentApprovalOperation) {
  return (
    stableJSON(snapshotApprovalOperation(a)) ===
    stableJSON(snapshotApprovalOperation(b))
  );
}

function matchesScope(
  grant: AgentApprovalGrant,
  scope: Partial<AgentApprovalScope>,
): boolean {
  return (
    (scope.agentId === undefined || grant.agentId === scope.agentId) &&
    (scope.workspace === undefined ||
      grant.workspace === canonicalApprovalWorkspace(scope.workspace)) &&
    (scope.conversationId === undefined ||
      grant.conversationId === scope.conversationId)
  );
}

function validGrant(value: unknown): value is AgentApprovalGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as AgentApprovalGrant;
  const op = grant.operation;
  return (
    typeof grant.id === 'string' &&
    (grant.scope === 'agent' || grant.scope === 'conversation') &&
    typeof grant.agentId === 'string' &&
    typeof grant.workspace === 'string' &&
    typeof grant.createdAt === 'string' &&
    (grant.scope === 'agent'
      ? grant.conversationId === undefined
      : typeof grant.conversationId === 'string') &&
    !!op &&
    typeof op.toolName === 'string' &&
    typeof op.action === 'string' &&
    typeof op.resource === 'string' &&
    (op.aliases === undefined ||
      (Array.isArray(op.aliases) &&
        op.aliases.every(alias => typeof alias === 'string'))) &&
    !!op.input &&
    typeof op.input === 'object' &&
    !Array.isArray(op.input)
  );
}

/** Exact grants shared by desktop and terminal processes. Reads never use a cache. */
export class AgentApprovalStore {
  readonly path: string;

  constructor(path = join(getAgentDir(), 'varisdev', 'approvals.json')) {
    this.path = resolve(path);
  }

  async list(
    scope: Partial<AgentApprovalScope> = {},
  ): Promise<AgentApprovalGrant[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== 'object' ||
      (data as {version?: unknown}).version !== 1 ||
      !Array.isArray((data as {grants?: unknown}).grants)
    )
      throw new Error('Invalid remembered approval store.');
    const grants = (data as {grants: unknown[]}).grants;
    if (!grants.every(validGrant))
      throw new Error('Invalid remembered approval grant.');
    return grants.filter(grant => matchesScope(grant, scope));
  }

  async allows(
    scope: AgentApprovalScope,
    operation: AgentApprovalOperation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const grants = await this.list({
      agentId: scope.agentId,
      workspace: scope.workspace,
    });
    signal?.throwIfAborted();
    return grants.some(
      grant =>
        (grant.scope === 'agent' ||
          grant.conversationId === scope.conversationId) &&
        sameOperation(grant.operation, operation),
    );
  }

  async remember(
    scope: AgentApprovalScope,
    operation: AgentApprovalOperation,
    duration: 'conversation' | 'agent',
    signal?: AbortSignal,
  ): Promise<AgentApprovalGrant> {
    if (!scope.agentId || !scope.workspace || !scope.conversationId)
      throw new Error(
        'Remembered approvals require an agent, workspace, and conversation.',
      );
    const grant: AgentApprovalGrant = {
      id: randomUUID(),
      scope: duration,
      agentId: scope.agentId,
      workspace: canonicalApprovalWorkspace(scope.workspace),
      ...(duration === 'conversation'
        ? {conversationId: scope.conversationId}
        : {}),
      operation: snapshotApprovalOperation(operation),
      createdAt: new Date().toISOString(),
    };
    return this.update(grants => {
      const existing = grants.find(
        entry =>
          entry.scope === grant.scope &&
          entry.agentId === grant.agentId &&
          entry.workspace === grant.workspace &&
          entry.conversationId === grant.conversationId &&
          sameOperation(entry.operation, grant.operation),
      );
      if (existing) return {grants, result: existing};
      return {grants: [...grants, grant], result: grant};
    }, signal);
  }

  async revoke(id: string, signal?: AbortSignal): Promise<boolean> {
    return this.update(grants => {
      const remaining = grants.filter(grant => grant.id !== id);
      return {grants: remaining, result: remaining.length !== grants.length};
    }, signal);
  }

  async clear(
    scope: Partial<AgentApprovalScope> = {},
    signal?: AbortSignal,
  ): Promise<number> {
    return this.update(grants => {
      const remaining = grants.filter(grant => !matchesScope(grant, scope));
      return {grants: remaining, result: grants.length - remaining.length};
    }, signal);
  }

  private async update<T>(
    change: (grants: AgentApprovalGrant[]) => {
      grants: AgentApprovalGrant[];
      result: T;
    },
    signal?: AbortSignal,
  ): Promise<T> {
    const lock = await this.lock(signal);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      lock.check();
      const previous = await this.list();
      lock.check();
      const {grants, result} = change(previous);
      if (stableJSON(grants) !== stableJSON(previous)) {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify({version: 1, grants}) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        lock.check();
        // Commit synchronously after the abort check: cancellation cannot run
        // between the check and publishing the new store.
        renameSync(temporary, this.path);
      }
      return result;
    } finally {
      try {
        removeIfPresent(temporary);
      } finally {
        lock.release();
      }
    }
  }

  private async lock(signal?: AbortSignal): Promise<{
    release(): void;
    check(): void;
  }> {
    signal?.throwIfAborted();
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    const deadline = Date.now() + 10_000;
    let permissionRetries = 0;
    for (;;) {
      signal?.throwIfAborted();
      let compromised: Error | undefined;
      try {
        const release = lockfile.lockSync(this.path, {
          realpath: false,
          retries: 0,
          stale: 5000,
          update: 1000,
          onCompromised: error => {
            compromised = error;
          },
        });
        return {
          release() {
            if (!compromised) release();
          },
          check() {
            signal?.throwIfAborted();
            if (compromised) throw compromised;
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        const retryable =
          code === 'ELOCKED' ||
          (code === 'EPERM' &&
            process.platform === 'win32' &&
            ++permissionRetries <= 5);
        if (!retryable) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(
            'Timed out waiting for remembered approval storage lock.',
            {cause: error},
          );
        await delay(Math.min(25 + Math.random() * 25, remaining), undefined, {
          signal,
        });
      }
    }
  }
}

export function defaultAgentApprovalStore(): AgentApprovalStore {
  return new AgentApprovalStore();
}
