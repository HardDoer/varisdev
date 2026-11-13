import {
  SessionManager,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export const primaryClosedEntry = 'varisdev.primary-closed';

export function sessionPrimaryClosed(
  manager: ExtensionContext['sessionManager'],
): boolean {
  const entry = manager
    .getEntries?.()
    .findLast(
      entry =>
        entry.type === 'custom' && entry.customType === primaryClosedEntry,
    );
  return (
    entry?.type === 'custom' &&
    (entry.data as {closed?: unknown} | undefined)?.closed !== false
  );
}

export function persistPrimarySession(
  manager: ExtensionContext['sessionManager'],
): void {
  if (!(manager instanceof SessionManager) || !manager.isPersisted()) return;
  const path = manager.getSessionFile();
  const header = manager.getHeader();
  if (!path || !header || existsSync(path)) return;
  // Pi buffers metadata until a root user or assistant message exists.
  // A host with only agent launches still needs a resumable workspace file.
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(
    path,
    [header, ...manager.getEntries()]
      .map(entry => JSON.stringify(entry))
      .join('\n') + '\n',
    {flag: 'wx', mode: 0o600},
  );
  const leaf = manager.getLeafId();
  manager.setSessionFile(path);
  if (leaf) manager.branch(leaf);
  else manager.resetLeaf();
}

export {isAvailablePrimary} from './primary-availability.ts';
