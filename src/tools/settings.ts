import {getAgentDir} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';

export interface ToolSettings {
  agents: {allowedModels: string[] | null};
  commit: {
    model: string | null;
    thinkingLevel:
      'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  };
}

const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const writes = new Map<string, Promise<void>>();
const settingsPath = () =>
  join(getAgentDir(), 'varisdev', 'tool-settings.json');
const defaults = (): ToolSettings => ({
  agents: {allowedModels: null},
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
  if (
    !Array.isArray(allowedModels) ||
    allowedModels.length === 0 ||
    allowedModels.length > 512
  )
    throw new Error(
      'Choose between 1 and 512 allowed models in Menu → Agent models, or use null to allow all models.',
    );
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
      'Commit thinkingLevel must be null, off, minimal, low, medium, high, or xhigh.',
    );
  return {
    model,
    thinkingLevel:
      input.thinkingLevel as ToolSettings['commit']['thinkingLevel'],
  };
}

async function read(path: string): Promise<ToolSettings> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length > 300000)
      throw new Error('Tool settings file is too large.');
    const input = object(JSON.parse(text), ['agents', 'commit']);
    return {agents: agents(input.agents), commit: commit(input.commit)};
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
  if (section !== 'agents' && section !== 'commit')
    throw new Error('Tool settings section must be agents or commit.');
  // Validate and copy before waiting, so callers cannot change queued inputs.
  const update =
    section === 'agents' ? {agents: agents(value)} : {commit: commit(value)};
  const path = settingsPath();
  const operation = (writes.get(path) ?? Promise.resolve()).then(async () => {
    const settings = {...(await read(path)), ...update};
    if (settings.commit.model !== null) {
      if (
        section === 'agents' &&
        settings.agents.allowedModels !== null &&
        !settings.agents.allowedModels.includes(settings.commit.model)
      )
        throw new Error(
          `Commit model ${settings.commit.model} must be allowed. Change Menu → Commit settings first, or include it in Menu → Agent models. Allowed models: ${settings.agents.allowedModels.join(', ')}.`,
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
  if (allowedModels !== null && !allowedModels.includes(model))
    throw new Error(
      `Agent model ${model} is not allowed. Choose an allowed model explicitly or change Menu → Agent models. Allowed models: ${allowedModels.join(', ')}.`,
    );
}
