import './settings-entry.mjs';
import {join} from 'node:path';
import {
  ModelRuntime,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {installOpenAIRegistrationReuse} from '../openai-registration.ts';
import {createAppResourceFilter} from '../dashboard/resources.ts';
import {piModuleURL} from './pi-paths.ts';

// This entry runs only in the command's child process. The bundled app extension
// supplies its current tools; keep older app registrations out of the loader
// while preserving all settings and other installed plugins on disk.
const createSettings = SettingsManager.create;
SettingsManager.create = (cwd, agentDir, options) =>
  createAppResourceFilter(
    createSettings(cwd, agentDir, options),
    cwd,
    agentDir ?? getAgentDir(),
  ).settingsManager;

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
