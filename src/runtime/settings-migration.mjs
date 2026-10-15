import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';

// Only the former global settings profile, never app files or another harness.
const profileEntries = [
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
  'settings.json',
  'auth.json',
  'models.json',
  'models-store.json',
  'trust.json',
  'keybindings.json',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'sessions',
  'npm',
  'git',
  'bin',
  'tools',
  'agents',
  'varisdev',
  'package.json',
  'package-lock.json',
  'node_modules',
];

/** Keep configured resource paths valid after changing their settings base. */
function rebaseSettings(contents, root, directory, entries) {
  const settings = JSON.parse(contents.replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return contents;
  function resource(value) {
    if (typeof value !== 'string') return value;
    const prefix = /^[!+-]/.test(value) ? value[0] : '';
    let path = value.slice(prefix.length);
    if (/^(?:npm:|git:|https?:\/\/|ssh:\/\/)/.test(path)) return value;
    if (path === '~') path = dirname(root);
    else if (/^~[/\\]/.test(path)) path = join(dirname(root), path.slice(2));
    const absolute = resolve(root, path);
    const local = relative(root, absolute);
    const target = entries.includes(local.split(sep)[0])
      ? resolve(directory, local)
      : absolute;
    return prefix + target;
  }
  for (const key of ['extensions', 'skills', 'prompts', 'themes']) {
    if (Array.isArray(settings[key]))
      settings[key] = settings[key].map(resource);
  }
  if (Array.isArray(settings.packages)) {
    settings.packages = settings.packages.map(entry =>
      typeof entry === 'string'
        ? resource(entry)
        : entry && typeof entry === 'object'
          ? {...entry, source: resource(entry.source)}
          : entry,
    );
  }
  return JSON.stringify(settings, null, 2) + '\n';
}

/**
 * Copy a legacy flat VarisDev profile once, before Pi opens any settings files.
 * Publish only a complete profile, keep the originals, and never merge into or
 * overwrite an existing agent directory. Custom settings directories stay put.
 * @param {string} root
 * @param {string} directory
 */
export function migrateSettings(root, directory) {
  if (existsSync(directory)) return;
  const entries = profileEntries.filter(name => existsSync(join(root, name)));
  if (!entries.length) return;
  const temporary = mkdtempSync(join(root, '.agent-migration-'));
  try {
    for (const name of entries) {
      cpSync(join(root, name), join(temporary, name), {
        recursive: true,
        // Config files must be independent copies, including symlinked files.
        dereference: name.endsWith('.json') || name.endsWith('.md'),
        preserveTimestamps: true,
      });
    }
    if (entries.includes('settings.json')) {
      const file = join(temporary, 'settings.json');
      writeFileSync(
        file,
        rebaseSettings(readFileSync(file, 'utf8'), root, directory, entries),
      );
    }
    try {
      renameSync(temporary, directory);
    } catch (error) {
      // Another starting process may have published its complete copy first.
      if (!existsSync(directory)) throw error;
    }
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
}
