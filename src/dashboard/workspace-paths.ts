import {createHash} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

export interface WorkspaceConfigPaths {
  projectDir: string;
  repositoryConfigDir: string;
  workspaceDir: string;
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A worktree has its own configuration; symlink aliases share that configuration. */
export function workspaceConfigPaths(
  cwd: string,
  agentDir: string,
  configDirName: string,
): WorkspaceConfigPaths {
  const canonical = canonicalDirectory(cwd);
  const settings = canonicalDirectory(agentDir);
  const globalMarkers = new Set([
    canonicalDirectory(join(homedir(), configDirName)),
    settings,
    dirname(settings),
    canonicalDirectory(dirname(resolve(agentDir))),
  ]);
  let projectDir = canonical;
  let configRoot: string | undefined;
  for (let current = canonical; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) {
      projectDir = current;
      break;
    }
    const marker = join(current, configDirName);
    // Global settings belong to every project, so they cannot identify one.
    if (
      !configRoot &&
      existsSync(marker) &&
      !globalMarkers.has(canonicalDirectory(marker))
    )
      configRoot = current;
    if (dirname(current) === current) {
      projectDir = configRoot ?? canonical;
      break;
    }
  }
  return {
    projectDir,
    repositoryConfigDir: join(projectDir, configDirName),
    workspaceDir: join(
      agentDir,
      'workspaces',
      createHash('sha256').update(projectDir).digest('hex'),
    ),
  };
}
