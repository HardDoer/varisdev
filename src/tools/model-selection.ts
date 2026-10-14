import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname, join} from 'node:path';

const tools = {
  'openai-image': {label: 'OpenAI images', environment: 'OPENAI_IMAGE_MODEL'},
  'elevenlabs-speech': {
    label: 'ElevenLabs speech',
    environment: 'ELEVENLABS_SPEECH_MODEL',
  },
  'elevenlabs-effects': {
    label: 'ElevenLabs sound effects',
    environment: 'ELEVENLABS_EFFECTS_MODEL',
  },
};
type ToolModel = keyof typeof tools;

function modelPath(tool: ToolModel): string {
  return join(getAgentDir(), 'varisdev', 'tool-models', `${tool}.json`);
}
function validate(model: string): string {
  model = model.trim();
  if (model.length > 256 || /\s/.test(model))
    throw new Error('Enter a model ID without spaces, up to 256 characters.');
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
    if (!ctx.hasUI)
      throw new Error(
        `${label} needs a model choice before its first use. Set it in Accounts → Tool models, specify it in the request, or set ${environment}.`,
      );
    const choice = await ctx.ui.input(
      `${label} needs its own model. Choose one now; it will be saved for future requests.`,
      'Model ID',
      {signal},
    );
    signal?.throwIfAborted();
    if (!choice?.trim())
      throw new Error(`${label} setup cancelled. No request was sent.`);
    const model = validate(choice);
    await writeModel(path, model, signal);
    return model;
  });
}
