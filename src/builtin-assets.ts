import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function findVarisDevPackageRoot(
  modulePath = fileURLToPath(import.meta.url),
): string {
  let directory = dirname(modulePath);
  while (true) {
    const manifest = join(directory, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown;
      };
      if (parsed.name === 'varisdev') return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error('Could not locate the VarisDev package assets.');
    directory = parent;
  }
}

export const builtinAssetsDirectory = join(findVarisDevPackageRoot(), 'assets');
export const builtinAgentsDirectory = join(builtinAssetsDirectory, 'agents');
export const builtinDefaultAgentPath = join(
  builtinAgentsDirectory,
  'default.md',
);
