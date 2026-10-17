import {open, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

export interface PluginTheme {
  id: string;
  name: string;
  base: string;
  colors: Record<string, string>;
  scenePalette?: Record<string, string>;
  css?: string;
  packageName: string;
  source: string;
}

export interface PluginThemesResult {
  themes: PluginTheme[];
  errors: string[];
}

const MAX_BYTES = 128 * 1024;
const MAX_THEMES = 64;
const BASES = new Set([
  'factory',
  'nord',
  'dracula',
  'catppuccin-mocha',
  'forest',
  'moss',
  'kimbie-dark',
  'solarized-light',
  'mint-paper',
  'glacier',
  'rose-quartz',
  'high-contrast',
]);
const COLORS = new Set([
  'bg',
  'panel',
  'panel-raised',
  'input',
  'line',
  'text',
  'muted',
  'mint',
  'cyan',
  'amber',
  'red',
  'violet',
  'rose',
  'accent',
  'link',
  'heading',
  'code',
  'message-user',
  'message-assistant',
  'action-read',
  'action-edit',
  'action-command',
  'action-web',
  'action-agent',
  'action-media',
  'diff-add',
  'diff-remove',
  'focus',
  'accent-text',
  'hover',
  'selected',
  'selection-bg',
  'selection-text',
  'selection-border',
  'status-running',
  'status-queued',
  'status-completed',
  'status-failed',
  'status-cancelling',
  'status-compacting',
  'status-cancelled',
  'robot-shell',
  'robot-outline',
  'robot-screen',
  'robot-eyes',
  'danger',
  'scene',
  'scene-glow',
  'page-glow',
]);
const SCENE_COLORS = new Set([
  'floor',
  'edge',
  'dark',
  'metal',
  'shell',
  'outline',
  'white',
  'eyes',
  'mint',
  'cyan',
  'amber',
  'red',
  'violet',
  'rose',
  'dim',
  'screen',
  'selection',
  'running',
  'queued',
  'completed',
  'failed',
  'cancelling',
  'compacting',
  'cancelled',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function resource(
  root: string,
  from: string,
  path: unknown,
): Promise<string> {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 512 ||
    isAbsolute(path)
  )
    throw new Error('resource path must be a relative path inside the package');
  const target = await realpath(resolve(from, path));
  const inside = relative(root, target);
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    throw new Error('resource path leaves the package');
  return target;
}

async function text(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('resource must be a file');
    if (stat.size > MAX_BYTES) throw new Error('file exceeds 128 KB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('file exceeds 128 KB');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    await file.close();
  }
}

function palette(
  value: unknown,
  allowed: Set<string>,
  field: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value)) throw new Error(`${field} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, color] of Object.entries(value)) {
    if (!allowed.has(key))
      throw new Error(`unknown ${field} key: ${key.slice(0, 80)}`);
    if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color))
      throw new Error(`${field}.${key} must be a six digit hex color`);
    result[key] = color;
  }
  return result;
}

/** Inspect installed registrations without resolving packages or loading extension code. */
export async function loadPluginThemes(options: {
  cwd: string;
  agentDir?: string;
}): Promise<PluginThemesResult> {
  const result: PluginThemesResult = {themes: [], errors: []};
  const error = (source: string, message: unknown) => {
    if (result.errors.length < MAX_THEMES)
      result.errors.push(
        `${source.slice(0, 256)}: ${String(message).slice(0, 512)}`,
      );
  };
  const agentDir = options.agentDir ?? getAgentDir();
  const settings = SettingsManager.create(options.cwd, agentDir);
  const manager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir,
    settingsManager: settings,
  });
  let packages;
  try {
    // Project registrations win when both scopes expose the same theme ID.
    packages = manager
      .listConfiguredPackages()
      .sort(
        (first, second) =>
          Number(second.scope === 'project') -
          Number(first.scope === 'project'),
      );
    for (const entry of settings.drainErrors())
      error('Theme settings', entry.error.message);
  } catch (cause) {
    error('Theme packages', cause instanceof Error ? cause.message : cause);
    return result;
  }
  const roots = new Set<string>();
  const ids = new Set<string>();
  let registrations = 0;
  for (const pkg of packages) {
    if (!pkg.installedPath) continue;
    let root;
    try {
      root = await realpath(pkg.installedPath);
    } catch {
      continue;
    }
    if (roots.has(root)) continue;
    roots.add(root);
    try {
      const manifestPath = await resource(root, root, './package.json');
      const manifest: unknown = JSON.parse(await text(manifestPath));
      if (!object(manifest) || manifest.varisdev === undefined) continue;
      if (!object(manifest.varisdev))
        throw new Error('varisdev must be an object');
      const paths = manifest.varisdev.themes;
      if (paths === undefined) continue;
      if (!Array.isArray(paths))
        throw new Error('varisdev.themes must be an array');
      const packageName =
        typeof manifest.name === 'string' && manifest.name.trim()
          ? manifest.name
          : pkg.source;
      if (packageName.length > 200)
        throw new Error('package name exceeds 200 characters');
      for (const path of paths) {
        if (registrations++ >= MAX_THEMES) {
          error(pkg.source, 'theme registration limit of 64 reached');
          return result;
        }
        const label = `${packageName} / ${String(path).slice(0, 128)}`;
        try {
          const themePath = await resource(root, root, path);
          const value: unknown = JSON.parse(await text(themePath));
          if (!object(value)) throw new Error('theme must be an object');
          if (
            typeof value.id !== 'string' ||
            !/^[a-z\d][a-z\d_-]{0,63}$/i.test(value.id)
          )
            throw new Error(
              'id must contain 1–64 letters, digits, underscores or dashes',
            );
          if (
            typeof value.name !== 'string' ||
            !value.name.trim() ||
            value.name.length > 100
          )
            throw new Error('name must contain 1–100 characters');
          const base = value.base ?? 'factory';
          if (typeof base !== 'string' || !BASES.has(base))
            throw new Error('unknown base theme');
          const entry: PluginTheme = {
            id: `plugin:${encodeURIComponent(packageName)}:${value.id}`,
            name: value.name,
            base,
            colors: palette(value.colors, COLORS, 'colors'),
            packageName,
            source: pkg.source.slice(0, 256),
          };
          if (value.scenePalette !== undefined)
            entry.scenePalette = palette(
              value.scenePalette,
              SCENE_COLORS,
              'scenePalette',
            );
          if (value.stylesheet !== undefined)
            entry.css = await text(
              await resource(root, dirname(themePath), value.stylesheet),
            );
          if (!ids.has(entry.id)) {
            ids.add(entry.id);
            result.themes.push(entry);
          }
        } catch (cause) {
          error(label, cause instanceof Error ? cause.message : cause);
        }
      }
    } catch (cause) {
      // Registered resource directories need not have a package manifest.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        error(pkg.source, cause instanceof Error ? cause.message : cause);
    }
  }
  return result;
}
