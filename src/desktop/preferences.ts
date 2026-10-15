import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute, join} from 'node:path';

/** Desktop preferences live in the persistent VarisDev application profile. */
export class DesktopPreferences {
  private lastFolder?: string;
  private agentNoticeSeen = false;
  private commitNoticeSeen = false;
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    try {
      const saved: unknown = JSON.parse(
        readFileSync(join(directory, 'settings.json'), 'utf8'),
      );
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (
          'lastFolder' in saved &&
          typeof saved.lastFolder === 'string' &&
          isAbsolute(saved.lastFolder)
        )
          this.lastFolder = saved.lastFolder;
        this.agentNoticeSeen =
          'agentNoticeAcknowledged' in saved &&
          saved.agentNoticeAcknowledged === true;
        this.commitNoticeSeen =
          'commitNoticeAcknowledged' in saved &&
          saved.commitNoticeAcknowledged === true;
      }
    } catch {
      // A new profile starts in the launch folder with its first-use notice.
    }
  }

  folder(fallback: string): string {
    try {
      if (this.lastFolder && statSync(this.lastFolder).isDirectory())
        return this.lastFolder;
    } catch {
      // The previously opened folder may have moved or been deleted.
    }
    return fallback;
  }

  private save(
    lastFolder: string | undefined,
    agentNoticeAcknowledged: boolean,
    commitNoticeAcknowledged = this.commitNoticeSeen,
  ): void {
    mkdirSync(this.directory, {recursive: true});
    const path = join(this.directory, 'settings.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify(
          {lastFolder, agentNoticeAcknowledged, commitNoticeAcknowledged},
          null,
          2,
        ) + '\n',
        {mode: 0o600},
      );
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, {force: true});
    }
    this.lastFolder = lastFolder;
    this.agentNoticeSeen = agentNoticeAcknowledged;
    this.commitNoticeSeen = commitNoticeAcknowledged;
  }

  rememberFolder(folder: string): void {
    this.save(folder, this.agentNoticeSeen);
  }

  agentNoticeAcknowledged(): boolean {
    return this.agentNoticeSeen;
  }

  acknowledgeAgentNotice(): void {
    this.save(this.lastFolder, true);
  }

  commitNoticeAcknowledged(): boolean {
    return this.commitNoticeSeen;
  }

  acknowledgeCommitNotice(): void {
    this.save(this.lastFolder, this.agentNoticeSeen, true);
  }
}
