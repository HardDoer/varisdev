import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export interface ToolSettings {
  agents: {allowedModels: string[] | null};
  commit: {
    model: string | null;
    thinkingLevel:
      'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  };
}

const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const writes = new Map<string, Promise<void>>();
const settingsPath = () =>
  join(getAgentDir(), 'varisdev', 'tool-settings.json');
const defaults = (): ToolSettings => ({
  agents: {allowedModels: []},
  commit: {model: null, thinkingLevel: null},
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

function agents(value: unknown): ToolSettings['agents'] {
  const {allowedModels} = object(value, ['allowedModels']);
  if (allowedModels === null) return {allowedModels: null};
  if (!Array.isArray(allowedModels) || allowedModels.length > 512)
    throw new Error('Choose up to 512 allowed models in Menu → Tool models.');
  return {allowedModels: [...new Set(Array.from(allowedModels, modelId))]};
}

function commit(value: unknown): ToolSettings['commit'] {
  const input = object(value, ['model', 'thinkingLevel']);
  const model = input.model === null ? null : modelId(input.model);
  if (
    input.thinkingLevel !== null &&
    (typeof input.thinkingLevel !== 'string' ||
      !efforts.includes(input.thinkingLevel))
  )
    throw new Error(
      'Commit thinkingLevel must be null, off, minimal, low, medium, high, xhigh, or max.',
    );
  return {
    model,
    thinkingLevel:
      input.thinkingLevel as ToolSettings['commit']['thinkingLevel'],
  };
}

function toolSettings(value: unknown): ToolSettings {
  const input = object(value, ['agents', 'commit']);
  return {agents: agents(input.agents), commit: commit(input.commit)};
}

export function parseToolSettingsUpdate(
  section: unknown,
  value: unknown,
): Partial<ToolSettings> {
  if (section === 'all') return toolSettings(value);
  if (section === 'agents') return {agents: agents(value)};
  if (section === 'commit') return {commit: commit(value)};
  throw new Error('Tool settings section must be agents, commit, or all.');
}

async function read(path: string): Promise<ToolSettings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 300000)
      throw new Error('Tool settings file is too large.');
    return toolSettings(JSON.parse(text));
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

export async function saveToolSettings(
  section: unknown,
  value: unknown,
): Promise<void> {
  // Validate and copy before waiting, so callers cannot change queued inputs.
  const update = parseToolSettingsUpdate(section, value);
  const path = settingsPath();
  const operation = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const settings = {...(await read(path)), ...update};
    if (settings.commit.model !== null) {
      if (
        section !== 'commit' &&
        settings.agents.allowedModels !== null &&
        !settings.agents.allowedModels.includes(settings.commit.model)
      )
        throw new Error(
          `Commit model ${settings.commit.model} must be allowed. Update Agent models or Commit in Menu → Tool models. Allowed models: ${settings.agents.allowedModels.join(', ')}.`,
        );
      await assertAgentModelAllowed(settings.commit.model, settings);
    }
    await mkdir(dirname(path), {recursive: true});
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, path);
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
): Promise<void> {
  modelId(model);
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
