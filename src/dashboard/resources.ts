import {readFileSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';

type ResourceSettings = ReturnType<SettingsManager['getGlobalSettings']>;
const resourceKinds = ['extensions', 'skills', 'prompts', 'themes'] as const;
type AppManifest = {
  repository?: string | {url?: string};
  pi?: Partial<Record<(typeof resourceKinds)[number], unknown>>;
};

function appResource(
  path: string,
  root: string,
  manifest?: AppManifest,
): boolean {
  if (path === root) return true;
  const entries = resourceKinds.flatMap(kind => {
    const values = manifest?.pi?.[kind];
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : [];
  });
  // Older installed app packages use these resource directories as well.
  if (!entries.length) entries.push('extensions', 'themes');
  return entries.some(entry => {
    if (entry.startsWith('!')) return false;
    const resource = canonicalPath(resolve(root, entry));
    const inside = relative(resource, path);
    return (
      (!isAbsolute(inside) &&
        inside !== '..' &&
        !inside.startsWith(`..${sep}`)) ||
      matchesGlob(relative(root, path), entry.replace(/^\.\//, ''))
    );
  });
}

function officialRepository(source: string): boolean {
  const normalized = source
    .trim()
    .replace(/^git:(?!\/\/)/i, '')
    .replace(/^git\+/i, '');
  return (
    /^(?:(?:https?|ssh|git):\/\/(?:git@)?|git@)?github\.com[/:]harddoer\/varisdev(?:\.git)?\/?(?:[@#].+)?$/i.test(
      normalized,
    ) || /^github:harddoer\/varisdev(?:[@#].+)?$/i.test(normalized)
  );
}

/** Recognize the published app's registrations without matching forks or similar names. */
export function isAppPackageSource(source: string): boolean {
  return (
    officialRepository(source) ||
    /^npm:varisdev(?:@[^\s]+)?$/i.test(source.trim())
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resourcePath(path: string, base: string): string {
  let value = path.replace(/^!/, '').replace(/^@(?=[./~])/, '');
  if (value === '~') value = homedir();
  else if (
    value.startsWith('~/') ||
    (process.platform === 'win32' && value.startsWith('~\\'))
  )
    value = join(homedir(), value.slice(2));
  if (value.startsWith('file://')) value = fileURLToPath(value);
  return canonicalPath(resolve(base, value));
}

/** A separate loader view keeps the saved package registry and session settings intact. */
export function createAppResourceFilter(
  settings: SettingsManager,
  cwd: string,
  agentDir: string,
): {
  settingsManager: SettingsManager;
  paths(paths: string[], base?: string): string[];
} {
  const packages = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });

  const installedRoots = () => {
    const roots = new Set<string>();
    for (const [scope, values] of [
      ['user', settings.getGlobalSettings()],
      ['project', settings.getProjectSettings()],
    ] as const) {
      for (const entry of values.packages ?? []) {
        const source = typeof entry === 'string' ? entry : entry.source;
        if (!isAppPackageSource(source)) continue;
        // Git installations made before repository metadata was added still have
        // a known identity in the registry. Reading their path does not install.
        if (officialRepository(source)) {
          try {
            const path = packages.getInstalledPath(source, scope);
            if (path) roots.add(canonicalPath(path));
          } catch {
            /* An untrusted project cannot supply resources. */
          }
        } else {
          // Avoid the SDK's legacy global npm lookup, which launches npm.
          const base = scope === 'user' ? agentDir : join(cwd, CONFIG_DIR_NAME);
          roots.add(
            canonicalPath(join(base, 'npm', 'node_modules', 'varisdev')),
          );
        }
      }
    }
    return roots;
  };

  const belongsToApp = (
    source: string,
    base: string,
    roots: Set<string>,
  ): boolean => {
    if (isAppPackageSource(source)) return true;
    // Pi treats file URLs as local resources.
    if (
      !source.startsWith('file://') &&
      ((/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) ||
        /^git@/i.test(source))
    )
      return false;
    let requested: string;
    try {
      requested = resourcePath(source, base);
    } catch {
      // Leave malformed file URLs for the SDK's resource diagnostics.
      return false;
    }
    let path = requested;
    while (true) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(path, 'package.json'), 'utf8'),
        ) as AppManifest;
        const repository =
          typeof manifest.repository === 'string'
            ? manifest.repository
            : manifest.repository?.url;
        // Stop at the nearest package boundary so another package inside an app
        // checkout remains available even if its parent has the app's identity.
        return (
          (roots.has(path) ||
            (typeof repository === 'string' &&
              officialRepository(repository))) &&
          appResource(requested, path, manifest)
        );
      } catch {
        if (roots.has(path)) return appResource(requested, path);
        /* Continue to the containing package for a resource file. */
      }
      const parent = dirname(path);
      if (parent === path) return false;
      path = parent;
    }
  };

  const filter = (values: ResourceSettings, base: string): ResourceSettings => {
    const roots = installedRoots();
    return {
      ...values,
      ...(values.packages
        ? {
            packages: values.packages.filter(
              entry =>
                !belongsToApp(
                  typeof entry === 'string' ? entry : entry.source,
                  base,
                  roots,
                ),
            ),
          }
        : {}),
      ...Object.fromEntries(
        resourceKinds.flatMap(kind =>
          values[kind]
            ? [
                [
                  kind,
                  values[kind]!.filter(
                    path => !belongsToApp(path, base, roots),
                  ),
                ],
              ]
            : [],
        ),
      ),
    };
  };

  const view = new Proxy(settings, {
    get(target, key) {
      if (key === 'getGlobalSettings')
        return () => filter(target.getGlobalSettings(), agentDir);
      if (key === 'getProjectSettings')
        return () =>
          filter(target.getProjectSettings(), join(cwd, CONFIG_DIR_NAME));
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    settingsManager: view,
    paths(paths, base = cwd) {
      const roots = installedRoots();
      return paths.filter(path => !belongsToApp(path, base, roots));
    },
  };
}
