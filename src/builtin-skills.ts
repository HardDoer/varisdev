import {
  DefaultPackageManager,
  DefaultResourceLoader,
  loadSkillsFromDir,
  SettingsManager,
  type LoadSkillsResult,
} from '@earendil-works/pi-coding-agent';
import {builtinSkillsDirectory} from './builtin-assets.ts';

export interface BuiltinSkillScope {
  baseDir: string;
  entries: readonly string[];
}

/** Resolve original settings before the installed-app registration filter runs. */
export async function loadBuiltinSkills(
  scopes: readonly BuiltinSkillScope[],
): Promise<LoadSkillsResult> {
  const builtin = loadSkillsFromDir({
    dir: builtinSkillsDirectory,
    source: 'builtin',
  });
  const disabled = new Set<string>();
  for (const {baseDir, entries} of scopes) {
    // Only modifiers apply to the fallback. Pi supplies path expansion, skill
    // directory matching, glob matching and force-include/exclude precedence.
    const overrides = entries.filter(entry => /^[!+-]/.test(entry));
    if (!overrides.length) continue;
    const resolveSkills = async (patterns: string[]) => {
      const packages = new DefaultPackageManager({
        cwd: baseDir,
        agentDir: baseDir,
        settingsManager: SettingsManager.inMemory(
          {skills: [builtinSkillsDirectory, ...patterns]},
          {projectTrusted: false},
        ),
      });
      return (await packages.resolve()).skills;
    };
    for (const skill of await resolveSkills(overrides))
      if (!skill.enabled) disabled.add(skill.path);
    // A more specific scope only restores an excluded fallback when its +path
    // actually matches. Let Pi resolve that against a disabled default as well.
    if (disabled.size && overrides.some(entry => entry.startsWith('+')))
      for (const skill of await resolveSkills(['!**', ...overrides]))
        if (skill.enabled) disabled.delete(skill.path);
  }
  return {
    skills: builtin.skills
      .filter(skill => !disabled.has(skill.filePath))
      .map(skill => ({
        ...skill,
        sourceInfo: {...skill.sourceInfo, scope: 'user'},
      })),
    diagnostics: builtin.diagnostics,
  };
}

/** User resources, including explicit CLI paths, take precedence by name. */
export function includeBuiltinSkills(
  base: LoadSkillsResult,
  builtin: LoadSkillsResult,
): LoadSkillsResult {
  const names = new Set(base.skills.map(skill => skill.name));
  return {
    skills: [
      ...builtin.skills.filter(skill => !names.has(skill.name)),
      ...base.skills,
    ],
    diagnostics: [...builtin.diagnostics, ...base.diagnostics],
  };
}

/** Host the fallback in Pi's CLI loader without making it a temporary --skill. */
export function installBuiltinSkillLoader(
  skillsForSettings: (
    settings: SettingsManager,
  ) => LoadSkillsResult | undefined,
): void {
  // Pi's CLI constructs its loader internally. Limit the adapter to its hosting
  // options; Pi retains argument parsing, discovery and command registration.
  type HostedLoader = {
    settingsManager: SettingsManager;
    noSkills: boolean;
    skillsOverride?: NonNullable<
      ConstructorParameters<typeof DefaultResourceLoader>[0]['skillsOverride']
    >;
  };
  const adapted = new WeakSet<DefaultResourceLoader>();
  const reload = DefaultResourceLoader.prototype.reload;
  DefaultResourceLoader.prototype.reload = function (options) {
    if (!adapted.has(this)) {
      adapted.add(this);
      const host = this as unknown as HostedLoader;
      const previous = host.skillsOverride;
      host.skillsOverride = base => {
        const builtin = host.noSkills
          ? undefined
          : skillsForSettings(host.settingsManager);
        const selected = builtin ? includeBuiltinSkills(base, builtin) : base;
        return previous?.(selected) ?? selected;
      };
    }
    return reload.call(this, options);
  };
}
