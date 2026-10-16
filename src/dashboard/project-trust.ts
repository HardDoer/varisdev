import {
  getPackageDir,
  ProjectTrustStore,
  type CreateAgentSessionServicesOptions,
  type LoadExtensionsResult,
  type ProjectTrustContext,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Pi ships its startup trust resolver and context factory without root exports.
const {resolveProjectTrusted} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/core/project-trust.js')).href
)) as {
  resolveProjectTrusted(options: {
    cwd: string;
    trustStore: ProjectTrustStore;
    trustOverride?: boolean;
    defaultProjectTrust: ReturnType<SettingsManager['getDefaultProjectTrust']>;
    extensionsResult: LoadExtensionsResult;
    projectTrustContext: ProjectTrustContext;
    onExtensionError?: (message: string) => void;
  }): Promise<boolean>;
};
const {createProjectTrustContext} = (await import(
  pathToFileURL(join(getPackageDir(), 'dist/cli/project-trust.js')).href
)) as {
  createProjectTrustContext(options: {
    cwd: string;
    mode: 'rpc';
    settingsManager: SettingsManager;
    hasUI: false;
  }): ProjectTrustContext;
};

/** Use Pi's noninteractive startup policy before publishing a desktop session. */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  trustOverride?: boolean,
  onExtensionError?: (message: string) => void,
): CreateAgentSessionServicesOptions['resourceLoaderReloadOptions'] {
  return {
    resolveProjectTrust: ({extensionsResult}) =>
      resolveProjectTrusted({
        cwd,
        trustStore: new ProjectTrustStore(agentDir),
        trustOverride,
        defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
        extensionsResult,
        projectTrustContext: createProjectTrustContext({
          cwd,
          mode: 'rpc',
          settingsManager,
          hasUI: false,
        }),
        onExtensionError,
      }),
  };
}
