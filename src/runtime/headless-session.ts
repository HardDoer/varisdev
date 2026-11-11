import './settings-entry.mjs';
import {join} from 'node:path';
import {
  CONFIG_DIR_NAME,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {installOpenAIRegistrationReuse} from '../openai-registration.ts';
import {createAppResourceFilter} from '../dashboard/resources.ts';
import {workspaceConfigPaths} from '../dashboard/workspace-config.ts';
import {
  installBuiltinSkillLoader,
  loadBuiltinSkills,
} from '../builtin-skills.ts';
import {piModuleURL} from './pi-paths.ts';

// This entry runs only in the command's child process. The bundled app extension
// supplies its current tools; keep older app registrations out of the loader
// while preserving all settings and other installed plugins on disk.
const createSettings = SettingsManager.create;
const builtinSkills = new WeakMap<
  SettingsManager,
  Awaited<ReturnType<typeof loadBuiltinSkills>>
>();
SettingsManager.create = (cwd, agentDir = getAgentDir(), options) => {
  const settings = createSettings(cwd, agentDir, options);
  const paths = workspaceConfigPaths(cwd, agentDir);
  const root = createSettings(paths.projectDir, agentDir, options);
  const workspace = createSettings(paths.projectDir, paths.workspaceDir, {
    projectTrusted: false,
  });
  const filtered = createAppResourceFilter(settings, cwd, agentDir);
  const view = new Proxy(filtered.settingsManager, {
    get(target, key) {
      if (key === 'reload')
        return async () => {
          root.setProjectTrusted(settings.isProjectTrusted());
          await Promise.all([
            settings.reload(),
            root.reload(),
            workspace.reload(),
          ]);
          builtinSkills.set(
            view,
            await loadBuiltinSkills([
              {
                baseDir: agentDir,
                entries: settings.getGlobalSettings().skills ?? [],
              },
              {
                baseDir: paths.repositoryConfigDir,
                entries: root.getProjectSettings().skills ?? [],
              },
              {
                baseDir: join(cwd, CONFIG_DIR_NAME),
                entries: settings.getProjectSettings().skills ?? [],
              },
              {
                baseDir: paths.workspaceDir,
                entries: workspace.getGlobalSettings().skills ?? [],
              },
            ]),
          );
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return view;
};
installBuiltinSkillLoader(settings => builtinSkills.get(settings));

const createModelRuntime = ModelRuntime.create;
ModelRuntime.create = async (options = {}) => {
  const runtime = await createModelRuntime.call(ModelRuntime, options);
  installOpenAIRegistrationReuse(runtime, {
    ...options,
    authPath: options.authPath ?? join(getAgentDir(), 'auth.json'),
  });
  return runtime;
};

await import(piModuleURL('cli.js').href);
