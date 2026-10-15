import './settings-entry.mjs';
import {SettingsManager, getAgentDir} from '@earendil-works/pi-coding-agent';
import {createAppResourceFilter} from '../dashboard/resources.ts';

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

await import(
  new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))
    .href
);
