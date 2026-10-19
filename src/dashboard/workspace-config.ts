import {createHash} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  getPackageDir,
  loadProjectContextFiles,
  loadSkills,
  SettingsManager,
  type LoadedMcpConfig,
  type McpExtensionOptions,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {createAppResourceFilter} from './resources.ts';
import {builtinSkillsDirectory} from '../builtin-assets.ts';

// Pi exposes the MCP loader hook, while its file parser is shipped internally.
const {loadMcpConfig} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/extensions/mcp/config.js')).href
)) as {
  loadMcpConfig(options: {
    cwd: string;
    agentDir: string;
    projectTrusted: boolean;
  }): LoadedMcpConfig;
};

const {loadPromptTemplates} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/prompt-templates.js')).href
)) as {
  loadPromptTemplates(options: {
    cwd: string;
    agentDir: string;
    promptPaths: string[];
    includeDefaults: boolean;
  }): {
    templates: ReturnType<ResourceLoader['getPrompts']>['prompts'];
    diagnostics: ReturnType<ResourceLoader['getPrompts']>['diagnostics'];
  };
};

export interface WorkspaceConfigPaths {
  projectDir: string;
  repositoryConfigDir: string;
  workspaceDir: string;
}

/** A worktree has its own configuration; symlink aliases share that configuration. */
export function workspaceConfigPaths(
  cwd: string,
  agentDir = getAgentDir(),
): WorkspaceConfigPaths {
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    canonical = resolve(cwd);
  }
  let projectDir = canonical;
  let configRoot: string | undefined;
  for (let current = canonical; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      projectDir = current;
      break;
    }
    if (!configRoot && existsSync(join(current, CONFIG_DIR_NAME)))
      configRoot = current;
    if (dirname(current) === current) {
      projectDir = configRoot ?? canonical;
      break;
    }
  }
  return {
    projectDir,
    repositoryConfigDir: join(projectDir, CONFIG_DIR_NAME),
    workspaceDir: join(
      agentDir,
      'workspaces',
      createHash('sha256').update(projectDir).digest('hex'),
    ),
  };
}

/** Create the personal configuration folder for the desktop's folder action. */
export async function workspaceConfigurationDirectory(
  cwd: string,
): Promise<string> {
  const directory = workspaceConfigPaths(cwd).workspaceDir;
  await mkdir(directory, {recursive: true});
  return directory;
}

function uniqueInstructionSources<T extends {path: string}>(files: T[]): T[] {
  const unique = new Map<string, T>();
  for (const file of files) {
    let key: string;
    try {
      key = realpathSync(file.path);
    } catch {
      key = resolve(file.path);
    }
    unique.delete(key);
    unique.set(key, file);
  }
  return [...unique.values()];
}

function uniqueAppendBlocks(blocks: string[]): string[] {
  return blocks.filter((block, index) => blocks.lastIndexOf(block) === index);
}

const resourceKinds = ['extensions', 'skills', 'prompts', 'themes'] as const;
type ResourceKind = (typeof resourceKinds)[number];
type Settings = ReturnType<SettingsManager['getSettings']>;
type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];
type ResourceOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  'cwd' | 'agentDir' | 'settingsManager'
>;

/** Use Pi's migrations and deep merge, including defaultTools modifiers. */
function effectiveSettings(
  global: Settings,
  project: Settings,
  workspace: Settings,
): SettingsManager {
  const user = SettingsManager.inMemory(global);
  user.applyOverrides(workspace);
  const storage: SettingsStorage = {
    withLock(scope, read) {
      read(JSON.stringify(scope === 'global' ? user.getSettings() : project));
    },
  };
  const merged = SettingsManager.fromStorage(storage);
  merged.applyOverrides(workspace);
  return merged;
}

export interface WorkspaceConfiguration {
  paths: WorkspaceConfigPaths;
  /** Effective preferences; Pi's normal setters retain their global save scope. */
  settingsManager: SettingsManager;
  /** Pi discovery retains the original global and trusted repository scopes. */
  resourceSettingsManager: SettingsManager;
  mcpOptions: McpExtensionOptions;
  resourceOptions(
    options?: ResourceOptions,
    contextScope?: 'workspace' | 'task',
  ): ResourceOptions;
  resourceLoader(
    loader: ResourceLoader,
    options?: ResourceOptions,
  ): ResourceLoader;
}

/** Add a machine-local scope while keeping parsing, discovery and trust in Pi. */
export function createWorkspaceConfiguration(
  cwd: string,
  agentDir = getAgentDir(),
): WorkspaceConfiguration {
  const paths = workspaceConfigPaths(cwd, agentDir);
  const repository = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  const rootRepository =
    resolve(cwd) === paths.projectDir
      ? repository
      : SettingsManager.create(paths.projectDir, agentDir, {
          projectTrusted: false,
        });
  const projectSettings = () => {
    const merged = SettingsManager.inMemory(
      rootRepository.getProjectSettings(),
    );
    if (rootRepository !== repository)
      merged.applyOverrides(repository.getProjectSettings());
    return merged.getSettings();
  };
  // The workspace is user configuration; its project slot remains disabled.
  const workspace = SettingsManager.create(
    paths.projectDir,
    paths.workspaceDir,
    {
      projectTrusted: false,
    },
  );
  let effective = effectiveSettings(
    repository.getGlobalSettings(),
    projectSettings(),
    workspace.getGlobalSettings(),
  );
  const refresh = () => {
    effective = effectiveSettings(
      repository.getGlobalSettings(),
      projectSettings(),
      workspace.getGlobalSettings(),
    );
  };
  const flush = async () => {
    await Promise.all([repository.flush(), workspace.flush()]);
  };
  const reload = async () => {
    await Promise.all([
      repository.reload(),
      ...(rootRepository !== repository ? [rootRepository.reload()] : []),
      workspace.reload(),
    ]);
    refresh();
  };
  const settingsManager = new Proxy(repository, {
    get(target, key) {
      if (key === 'isProjectTrusted') return () => target.isProjectTrusted();
      if (key === 'setProjectTrusted')
        return (trusted: boolean) => {
          target.setProjectTrusted(trusted);
          rootRepository.setProjectTrusted(trusted);
          refresh();
        };
      if (key === 'reload') return reload;
      if (key === 'flush') return flush;
      if (key === 'drainErrors')
        return () => [
          ...target.drainErrors(),
          ...(rootRepository !== repository
            ? rootRepository.drainErrors()
            : []),
          ...workspace.drainErrors(),
        ];
      if (typeof key === 'string' && key.startsWith('setProject')) {
        const value = Reflect.get(target, key, target);
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          refresh();
          return result;
        };
      }
      // Pi setters retain their global save scope and field-level persistence.
      if (
        typeof key === 'string' &&
        (key.startsWith('set') ||
          key.startsWith('remove') ||
          key === 'getOrCreateDeviceId')
      ) {
        const value = Reflect.get(target, key, target);
        if (typeof value === 'function')
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            refresh();
            return result;
          };
      }
      if (key === 'applyOverrides')
        return (overrides: Partial<Settings>) =>
          effective.applyOverrides(overrides);
      const value = Reflect.get(effective, key, effective);
      return typeof value === 'function' ? value.bind(effective) : value;
    },
  });
  const repositoryFilter = createAppResourceFilter(repository, cwd, agentDir);
  const rootFilter = createAppResourceFilter(
    rootRepository,
    paths.projectDir,
    agentDir,
  );
  const rootPackages = new DefaultPackageManager({
    cwd: paths.projectDir,
    agentDir,
    settingsManager: rootFilter.settingsManager,
  });
  let rootResources: Partial<Record<ResourceKind, string[]>> = {};
  const workspaceFilter = createAppResourceFilter(
    workspace,
    paths.projectDir,
    paths.workspaceDir,
  );
  const packages = new DefaultPackageManager({
    cwd: paths.projectDir,
    agentDir: paths.workspaceDir,
    settingsManager: workspaceFilter.settingsManager,
  });
  let workspaceResources: Record<ResourceKind, string[]> = {
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  const textLoader = new DefaultResourceLoader({
    cwd: paths.workspaceDir,
    agentDir: paths.workspaceDir,
    settingsManager: SettingsManager.inMemory({}, {projectTrusted: false}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    agentsFilesOverride: base => ({
      agentsFiles: base.agentsFiles.filter(
        file => dirname(file.path) === paths.workspaceDir,
      ),
    }),
  });
  const textSettings = new Proxy(repository, {
    get(target, key) {
      if (key === 'getGlobalSettings' || key === 'getProjectSettings')
        return () => ({});
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const inheritedTextOptions = {
    agentDir,
    settingsManager: textSettings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
  const inheritedTextLoader = new DefaultResourceLoader({
    cwd,
    ...inheritedTextOptions,
  });
  const rootTextLoader =
    rootRepository === repository
      ? inheritedTextLoader
      : new DefaultResourceLoader({
          cwd: paths.projectDir,
          ...inheritedTextOptions,
        });
  const inheritedText = (kind: 'system' | 'append') => {
    const source =
      kind === 'system'
        ? inheritedTextLoader.getSystemPromptSource()
        : inheritedTextLoader.getAppendSystemPromptSources()[0];
    // A current-folder project file is more specific than the repository root.
    return source && dirname(source.path) !== resolve(agentDir)
      ? inheritedTextLoader
      : rootTextLoader;
  };
  const reloadResources = async () => {
    await reload();
    const resolved = await packages.resolve();
    if (rootRepository !== repository) {
      const rootResolved = await rootPackages.resolve();
      rootResources = Object.fromEntries(
        resourceKinds.map(kind => [
          kind,
          rootResolved[kind]
            .filter(resource => resource.metadata.scope === 'project')
            .map(resource => `${resource.enabled ? '' : '-'}${resource.path}`),
        ]),
      );
    }
    workspaceResources = Object.fromEntries(
      resourceKinds.map(kind => [
        kind,
        resolved[kind]
          // Pi also discovers ~/.agents/skills in every loader. It already belongs
          // to the original global scope, so do not promote it into workspace scope.
          .filter(
            resource =>
              resource.metadata.source !== 'auto' ||
              resource.metadata.baseDir === paths.workspaceDir,
          )
          .map(resource => `${resource.enabled ? '' : '-'}${resource.path}`),
      ]),
    ) as Record<ResourceKind, string[]>;
    await Promise.all([
      textLoader.reload(),
      inheritedTextLoader.reload(),
      ...(rootTextLoader !== inheritedTextLoader
        ? [rootTextLoader.reload()]
        : []),
    ]);
  };
  let currentOptions: ResourceOptions = {};
  let currentContextScope: 'workspace' | 'task' = 'workspace';
  const resourceSettingsManager = new Proxy(settingsManager, {
    get(target, key) {
      if (key === 'reload') return reloadResources;
      if (key === 'getGlobalSettings')
        return () => repositoryFilter.settingsManager.getGlobalSettings();
      if (key === 'getProjectSettings')
        return () => {
          const project = repositoryFilter.settingsManager.getProjectSettings();
          const local = workspace.getGlobalSettings();
          return {
            ...project,
            ...Object.fromEntries(
              resourceKinds.map(kind => [
                kind,
                [
                  ...workspaceResources[kind],
                  ...(project[kind] ?? []),
                  ...(rootResources[kind] ?? []),
                  // Synthetic built-in extension toggles have no disk path.
                  ...(local[kind] ?? []).filter(path =>
                    /^[+!-]?builtin:/.test(path),
                  ),
                ],
              ]),
            ),
          };
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    paths,
    settingsManager,
    resourceSettingsManager,
    mcpOptions: {
      loadConfig() {
        const base = loadMcpConfig({
          cwd: paths.projectDir,
          agentDir,
          projectTrusted: repository.isProjectTrusted(),
        });
        if (rootRepository !== repository) {
          const current = loadMcpConfig({
            cwd,
            agentDir,
            projectTrusted: repository.isProjectTrusted(),
          });
          const servers = new Map(
            base.servers.map(server => [server.name, server]),
          );
          for (const server of current.servers)
            if (server.scope === 'project' || !servers.has(server.name))
              servers.set(server.name, server);
          base.servers = [...servers.values()];
          base.errors.push(...current.errors);
          base.projectConfig = current.projectConfig;
          if (current.autoEnableCodemode !== undefined)
            base.autoEnableCodemode = current.autoEnableCodemode;
        }
        const local = loadMcpConfig({
          cwd,
          agentDir: paths.workspaceDir,
          projectTrusted: false,
        });
        const servers = new Map(
          base.servers.map(server => [server.name, server]),
        );
        for (const server of local.servers) servers.set(server.name, server);
        return {
          ...base,
          servers: [...servers.values()],
          ...(local.autoEnableCodemode === undefined
            ? {}
            : {
                autoEnableCodemode: local.autoEnableCodemode,
              }),
          errors: [...base.errors, ...local.errors],
        };
      },
    },
    resourceLoader(loader, options = currentOptions) {
      const taskOnly = currentContextScope === 'task';
      return new Proxy(loader, {
        get(target, key) {
          if (taskOnly && key === 'getSystemPromptSource')
            return () =>
              options.systemPrompt === undefined
                ? undefined
                : target.getSystemPromptSource();
          if (taskOnly && key === 'getAppendSystemPromptSources')
            return () => target.getAppendSystemPromptSources();
          if (
            key === 'getSystemPromptSource' &&
            options.systemPrompt === undefined
          )
            return () =>
              textLoader.getSystemPromptSource() ??
              inheritedText('system').getSystemPromptSource() ??
              target.getSystemPromptSource();
          if (key === 'getAppendSystemPromptSources')
            return () => {
              const local = textLoader.getAppendSystemPromptSources();
              if (options.appendSystemPrompt === undefined)
                return local.length
                  ? local
                  : inheritedText('append').getAppendSystemPromptSources();
              return uniqueInstructionSources([
                ...(local.length
                  ? local
                  : inheritedText('append').getAppendSystemPromptSources()),
                ...target.getAppendSystemPromptSources(),
              ]);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    resourceOptions(options = {}, contextScope = 'workspace') {
      const taskOnly = contextScope === 'task';
      const explicitSkills = options.noSkills
        ? []
        : (options.additionalSkillPaths ?? []);
      const explicitPrompts = options.noPromptTemplates
        ? []
        : (options.additionalPromptTemplatePaths ?? []);
      if (taskOnly)
        options = {
          ...options,
          noContextFiles: true,
          noSkills: true,
          noPromptTemplates: true,
          appendSystemPrompt: options.appendSystemPrompt ?? [],
        };
      currentOptions = options;
      currentContextScope = contextScope;
      return {
        ...options,
        additionalSkillPaths: [
          ...(options.additionalSkillPaths ?? []),
          ...(!options.noSkills ? [builtinSkillsDirectory] : []),
        ],
        ...(taskOnly
          ? {
              skillsOverride: () => {
                const selected = loadSkills({
                  cwd,
                  agentDir,
                  skillPaths: explicitSkills,
                  includeDefaults: false,
                });
                return options.skillsOverride?.(selected) ?? selected;
              },
              promptsOverride: () => {
                const loaded = loadPromptTemplates({
                  cwd,
                  agentDir,
                  promptPaths: explicitPrompts,
                  includeDefaults: false,
                });
                const selected = {
                  prompts: loaded.templates,
                  diagnostics: loaded.diagnostics,
                };
                return options.promptsOverride?.(selected) ?? selected;
              },
            }
          : {}),
        agentsFilesOverride: base => {
          const inherited = options.agentsFilesOverride?.(base) ?? base;
          if (options.noContextFiles) return inherited;
          // Retain nested instructions even when repository resources come from
          // the canonical root, then append the workspace's instruction file.
          const agentsFiles = options.agentsFilesOverride
            ? inherited.agentsFiles
            : loadProjectContextFiles({cwd, agentDir});
          return {
            agentsFiles: uniqueInstructionSources([
              ...agentsFiles,
              ...textLoader.getAgentsFiles().agentsFiles,
            ]),
          };
        },
        systemPromptOverride: base => {
          if (taskOnly) {
            const value = options.systemPrompt === undefined ? undefined : base;
            return options.systemPromptOverride
              ? options.systemPromptOverride(value)
              : value;
          }
          const value =
            options.systemPrompt === undefined
              ? (textLoader.getSystemPrompt() ??
                inheritedText('system').getSystemPrompt() ??
                base)
              : base;
          return options.systemPromptOverride?.(value) ?? value;
        },
        appendSystemPromptOverride: base => {
          if (taskOnly)
            return uniqueAppendBlocks(
              options.appendSystemPromptOverride
                ? options.appendSystemPromptOverride(base)
                : base,
            );
          const local = textLoader.getAppendSystemPrompt();
          // Pi uses one APPEND_SYSTEM.md at the most specific scope.
          const value =
            options.appendSystemPrompt === undefined
              ? local.length
                ? local
                : inheritedText('append').getAppendSystemPrompt()
              : [
                  ...(local.length
                    ? local
                    : inheritedText('append').getAppendSystemPrompt()),
                  ...base,
                ];
          return uniqueAppendBlocks(
            options.appendSystemPromptOverride?.(value) ?? value,
          );
        },
      };
    },
  };
}
