import {createHash, randomUUID} from 'node:crypto';
import {accessSync, constants, statSync} from 'node:fs';
import {userInfo} from 'node:os';
import {posix, win32} from 'node:path';
import {resolveUserShell, shellEnvironment} from '../runtime/environment.mjs';
import type {DesktopPreferences, SavedTerminalProfile} from './preferences.ts';

export interface TerminalProfile extends SavedTerminalProfile {
  custom?: true;
}

export interface TerminalProfilesState {
  profiles: TerminalProfile[];
  customProfiles: SavedTerminalProfile[];
  defaultProfileId: string;
}

interface DetectionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  userShell?: () => string | null | undefined;
}

function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function executable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (platform === 'win32' && !/\.(?:exe|com)$/i.test(path)) return false;
    if (!statSync(path).isFile()) return false;
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Detect executables without running shell startup files or probing processes. */
export function detectTerminalProfiles({
  env = process.env,
  platform = process.platform,
  exists = path => executable(path, platform),
  userShell = accountShell,
}: DetectionOptions = {}): TerminalProfilesState {
  const paths = platform === 'win32' ? win32 : posix;
  const values = shellEnvironment(env, '', platform);
  const key = (path: string) =>
    platform === 'win32' ? paths.normalize(path).toLowerCase() : path;
  const search = (values.PATH || '')
    .split(platform === 'win32' ? ';' : ':')
    .map(path => path.trim().replace(/^"(.*)"$/, '$1'))
    .filter(path => paths.isAbsolute(path));
  const profiles: TerminalProfile[] = [];
  const add = (label: string, candidates: (string | undefined)[]) => {
    const path = candidates.find(
      (candidate): candidate is string =>
        !!candidate && paths.isAbsolute(candidate) && exists(candidate),
    );
    if (!path || profiles.some(profile => key(profile.path) === key(path)))
      return;
    profiles.push({
      id: `shell-${createHash('sha256').update(key(path)).digest('hex').slice(0, 24)}`,
      label,
      path,
    });
  };
  const onPath = (name: string) => search.map(path => paths.join(path, name));
  const preferred = resolveUserShell({env, platform, exists, userShell}).file;
  if (platform === 'win32') {
    const roots = [
      ...new Set(
        [
          values.PROGRAMW6432,
          values.PROGRAMFILES,
          'C:\\Program Files',
          values['PROGRAMFILES(X86)'],
          'C:\\Program Files (x86)',
        ].filter((root): root is string => !!root),
      ),
    ];
    const windows = values.SYSTEMROOT || values.WINDIR || 'C:\\Windows';
    add('PowerShell 7', [
      ...onPath('pwsh.exe'),
      ...roots.map(root => win32.join(root, 'PowerShell', '7', 'pwsh.exe')),
      ...(values.LOCALAPPDATA
        ? [
            win32.join(
              values.LOCALAPPDATA,
              'Microsoft',
              'PowerShell',
              '7',
              'pwsh.exe',
            ),
            win32.join(
              values.LOCALAPPDATA,
              'Microsoft',
              'WindowsApps',
              'pwsh.exe',
            ),
          ]
        : []),
    ]);
    add('Windows PowerShell', [
      win32.join(
        windows,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ...onPath('powershell.exe'),
    ]);
    add('Command Prompt', [
      values.COMSPEC &&
      win32.basename(values.COMSPEC).toLowerCase() === 'cmd.exe'
        ? values.COMSPEC
        : undefined,
      win32.join(windows, 'System32', 'cmd.exe'),
      ...onPath('cmd.exe'),
    ]);
    const gitRoots = [
      ...roots.map(root => win32.join(root, 'Git')),
      ...(values.LOCALAPPDATA
        ? [win32.join(values.LOCALAPPDATA, 'Programs', 'Git')]
        : []),
      ...search
        .filter(path => exists(win32.join(path, 'git.exe')))
        .map(path => win32.dirname(path)),
    ];
    add('Git Bash', [
      ...gitRoots.flatMap(root => [
        win32.join(root, 'bin', 'bash.exe'),
        win32.join(root, 'usr', 'bin', 'bash.exe'),
      ]),
      ...onPath('bash.exe').filter(path =>
        /(?:^|[\\/])git(?:[\\/]|$)/i.test(path),
      ),
    ]);
  } else {
    const labels: Record<string, string> = {
      zsh: 'Zsh',
      bash: 'Bash',
      fish: 'Fish',
      nu: 'Nushell',
      sh: 'Sh',
    };
    const account = userShell();
    for (const path of [preferred, account]) {
      if (path)
        add(labels[posix.basename(path)] || posix.basename(path), [path]);
    }
    for (const name of ['zsh', 'bash', 'fish', 'nu', 'sh']) {
      if (profiles.some(profile => posix.basename(profile.path) === name))
        continue;
      add(labels[name], [
        ...onPath(name),
        ...[
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/run/current-system/sw/bin',
        ].map(path => posix.join(path, name)),
      ]);
    }
  }
  return {
    profiles,
    customProfiles: [],
    defaultProfileId:
      profiles.find(profile => key(profile.path) === key(preferred))?.id ??
      profiles[0]?.id ??
      '',
  };
}

/** Resolve saved choices against shells that are still installed. */
export class DesktopTerminalProfiles {
  private readonly preferences?: Pick<
    DesktopPreferences,
    | 'defaultTerminalProfile'
    | 'setDefaultTerminalProfile'
    | 'customTerminalProfiles'
    | 'saveTerminalProfile'
    | 'removeTerminalProfile'
  >;
  private readonly options: DetectionOptions;

  constructor(
    preferences?: Pick<
      DesktopPreferences,
      | 'defaultTerminalProfile'
      | 'setDefaultTerminalProfile'
      | 'customTerminalProfiles'
      | 'saveTerminalProfile'
      | 'removeTerminalProfile'
    >,
    options: DetectionOptions = {},
  ) {
    this.preferences = preferences;
    this.options = options;
  }

  get(): TerminalProfilesState {
    const state = detectTerminalProfiles(this.options);
    state.customProfiles = this.preferences?.customTerminalProfiles() ?? [];
    state.profiles.push(
      ...state.customProfiles
        .filter(profile => this.available(profile.path))
        .map(profile => ({...profile, custom: true as const})),
    );
    state.defaultProfileId ||= state.profiles[0]?.id ?? '';
    const saved = this.preferences?.defaultTerminalProfile();
    if (state.profiles.some(profile => profile.id === saved))
      state.defaultProfileId = saved!;
    return state;
  }

  private available(path: string): boolean {
    const platform = this.options.platform ?? process.platform;
    const paths = platform === 'win32' ? win32 : posix;
    return (
      paths.isAbsolute(path) &&
      (platform !== 'win32' || /\.(?:exe|com)$/i.test(path)) &&
      (this.options.exists?.(path) ?? executable(path, platform))
    );
  }

  save(input: unknown): TerminalProfilesState {
    if (!this.preferences)
      throw new Error('Terminal settings are unavailable.');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Choose a valid terminal profile.');
    const profile = input as {id?: unknown; label?: unknown; path?: unknown};
    if (
      Object.keys(profile).some(key => !['id', 'label', 'path'].includes(key))
    )
      throw new Error('Choose a valid terminal profile.');
    const existing = this.preferences.customTerminalProfiles();
    if (
      profile.id !== undefined &&
      (typeof profile.id !== 'string' ||
        !existing.some(item => item.id === profile.id))
    )
      throw new Error('Choose a saved terminal profile.');
    if (
      typeof profile.label !== 'string' ||
      !profile.label.trim() ||
      profile.label.length > 128 ||
      /\p{Cc}/u.test(profile.label)
    )
      throw new Error(
        'Enter a terminal profile name of at most 128 characters.',
      );
    if (
      typeof profile.path !== 'string' ||
      !profile.path ||
      profile.path.length > 4096 ||
      /\p{Cc}/u.test(profile.path) ||
      !this.available(profile.path)
    )
      throw new Error(
        'Choose an absolute path to an executable terminal application.',
      );
    const paths =
      (this.options.platform ?? process.platform) === 'win32' ? win32 : posix;
    this.preferences.saveTerminalProfile({
      id:
        typeof profile.id === 'string'
          ? profile.id
          : `custom-${randomUUID().replaceAll('-', '')}`,
      label: profile.label.trim(),
      path: paths.normalize(profile.path),
    });
    return this.get();
  }

  remove(profileId: unknown): TerminalProfilesState {
    if (
      !this.preferences ||
      typeof profileId !== 'string' ||
      !this.preferences
        .customTerminalProfiles()
        .some(profile => profile.id === profileId)
    )
      throw new Error('Choose a saved terminal profile.');
    this.preferences.removeTerminalProfile(profileId);
    return this.get();
  }

  setDefault(profileId: unknown): TerminalProfilesState {
    const state = this.get();
    if (
      typeof profileId !== 'string' ||
      !state.profiles.some(profile => profile.id === profileId)
    )
      throw new Error('Choose an installed shell profile.');
    this.preferences?.setDefaultTerminalProfile(profileId);
    return {...state, defaultProfileId: profileId};
  }

  resolve(profileId?: string): TerminalProfile {
    const state = this.get();
    const profile = state.profiles.find(
      profile => profile.id === (profileId ?? state.defaultProfileId),
    );
    if (!profile) throw new Error('Choose an installed shell profile.');
    return profile;
  }
}
