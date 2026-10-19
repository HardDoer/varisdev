import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';

export const OPENAI_IMAGE_PRESETS = [
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    description: 'Best editing precision',
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    description: 'Fast, high-quality everyday images',
  },
  {id: 'gpt-image-2', label: 'GPT Image 2', description: ''},
  {id: 'gpt-image-1.5', label: 'GPT Image 1.5', description: ''},
  {id: 'gpt-image-1', label: 'GPT Image 1', description: ''},
  {
    id: 'gpt-image-1-mini',
    label: 'GPT Image 1 Mini',
    description: 'Lower cost',
  },
] as const;
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare';
const tools = {
  'openai-image': {label: 'OpenAI images', environment: 'OPENAI_IMAGE_MODEL'},
};
type ToolModel = keyof typeof tools;

function modelPath(tool: ToolModel): string {
  return join(getAgentDir(), 'varisdev', 'tool-models', `${tool}.json`);
}
function validate(model: string): string {
  model = model.trim();
  if (model.length > 256 || /\s/.test(model))
    throw new Error(
      'Model IDs must have no spaces and at most 256 characters.',
    );
  return model;
}
async function readModel(path: string): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as {model?: unknown};
    if (typeof saved.model !== 'string')
      throw new Error('Invalid saved tool model.');
    return validate(saved.model);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}
async function writeModel(
  path: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!model) {
    await rm(path, {force: true});
    return;
  }
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({model}) + '\n', {mode: 0o600});
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, {force: true});
  }
}

export async function getToolModels() {
  return Promise.all(
    Object.entries(tools).map(async ([id, info]) => ({
      id,
      label: info.label,
      model: await readModel(modelPath(id as ToolModel)),
      presets: OPENAI_IMAGE_PRESETS,
      defaultModel: DEFAULT_IMAGE_MODEL,
      environment: process.env[info.environment]?.trim()
        ? info.environment
        : undefined,
    })),
  );
}

export async function saveToolModel(
  tool: unknown,
  value: unknown,
): Promise<void> {
  if (
    typeof tool !== 'string' ||
    !Object.hasOwn(tools, tool) ||
    typeof value !== 'string'
  )
    throw new Error('Choose a valid tool and model.');
  const model = validate(value);
  if (model && !OPENAI_IMAGE_PRESETS.some(preset => preset.id === model))
    throw new Error('Choose an OpenAI image model from the presets.');
  const path = modelPath(tool as ToolModel);
  await withFileMutationQueue(path, () => writeModel(path, model));
}

/** Ask once when a tool has no user-selected model, then reuse the saved choice. */
export async function selectToolModel(
  tool: ToolModel,
  requested: string | undefined,
  ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const {label, environment} = tools[tool];
  const explicit = requested?.trim() || process.env[environment]?.trim();
  if (explicit) return validate(explicit);
  const path = modelPath(tool);
  return withFileMutationQueue(path, async () => {
    signal?.throwIfAborted();
    const saved = await readModel(path);
    if (saved) return saved;
    if (!ctx.hasUI) return DEFAULT_IMAGE_MODEL;
    const labels = OPENAI_IMAGE_PRESETS.map(
      preset =>
        `${preset.label}${preset.description ? ` — ${preset.description}` : ''}`,
    );
    const choice = await ctx.ui.select(
      'Choose an OpenAI image model. Saved in Menu → Tool models.',
      labels,
      {signal},
    );
    signal?.throwIfAborted();
    if (!choice)
      throw new Error(`${label} setup cancelled. No request was sent.`);
    const preset = OPENAI_IMAGE_PRESETS[labels.indexOf(choice)];
    if (!preset)
      throw new Error('Choose an OpenAI image model from the presets.');
    const model = preset.id;
    await writeModel(path, model, signal);
    return model;
  });
}
