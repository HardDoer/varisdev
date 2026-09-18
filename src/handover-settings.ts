import {getAgentDir, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export type HandoverSettings = {
  'auto-handover': 'on' | 'off';
  'auto-session-refresh': 'on' | 'off';
};

type SettingKey = keyof HandoverSettings;

const defaults: HandoverSettings = {
  'auto-handover': 'on',
  'auto-session-refresh': 'on',
};
const settingKeys: SettingKey[] = ['auto-handover', 'auto-session-refresh'];
const pendingWrites = new Map<string, Promise<void>>();

function settingsError(path: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`VarisDev settings ${path}: ${message}`, {cause: error});
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw settingsError(path, error);
  }
  try {
    const config: unknown = JSON.parse(contents);
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Expected a JSON object.');
    }
    const values = config as Record<string, unknown>;
    for (const key of settingKeys) {
      if (
        Object.hasOwn(values, key) &&
        values[key] !== 'on' &&
        values[key] !== 'off'
      ) {
        throw new Error(`"${key}" must be "on" or "off".`);
      }
    }
    return values;
  } catch (error) {
    throw settingsError(path, error);
  }
}

export async function readHandoverSettings(
  cwd: string,
  agentDir: string = getAgentDir(),
): Promise<HandoverSettings> {
  const settings = {...defaults};
  for (const path of [
    join(agentDir, 'varisdev.json'),
    join(cwd, '.pi', 'varisdev.json'),
  ]) {
    const config = await readConfig(path);
    for (const key of settingKeys) {
      if (Object.hasOwn(config, key)) {
        settings[key] = config[key] as HandoverSettings[SettingKey];
      }
    }
  }
  return settings;
}

export async function writeHandoverSetting(
  cwd: string,
  key: SettingKey,
  value: HandoverSettings[SettingKey],
): Promise<void> {
  const path = resolve(cwd, '.pi', 'varisdev.json');
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(async () => {
      const config = await readConfig(path);
      config[key] = value;
      const tempPath = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(path), {recursive: true});
        await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        await rename(tempPath, path);
      } catch (error) {
        await rm(tempPath, {force: true}).catch(() => undefined);
        throw settingsError(path, error);
      }
    });
  pendingWrites.set(path, pending);
  try {
    await pending;
  } finally {
    if (pendingWrites.get(path) === pending) pendingWrites.delete(path);
  }
}

export function registerHandoverSettingsCommands(pi: ExtensionAPI): void {
  const descriptions: Record<SettingKey, string> = {
    'auto-handover':
      'Show settings or turn automatic handover prompts at 80% context on/off',
    'auto-session-refresh':
      'Show settings or turn fresh sessions after handovers on/off',
  };
  for (const key of settingKeys) {
    pi.registerCommand(key, {
      description: descriptions[key],
      handler: async (args, ctx) => {
        const value = args.trim();
        if (value !== '' && value !== 'on' && value !== 'off') {
          ctx.ui.notify(`Usage: /${key} [on|off]`, 'error');
          return;
        }
        try {
          let settings = await readHandoverSettings(ctx.cwd);
          if (value !== '') {
            await writeHandoverSetting(ctx.cwd, key, value);
            settings = await readHandoverSettings(ctx.cwd);
          }
          ctx.ui.notify(
            settingKeys.map(name => `${name}: ${settings[name]}`).join('\n'),
            'info',
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            'error',
          );
        }
      },
    });
  }
}
