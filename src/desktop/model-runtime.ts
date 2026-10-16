import {join} from 'node:path';
import {
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {createBuiltinExtensions} from '../builtin-extensions.ts';
import {createAppResourceFilter} from '../dashboard/resources.ts';
import {createDesktopModelRuntime} from '../llama.ts';

/** Load app-wide model providers through Pi's services without project resources. */
export async function createGlobalModelRuntime(
  onDiagnostic?: (message: string) => void,
): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(agentDir, agentDir, {
    projectTrusted: false,
  });
  const resources = createAppResourceFilter(settings, agentDir, agentDir);
  const modelRuntime = await createDesktopModelRuntime({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    settingsManager: resources.settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: createBuiltinExtensions(),
    },
  });
  const extensions = services.resourceLoader.getExtensions();
  const messages = [
    ...services.diagnostics.map(diagnostic => diagnostic.message),
    ...extensions.errors.map(
      diagnostic => `Extension "${diagnostic.path}": ${diagnostic.error}`,
    ),
    ...(extensions.warnings ?? []).map(
      diagnostic => `Extension "${diagnostic.path}": ${diagnostic.warning}`,
    ),
    ...settings.drainErrors().map(diagnostic => diagnostic.error.message),
    modelRuntime.getError(),
  ];
  for (const message of messages) if (message) onDiagnostic?.(message);
  return services.modelRuntime;
}
