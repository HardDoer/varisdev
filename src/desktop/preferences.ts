import {readFileSync, writeFileSync, mkdirSync, statSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

/** Desktop preferences live in the installed package's .pi/desktop profile. */
export class DesktopPreferences {
  private lastFolder?: string;
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    try {
      const saved: unknown = JSON.parse(
        readFileSync(join(directory, 'settings.json'), 'utf8'),
      );
      if (
        saved &&
        typeof saved === 'object' &&
        'lastFolder' in saved &&
        typeof saved.lastFolder === 'string' &&
        isAbsolute(saved.lastFolder)
      )
        this.lastFolder = saved.lastFolder;
    } catch {
      // A new profile starts in the launch folder.
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

  rememberFolder(folder: string): void {
    this.lastFolder = folder;
    mkdirSync(this.directory, {recursive: true});
    writeFileSync(
      join(this.directory, 'settings.json'),
      JSON.stringify({lastFolder: folder}, null, 2) + '\n',
    );
  }
}
