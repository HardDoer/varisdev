import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export interface ToolSettings {
  agents: {allowedModels: string[] | null; maxConcurrentAgents: number};
}

interface ToolSettingsUpdate {
  agents?: {
    allowedModels: string[] | null;
    maxConcurrentAgents?: number;
  };
}

const writes = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<(settings: ToolSettings) => void>>();
const settingsPath = () =>
  join(getAgentDir(), 'varisdev', 'tool-settings.json');
const defaults = (): ToolSettings => ({
  agents: {allowedModels: [], maxConcurrentAgents: 6},
});

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))
  )
    throw new Error(`Tool settings must contain exactly: ${keys.join(', ')}.`);
  return value as Record<string, unknown>;
}

function modelId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    /[\s\p{Cc}\p{Cf}]/u.test(value) ||
    !/^[^/]+\/.+$/u.test(value)
  )
    throw new Error(
      'Agent model must use provider/model format, without whitespace or control characters, and at most 512 characters.',
    );
  return value;
}

function agents(value: unknown): NonNullable<ToolSettingsUpdate['agents']> {
  const keys = ['allowedModels'];
  if (
    value &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'maxConcurrentAgents')
  )
    keys.push('maxConcurrentAgents');
  const {allowedModels, maxConcurrentAgents} = object(value, keys);
  if (
    keys.includes('maxConcurrentAgents') &&
    (!Number.isSafeInteger(maxConcurrentAgents) ||
      Number(maxConcurrentAgents) < 1)
  )
    throw new Error(
      'Maximum concurrent agents must be a whole number of at least 1, including the main conversation.',
    );
  if (
    allowedModels !== null &&
    (!Array.isArray(allowedModels) || allowedModels.length > 512)
  )
    throw new Error('Choose up to 512 allowed models in Menu → Tool models.');
  return {
    allowedModels:
      allowedModels === null
        ? null
        : [...new Set(Array.from(allowedModels as unknown[], modelId))],
    ...(maxConcurrentAgents === undefined
      ? {}
      : {maxConcurrentAgents: maxConcurrentAgents as number}),
  };
}

function toolSettings(value: unknown): ToolSettingsUpdate {
  const input = object(value, ['agents']);
  return {agents: agents(input.agents)};
}

export function parseToolSettingsUpdate(
  section: unknown,
  value: unknown,
): ToolSettingsUpdate {
  if (section === 'all') return toolSettings(value);
  if (section === 'agents') return {agents: agents(value)};
  throw new Error('Tool settings section must be agents or all.');
}

async function read(path: string): Promise<ToolSettings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 300000)
      throw new Error('Tool settings file is too large.');
    const saved = JSON.parse(text);
    // Discard retired settings while preserving existing agent model choices.
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      delete saved.commit;
    return {agents: {...defaults().agents, ...toolSettings(saved).agents}};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
    throw new Error(
      `Cannot read tool settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {cause: error},
    );
  }
}

export async function readToolSettings(): Promise<ToolSettings> {
  const path = settingsPath();
  await writes.get(path);
  return read(path);
}

/** Observe explicit saves for the current settings directory. */
export function subscribeToolSettings(
  listener: (settings: ToolSettings) => void,
): () => void {
  const path = settingsPath();
  let subscribers = listeners.get(path);
  if (!subscribers) listeners.set(path, (subscribers = new Set()));
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(path);
  };
}

export async function saveToolSettings(
  section: unknown,
  value: unknown,
): Promise<void> {
  // Validate and copy before waiting, so callers cannot change queued inputs.
  const update = parseToolSettingsUpdate(section, value);
  const path = settingsPath();
  const operation = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const previous = await read(path);
    const settings: ToolSettings = {
      agents: {...previous.agents, ...update.agents},
    };
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, path);
      for (const listener of listeners.get(path) ?? []) {
        try {
          listener(structuredClone(settings));
        } catch (error) {
          console.error('Tool settings observer failed:', error);
        }
      }
    } finally {
      await rm(temporary, {force: true});
    }
  });
  const tail = operation.catch(() => {});
  writes.set(path, tail);
  void tail.then(() => {
    if (writes.get(path) === tail) writes.delete(path);
  });
  await operation;
}

export async function assertAgentModelAllowed(
  model: string,
  settings?: ToolSettings,
  pinnedModel?: string,
): Promise<void> {
  modelId(model);
  if (pinnedModel) {
    if (model !== pinnedModel)
      throw new Error(
        `This agent configuration requires model ${pinnedModel}.`,
      );
    return;
  }
  const {allowedModels} = (settings ?? (await readToolSettings())).agents;
  if (allowedModels?.length === 0)
    throw new Error(
      'No agent models selected. Choose a model in Menu → Tool models.',
    );
  if (allowedModels !== null && !allowedModels.includes(model))
    throw new Error(
      `Agent model ${model} is not allowed. Choose an allowed model explicitly or change Menu → Tool models. Allowed models: ${allowedModels.join(', ')}.`,
    );
}
