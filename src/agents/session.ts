import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {registerProjectTools} from '../tools/index.ts';
import type {AgentWorker} from './orchestrator.ts';

interface WorkerOptions {
  id: string;
  parentSessionId: string;
  previousSessionFile?: string;
  cwd: string;
  name: string;
  instructions?: string;
  model: NonNullable<CreateAgentSessionOptions['model']>;
  modelRegistry: NonNullable<CreateAgentSessionOptions['modelRegistry']>;
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel'];
  agentToolsExtension: ExtensionFactory;
}

/** Translate Pi's session lifecycle into a cancellable background worker. */
export function sessionWorker(
  session: AgentSession,
  resultFile: string,
): AgentWorker {
  return {
    sessionFile: session.sessionManager.getSessionFile(),
    resultFile,
    async run(message, signal, onActivity) {
      signal.throwIfAborted();
      let aborting: Promise<void> | undefined;
      const abort = () => {
        session.abortCompaction();
        session.abortBash();
        aborting = session.abort().catch(() => {});
      };
      const unsubscribe = session.subscribe(event => {
        // Abort again if cancellation happened during prompt preflight.
        if (signal.aborted) {
          if (event.type === 'agent_start') abort();
          return;
        }
        if (event.type === 'tool_execution_start') {
          onActivity(`Using ${event.toolName}`);
        } else if (
          event.type === 'message_start' &&
          event.message.role === 'assistant'
        ) {
          onActivity('Responding');
        } else if (event.type === 'auto_retry_start') {
          onActivity(`Retrying (attempt ${event.attempt})`);
        } else if (event.type === 'compaction_start') {
          onActivity('Compacting conversation');
        }
      });
      signal.addEventListener('abort', abort, {once: true});
      try {
        await session.prompt(message, {expandPromptTemplates: false});
        signal.throwIfAborted();
        const lastAssistant = session.messages.findLast(
          item => item.role === 'assistant',
        );
        if (!lastAssistant || lastAssistant.role !== 'assistant') {
          throw new Error('Agent finished without an assistant response.');
        }
        if (
          lastAssistant.stopReason === 'error' ||
          lastAssistant.stopReason === 'aborted'
        ) {
          throw new Error(
            lastAssistant.errorMessage || `Agent ${lastAssistant.stopReason}.`,
          );
        }
        const output = lastAssistant.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n');
        await writeFile(resultFile, output, 'utf8');
        return output;
      } finally {
        signal.removeEventListener('abort', abort);
        unsubscribe();
        await aborting;
      }
    },
    dispose() {
      session.dispose();
    },
  };
}

export async function createSessionWorker(
  options: WorkerOptions,
): Promise<AgentWorker> {
  const agentDir = getAgentDir();
  const directory = join(
    agentDir,
    'varisdev',
    'agents',
    options.parentSessionId,
    options.id,
  );
  await mkdir(directory, {recursive: true});
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [registerProjectTools, options.agentToolsExtension],
    appendSystemPrompt: [
      `You are the delegated agent ${JSON.stringify(options.name)}. Your agent ID is ${options.id}. Complete the assigned task and report your findings, changed files, checks, and any remaining issues to the parent agent.`,
      'Your conversation contains the delegated task and follow-up messages. Use project files for additional context. Other agents may work in this directory; coordinate file ownership with them using agent_send and preserve their changes.',
      'Use agent_list to find peers in this parent session and agent_send with a peer ID to message them directly. Use agent_send with id="parent" to message the parent. Your name and ID are attached automatically. Peer messages queue after the current task; completed agents resume their conversation to handle them.',
      'Use agent_new_session for a requested session change or an ongoing workflow with automatic handovers. Complete ordinary tasks in the current session. Include the task, user instructions for continuing through handovers, progress, and next steps in the handover; make this your last tool call in the old conversation. You retain your agent ID and pending messages, and work continues automatically in a fresh conversation.',
      ...(options.instructions ? [options.instructions] : []),
    ],
  });
  await loader.reload();
  const sessionManager = SessionManager.create(options.cwd, directory);
  if (options.previousSessionFile) {
    sessionManager.newSession({parentSession: options.previousSessionFile});
  }
  const {session} = await createAgentSession({
    cwd: options.cwd,
    model: options.model,
    modelRegistry: options.modelRegistry,
    authStorage: options.modelRegistry.authStorage,
    thinkingLevel: options.thinkingLevel,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  return sessionWorker(session, join(directory, 'result.txt'));
}
