import type {SessionEntry} from '@earendil-works/pi-coding-agent';

export interface ModelUsageCall {
  id: string;
  at: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  toolNames: string[];
  stopReason?: string;
  kind?: 'response' | 'compaction' | 'usage';
  /** SDK usage-entry category, such as cache_warm. */
  usageKind?: string;
}

export interface ModelUsage {
  source: 'provider';
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  calls: ModelUsageCall[];
  truncated: boolean;
}

function emptyUsage(): ModelUsage {
  return {
    source: 'provider',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    calls: [],
    truncated: false,
  };
}

const usageFields = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'totalTokens',
  'cost',
] as const;

function preview(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n[Preview truncated]`
    : text;
}

export function copyModelUsage(usage: ModelUsage): ModelUsage {
  return {
    ...usage,
    calls: usage.calls.map(call => ({...call, toolNames: [...call.toolNames]})),
  };
}

function measuredNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** SDK usage contains provider token counts and configured model pricing costs. */
export function modelUsage(
  message: {
    usage?: unknown;
    provider?: string;
    model?: string;
    responseModel?: string;
    content?: unknown;
    stopReason?: string;
  },
  identity: {id: string; at: string},
): ModelUsageCall | undefined {
  if (!message.usage || typeof message.usage !== 'object') return;
  const usage = message.usage as Record<string, unknown>;
  if (
    !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some(field =>
      measuredNumber(usage[field]),
    )
  )
    return;
  const input = measuredNumber(usage.input) ? usage.input : 0;
  const output = measuredNumber(usage.output) ? usage.output : 0;
  const cacheRead = measuredNumber(usage.cacheRead) ? usage.cacheRead : 0;
  const cacheWrite = measuredNumber(usage.cacheWrite) ? usage.cacheWrite : 0;
  const cost =
    usage.cost && typeof usage.cost === 'object'
      ? (usage.cost as Record<string, unknown>)
      : {};
  return {
    id: identity.id,
    at: identity.at,
    model:
      [message.provider, message.responseModel ?? message.model]
        .filter(Boolean)
        .join('/') || 'Unknown model',
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: measuredNumber(usage.totalTokens)
      ? usage.totalTokens
      : input + output + cacheRead + cacheWrite,
    cost: measuredNumber(cost.total)
      ? cost.total
      : ['input', 'output', 'cacheRead', 'cacheWrite'].reduce(
          (total, field) =>
            total + (measuredNumber(cost[field]) ? cost[field] : 0),
          0,
        ),
    toolNames: Array.isArray(message.content)
      ? message.content
          .filter(
            part => part?.type === 'toolCall' && typeof part.name === 'string',
          )
          .map(part => part.name)
      : [],
    stopReason: message.stopReason?.slice(0, 100),
  };
}

/** Model-attributed SDK work persisted outside assistant messages. */
export function persistedUsage(entry: {
  id: string;
  timestamp: string;
  kind: string;
  provider: string;
  model: string;
  usage?: unknown;
}): ModelUsageCall | undefined {
  const call = modelUsage(
    {usage: entry.usage, provider: entry.provider, model: entry.model},
    {id: `usage-${entry.id}`, at: entry.timestamp},
  );
  return call
    ? {...call, kind: 'usage', usageKind: entry.kind.slice(0, 100)}
    : undefined;
}

/** Successful SDK summaries can report one aggregate for several model calls. */
export function compactionUsage(
  entry: {id: string; timestamp: string; usage?: unknown},
  model = 'Compaction',
): ModelUsageCall | undefined {
  const call = modelUsage(
    {usage: entry.usage, model},
    {
      id: `compaction-${entry.id}`,
      at: entry.timestamp,
    },
  );
  return call ? {...call, kind: 'compaction'} : undefined;
}

/** Project assistant, compaction, and standalone persisted usage calls. */
export function* sessionUsageCalls(
  entries: readonly SessionEntry[],
): Generator<{call: ModelUsageCall; sequence: number}> {
  let responseSequence = 0;
  let compactionSequence = 0;
  let usageSequence = 0;
  let summaryModel: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'model_change')
      summaryModel = `${entry.provider}/${entry.modelId}`;
    if (entry.type === 'usage') {
      usageSequence++;
      const call = persistedUsage(entry);
      if (call) yield {call, sequence: usageSequence};
      continue;
    }
    if (entry.type === 'compaction') {
      compactionSequence++;
      const call = compactionUsage(entry, summaryModel);
      if (call) yield {call, sequence: compactionSequence};
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    responseSequence++;
    if (message.role !== 'assistant') continue;
    const call = modelUsage(message, {
      id: `message-assistant-${message.timestamp}-${responseSequence}`,
      at: new Date(message.timestamp).toISOString(),
    });
    if (call) yield {call, sequence: responseSequence};
  }
}

type TrackedUsageKind = NonNullable<ModelUsageCall['kind']>;

/** Keeps every recorded count while retaining the latest 100 responses and summaries. */
export class ModelUsageTracker {
  private value = emptyUsage();
  private sequences: Record<TrackedUsageKind, number> = {
    response: 0,
    compaction: 0,
    usage: 0,
  };

  record(call: ModelUsageCall, sequence: number): boolean {
    const index = this.value.calls.findIndex(item => item.id === call.id);
    const previous = this.value.calls[index];
    // Old calls remain in the totals after their display rows have been dropped.
    const kind = call.kind ?? 'response';
    if (!previous && sequence <= this.sequences[kind]) return false;
    const entry = {
      ...call,
      model: preview(call.model, 300),
      toolNames: [...new Set(call.toolNames)]
        .slice(0, 100)
        .map(name => preview(name, 200)),
    };
    if (previous && JSON.stringify(previous) === JSON.stringify(entry))
      return false;
    for (const field of usageFields)
      this.value[field] += entry[field] - (previous?.[field] ?? 0);
    if (index < 0) this.value.calls.push(entry);
    else this.value.calls[index] = entry;
    this.sequences[kind] = Math.max(this.sequences[kind], sequence);
    if (this.value.calls.length > 100) {
      this.value.calls.shift();
      this.value.truncated = true;
    }
    return true;
  }

  replace(calls: Iterable<{call: ModelUsageCall; sequence: number}>): void {
    this.value = emptyUsage();
    this.sequences = {response: 0, compaction: 0, usage: 0};
    for (const {call, sequence} of calls) this.record(call, sequence);
  }

  snapshot(): ModelUsage {
    return copyModelUsage(this.value);
  }
}
