import {DesktopPreferences} from './preferences.ts';

export interface DesktopWhatsNewState {
  release: {version: string; changes: string[]} | undefined;
  seen: boolean;
}

const releases = new Map<string, readonly string[]>([
  [
    '1.14.1',
    [
      'Effort appears beside the model in the conversation header.',
      'Removed the duplicate status and activity from the conversation header. Activity remains at the bottom of the conversation.',
    ],
  ],
  [
    '1.14.0',
    [
      'The selected agent’s model appears in the conversation header.',
      'Agent status uses Running instead of Working, with one status indicator in the selected agent header.',
      'Added GPT Image 2.6 Sunburst and Flare, image complexity, edits with markup, SVG output, and animated GIF output.',
    ],
  ],
  ['1.13.4', ['Removed the 64-agent limit per workspace.']],
  ['1.13.3', ['Removed agent execution timeouts.']],
  [
    '1.13.2',
    [
      'The selected agent’s effort level appears in the conversation header, including when the visualization is hidden.',
    ],
  ],
  [
    '1.13.1',
    [
      'Context usage and Markdown files are available in the selected agent header, including when the visualization is hidden.',
    ],
  ],
  [
    '1.13.0',
    [
      'Agents use configuration names and primary or subagent labels.',
      'The large robot follows the conversation starter, then the second most recent remaining primary.',
      'Close primary agents individually. Closing the last primary asks for confirmation and closes the workspace.',
    ],
  ],
  [
    '1.12.0',
    [
      'Open multiple terminal tabs in each workspace and choose from installed shells.',
      'Save custom shell locations and choose a default terminal profile.',
      'Windows terminals use PowerShell 7 when installed and load your user profile and environment settings.',
    ],
  ],
  [
    '1.11.0',
    [
      'Release notes appear after installing a new version.',
      'Reopen release notes from Menu → What’s new.',
    ],
  ],
]);

export class DesktopWhatsNew {
  private readonly preferences: DesktopPreferences;
  private readonly version: string;

  constructor(preferences: DesktopPreferences, version: string) {
    this.preferences = preferences;
    this.version = version;
  }

  get(): DesktopWhatsNewState {
    const changes = releases.get(this.version);
    return {
      release: changes
        ? {version: this.version, changes: [...changes]}
        : undefined,
      seen: !!changes && this.preferences.whatsNewSeen(this.version),
    };
  }

  markSeen(version: unknown): DesktopWhatsNewState {
    if (
      typeof version !== 'string' ||
      version !== this.version ||
      !releases.has(version)
    )
      throw new Error('Choose release notes for the running version.');
    this.preferences.markWhatsNewSeen(version);
    return this.get();
  }
}
