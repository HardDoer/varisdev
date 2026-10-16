import {resolve} from 'node:path';
import {getAgentDir, SettingsManager} from '@earendil-works/pi-coding-agent';

interface InstallationSettings {
  settings: SettingsManager;
  flushed?: Promise<void>;
}

const pending = new Map<string, InstallationSettings>();

/** Use Pi's lazy installation ID and share settings across concurrent logins. */
export function createInstallationLoginContext() {
  let entry: InstallationSettings | undefined;
  let agentDir: string;
  return {
    getDeviceId(): string {
      agentDir ??= resolve(getAgentDir());
      entry ??= pending.get(agentDir);
      if (!entry) {
        const settings = SettingsManager.create(agentDir, agentDir, {
          projectTrusted: false,
        });
        if (settings.drainErrors().length)
          throw new Error('Could not read installation settings.');
        entry = {settings};
        pending.set(agentDir, entry);
      }
      return entry.settings.getOrCreateDeviceId();
    },
    async flush(): Promise<void> {
      if (!entry) return;
      const current = entry;
      current.flushed ??= current.settings
        .flush()
        .then(() => {
          if (current.settings.drainErrors().length)
            throw new Error('Could not save installation ID.');
        })
        .finally(() => {
          if (pending.get(agentDir) === current) pending.delete(agentDir);
        });
      await current.flushed;
    },
  };
}
