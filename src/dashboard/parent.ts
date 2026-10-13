import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkerModelRuntime} from '../agents/model-runtime.ts';
import type {AgentSessionController} from '../agents/team.ts';
import {registerCommitCommand} from '../commit.ts';
import {registerAgentTools} from '../tools/agents.ts';
import {registerProjectTools} from '../tools/index.ts';
import type {DashboardParent, ParentRequest} from './hub.ts';
import {observeDashboardSession} from './observe.ts';
import type {DashboardState} from './state.ts';

export interface ParentModel {
  model: NonNullable<CreateAgentSessionOptions['model']>;
  modelRegistry: ExtensionContext['modelRegistry'];
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel'];
}

/** A full parent conversation with its own folder, history, tools and workers. */
export async function createDashboardParent(
  request: ParentRequest,
  inherited?: ParentModel,
): Promise<DashboardParent> {
  const agentDir = getAgentDir();
  const sessionManager = SessionManager.create(request.cwd);
  const directory = join(
    agentDir,
    'varisdev',
    'dashboard',
    sessionManager.getSessionId(),
  );
  await mkdir(directory, {recursive: true});
  const settingsManager = SettingsManager.create(request.cwd, agentDir);
  let state: DashboardState | undefined;
  let context: ExtensionContext | undefined;
  let control: AgentSessionController | undefined;
  const loader = new DefaultResourceLoader({
    cwd: request.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    extensionFactories: [
      pi => {
        registerProjectTools(pi);
        control = registerAgentTools(pi);
        registerCommitCommand(pi);
        observeDashboardSession(pi, control, (current, ctx) => {
          state = current;
          context = ctx;
        });
      },
    ],
  });
  await loader.reload();
  const modelRuntime = inherited
    ? await createWorkerModelRuntime(
        inherited.modelRegistry,
        inherited.model,
        directory,
      )
    : undefined;
  const {session} = await createAgentSession({
    cwd: request.cwd,
    agentDir,
    model: inherited?.model,
    modelRuntime,
    thinkingLevel: inherited?.thinkingLevel,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  try {
    if (request.name) session.setSessionName(request.name);
    await session.bindExtensions({mode: 'rpc'});
    if (!state || !context || !control)
      throw new Error('Parent session observation did not start.');
  } catch (error) {
    session.dispose();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  let activePrompt: {cancelled: boolean; operation: Promise<void>} | undefined;
  const cancelWorkers = () => {
    if (!control!.snapshot()) return;
    const manager = control!.getTeam(context!).getManager();
    for (const agent of manager.list()) manager.cancel(agent.id);
  };
  const stop = () => {
    session.clearQueue();
    session.abortRetry();
    session.abortCompaction();
    session.abortBash();
    cancelWorkers();
    return session.abort();
  };
  const abort = async () => {
    const running = activePrompt;
    if (running) running.cancelled = true;
    try {
      await stop();
    } finally {
      // SDK preflight can still be waiting for credentials before agent_start.
      await running?.operation.catch(() => {});
      // A tool may have spawned a worker just before the parent's abort settled.
      cancelWorkers();
    }
  };
  return {
    state,
    async prompt(text) {
      if (closed) throw new Error('This parent session has closed.');
      if (activePrompt)
        throw new Error('This parent session is already working.');
      const running = {cancelled: false, operation: Promise.resolve()};
      activePrompt = running;
      running.operation = Promise.resolve()
        .then(async () => {
          if (running.cancelled) return;
          let aborting: Promise<void> | undefined;
          const unsubscribe = session.subscribe(event => {
            if (running.cancelled && event.type === 'agent_start') {
              aborting = stop().catch(() => {});
            }
          });
          try {
            await session.prompt(text, {expandPromptTemplates: false});
          } finally {
            unsubscribe();
            await aborting;
          }
        })
        .finally(() => {
          if (activePrompt === running) activePrompt = undefined;
        });
      await running.operation;
    },
    abort,
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          await abort();
          await session.extensionRunner.emit({
            type: 'session_shutdown',
            reason: 'quit',
          });
        } finally {
          session.dispose();
        }
      })();
      return closing;
    },
  };
}
