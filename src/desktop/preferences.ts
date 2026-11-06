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
import {isAbsolute, join, normalize, posix, win32} from 'node:path';

const MAX_RECENT_PROJECTS = 12;
const MAX_TERMINAL_PROFILES = 32;
const CUSTOM_TERMINAL_ID = /^custom-[a-f0-9]{32}$/;
const DETECTED_TERMINAL_ID = /^shell-[a-f0-9]{24}$/;

export interface SavedTerminalProfile {
  id: string;
  label: string;
  path: string;
}

function savedTerminalProfile(input: unknown): input is SavedTerminalProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const profile = input as Partial<SavedTerminalProfile>;
  return (
    typeof profile.id === 'string' &&
    CUSTOM_TERMINAL_ID.test(profile.id) &&
    typeof profile.label === 'string' &&
    profile.label.trim().length > 0 &&
    profile.label.length <= 128 &&
    !/\p{Cc}/u.test(profile.label) &&
    typeof profile.path === 'string' &&
    profile.path.length <= 4096 &&
    !/\p{Cc}/u.test(profile.path) &&
    (posix.isAbsolute(profile.path) || win32.isAbsolute(profile.path))
  );
}

function terminalProfiles(input: unknown): SavedTerminalProfile[] {
  if (!Array.isArray(input)) return [];
  const profiles: SavedTerminalProfile[] = [];
  for (const profile of input) {
    if (
      !savedTerminalProfile(profile) ||
      profiles.some(item => item.id === profile.id)
    )
      continue;
    profiles.push({
      id: profile.id,
      label: profile.label.trim(),
      path: profile.path,
    });
    if (profiles.length === MAX_TERMINAL_PROFILES) break;
  }
  return profiles;
}
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
  private lastSeenReleaseVersion?: string;
  private terminalProfile?: string;
  private terminalProfiles: SavedTerminalProfile[] = [];
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
        this.terminalProfiles = terminalProfiles(
          'customTerminalProfiles' in saved ? saved.customTerminalProfiles : [],
        );
        if (
          'defaultTerminalProfileId' in saved &&
          typeof saved.defaultTerminalProfileId === 'string' &&
          (DETECTED_TERMINAL_ID.test(saved.defaultTerminalProfileId) ||
            this.terminalProfiles.some(
              profile => profile.id === saved.defaultTerminalProfileId,
            ))
        )
          this.terminalProfile = saved.defaultTerminalProfileId;
        this.agentNoticeSeen =
          'agentNoticeAcknowledged' in saved &&
          saved.agentNoticeAcknowledged === true;
        if (
          'lastSeenReleaseVersion' in saved &&
          typeof saved.lastSeenReleaseVersion === 'string' &&
          saved.lastSeenReleaseVersion.length <= 128 &&
          saved.lastSeenReleaseVersion.trim() ===
            saved.lastSeenReleaseVersion &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
            saved.lastSeenReleaseVersion,
          )
        )
          this.lastSeenReleaseVersion = saved.lastSeenReleaseVersion;
      }
    } catch {
      // A new profile starts in the launch folder with its first-use notice.
    }
  }

  defaultTerminalProfile(): string | undefined {
    return this.terminalProfile;
  }

  setDefaultTerminalProfile(profileId: string): void {
    if (
      !DETECTED_TERMINAL_ID.test(profileId) &&
      !this.terminalProfiles.some(profile => profile.id === profileId)
    )
      throw new Error('Choose an installed shell profile.');
    this.save(
      this.lastFolder,
      this.agentNoticeSeen,
      this.recentFolders,
      this.lastSeenReleaseVersion,
      profileId,
    );
  }

  customTerminalProfiles(): SavedTerminalProfile[] {
    return this.terminalProfiles.map(profile => ({...profile}));
  }

  saveTerminalProfile(profile: SavedTerminalProfile): void {
    if (!savedTerminalProfile(profile))
      throw new Error('Choose a valid terminal profile.');
    const profiles = this.customTerminalProfiles();
    const index = profiles.findIndex(item => item.id === profile.id);
    if (index === -1) {
      if (profiles.length >= MAX_TERMINAL_PROFILES)
        throw new Error('Remove a terminal profile before adding another.');
      profiles.push({...profile});
    } else {
      profiles[index] = {...profile};
    }
    this.save(
      this.lastFolder,
      this.agentNoticeSeen,
      this.recentFolders,
      this.lastSeenReleaseVersion,
      this.terminalProfile,
      profiles,
    );
  }

  removeTerminalProfile(profileId: string): void {
    if (!this.terminalProfiles.some(profile => profile.id === profileId))
      throw new Error('Choose a saved terminal profile.');
    const profiles = this.terminalProfiles.filter(
      profile => profile.id !== profileId,
    );
    this.save(
      this.lastFolder,
      this.agentNoticeSeen,
      this.recentFolders,
      this.lastSeenReleaseVersion,
      this.terminalProfile === profileId ? null : this.terminalProfile,
      profiles,
    );
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
    recentProjects = this.recentFolders,
    lastSeenReleaseVersion = this.lastSeenReleaseVersion,
    defaultTerminalProfileId: string | null | undefined = this.terminalProfile,
    customTerminalProfiles = this.terminalProfiles,
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
            lastSeenReleaseVersion,
            defaultTerminalProfileId: defaultTerminalProfileId ?? undefined,
            customTerminalProfiles,
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
    this.lastSeenReleaseVersion = lastSeenReleaseVersion;
    this.terminalProfile = defaultTerminalProfileId ?? undefined;
    this.terminalProfiles = customTerminalProfiles;
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
    this.save(folder, this.agentNoticeSeen, projects);
  }

  agentNoticeAcknowledged(): boolean {
    return this.agentNoticeSeen;
  }

  acknowledgeAgentNotice(): void {
    this.save(this.lastFolder, true);
  }

  whatsNewSeen(version: string): boolean {
    return this.lastSeenReleaseVersion === version;
  }

  markWhatsNewSeen(version: string): void {
    this.save(
      this.lastFolder,
      this.agentNoticeSeen,
      this.recentFolders,
      version,
    );
  }
}
