import {join} from 'node:path';
import {environmentForChild} from '../runtime/environment.mjs';
import type {DashboardHubSnapshot} from '../dashboard/hub.ts';
import type {UpdateStatus} from '../runtime/manager.ts';

/** Restart is available only after staging and while every session is idle. */
export function requireUpdateRestart(
  status: UpdateStatus,
  snapshot: DashboardHubSnapshot,
  pendingOperations = 0,
): void {
  if (!['ready', 'error'].includes(status.phase) || !status.restartRequired) {
    throw new Error('Finish updating VarisDev before restarting.');
  }
  if (
    pendingOperations ||
    snapshot.sessions.some(
      item =>
        !['idle', 'closed'].includes(item.session.status) ||
        item.agents.some(agent =>
          ['queued', 'running', 'cancelling'].includes(agent.status),
        ) ||
        !!item.queue?.steering.length ||
        !!item.queue?.followUp.length,
    )
  ) {
    throw new Error(
      'Wait for workspaces and agents to finish, then retry restarting.',
    );
  }
}

export function updateRestartCommand(
  installRoot: string,
  nodeExecutable: string | undefined,
  electronExecutable: string,
  project?: string,
): {executable: string; args: string[]; env: NodeJS.ProcessEnv} {
  const env = environmentForChild();
  if (nodeExecutable) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = '1';
  return {
    executable: nodeExecutable || electronExecutable,
    args: [
      join(installRoot, 'bin', 'varisdev.mjs'),
      ...(project ? [project] : ['--overview']),
    ],
    env,
  };
}

/** Brand prose while retaining technical paths and package names. */
export function updateMessage(message: string): string {
  return message
    .replace(/(?<![\w./\\@-])Pi(?![\w/\\@-]|\.[\w])/gi, 'VarisDev')
    .replace(
      /(?<![\w./\\@-])VarisDev runtime(?![\w/\\@-]|\.[\w])/gi,
      'VarisDev',
    )
    .slice(0, 2000);
}

export function publicUpdateStatus(status: UpdateStatus): UpdateStatus {
  return {
    ...status,
    ...(status.phase === 'error' && status.restartRequired
      ? {phase: 'ready'}
      : {}),
    ...(status.error ? {error: updateMessage(status.error)} : {}),
  };
}
