import {isAvailablePrimary} from '../dashboard/primary-availability.ts';

export const agentStorageId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export interface RetainedAgent {
  id: string;
  agentMode?: string;
  resumable?: boolean;
  status?: string;
  createdAt?: string;
  finishedAt?: string;
  lastUsedAt?: string;
  creationOrder?: number;
}

export function agentLastUsed(agent: RetainedAgent): number {
  const times = [agent.lastUsedAt, agent.finishedAt, agent.createdAt]
    .map(value => Date.parse(value ?? ''))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : Infinity;
}

/** Usage survives snapshots written by owners with older or incomplete records. */
export function historyLastUsed(
  ...histories: Array<{
    agents?: unknown;
    lastUsed?: unknown;
  }>
): Map<string, string> {
  const used = new Map<string, string>();
  const add = (id: string, value: unknown) => {
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) return;
    if (!used.has(id) || at > Date.parse(used.get(id)!))
      used.set(id, new Date(at).toISOString());
  };
  for (const history of histories) {
    if (
      history.lastUsed &&
      typeof history.lastUsed === 'object' &&
      !Array.isArray(history.lastUsed)
    )
      for (const [id, at] of Object.entries(history.lastUsed)) add(id, at);
    if (Array.isArray(history.agents)) {
      for (const agent of history.agents) {
        if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string')
          continue;
        for (const key of ['createdAt', 'finishedAt', 'lastUsedAt'])
          add(agent.id, agent[key]);
      }
    }
  }
  return used;
}

/** Keep an available primary even when all of its work is older than retention. */
export function retainedPrimaryId(
  agents: readonly RetainedAgent[],
): string | undefined {
  const available = agents.filter(isAvailablePrimary);
  const candidates = available.length
    ? available
    : agents.filter(agent => agent.agentMode !== 'subagent');
  return candidates
    .toSorted(
      (a, b) =>
        agentLastUsed(a) - agentLastUsed(b) ||
        (a.creationOrder ?? 0) - (b.creationOrder ?? 0),
    )
    .at(-1)?.id;
}
