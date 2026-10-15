import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isAbsolute, join, normalize} from 'node:path';

const MAX_RECENT_PROJECTS = 12;
const folderKey = (folder: string) =>
  process.platform === 'win32' ? folder.toLowerCase() : folder;

function recentFolders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input
    .filter((folder): folder is string => {
      if (
        typeof folder !== 'string' ||
        folder.length > 4096 ||
        !isAbsolute(folder) ||
        seen.has(folderKey(normalize(folder)))
      )
        return false;
      seen.add(folderKey(normalize(folder)));
      return true;
    })
    .slice(0, MAX_RECENT_PROJECTS)
    .map(folder => normalize(folder));
}

/** Desktop preferences live in the persistent VarisDev application profile. */
export class DesktopPreferences {
  private lastFolder?: string;
  private recentFolders: string[] = [];
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
        this.recentFolders = recentFolders(
          'recentProjects' in saved ? saved.recentProjects : [this.lastFolder],
        );
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

  recentProjects(): string[] {
    return this.recentFolders.filter(folder => {
      try {
        return statSync(folder).isDirectory();
      } catch {
        return false;
      }
    });
  }

  private save(
    lastFolder: string | undefined,
    agentNoticeAcknowledged: boolean,
    commitNoticeAcknowledged = this.commitNoticeSeen,
    recentProjects = this.recentFolders,
  ): void {
    mkdirSync(this.directory, {recursive: true});
    const path = join(this.directory, 'settings.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify(
          {
            lastFolder,
            recentProjects,
            agentNoticeAcknowledged,
            commitNoticeAcknowledged,
          },
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
    this.recentFolders = recentProjects;
    this.agentNoticeSeen = agentNoticeAcknowledged;
    this.commitNoticeSeen = commitNoticeAcknowledged;
  }

  rememberFolder(folder: string): void {
    if (!isAbsolute(folder))
      throw new Error('Choose an absolute project folder.');
    try {
      folder = realpathSync(folder);
    } catch {
      folder = normalize(folder);
    }
    const projects = recentFolders([folder, ...this.recentFolders]);
    this.save(folder, this.agentNoticeSeen, this.commitNoticeSeen, projects);
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
