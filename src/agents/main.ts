import type {SessionManager} from '@earendil-works/pi-coding-agent';
import {createDefaultAgentProfile} from './default.ts';
import type {AgentTemplate} from './templates.ts';

export const mainAgentEntry = 'varisdev.main-agent';
// An absolute ID cannot collide with a selectable configuration's relative ID.
export const mainAgentId = '/main';

export function isMainAgent(
  manager: Pick<SessionManager, 'getEntries'>,
): boolean {
  return (
    manager
      .getEntries?.()
      .some(
        entry => entry.type === 'custom' && entry.customType === mainAgentEntry,
      ) ?? false
  );
}

/** Internal identity for the workspace starter; it is never a selectable profile. */
export function createMainAgentProfile(): AgentTemplate {
  return {
    ...createDefaultAgentProfile(),
    id: mainAgentId,
    key: 'builtin:main',
    name: 'Main agent',
    mode: 'primary',
    sourcePath: '',
  };
}
