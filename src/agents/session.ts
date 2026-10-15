import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionContext,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {registerProjectTools} from '../tools/index.ts';
import {createBuiltinExtensions} from '../builtin-extensions.ts';
import {createAppResourceFilter} from '../dashboard/resources.ts';
import type {AgentWorker} from './orchestrator.ts';
import {
  createWorkerModelRuntime,
  flushPendingVirtualModelRegistrations,
} from './model-runtime.ts';
import {WorkerConversation} from './conversation.ts';
import {
  modelUsage,
  sessionUsageCalls,
  ModelUsageTracker,
  type ModelUsage,
} from '../usage.ts';

interface WorkerOptions {
  id: string;
  parentSessionId: string;
  cwd: string;
  name: string;
  instructions?: string;
  model: NonNullable<CreateAgentSessionOptions['model']>;
  modelRegistry: ExtensionContext['modelRegistry'];
  thinkingLevel: CreateAgentSessionOptions['thinkingLevel'];
  agentToolsExtension: ExtensionFactory;
}

/** Translate Pi's session lifecycle into a cancellable background worker. */
export function sessionWorker(
  session: AgentSession,
  resultFile: string,
): AgentWorker {
  const usage = new ModelUsageTracker();
  const conversation = new WorkerConversation(
    session.sessionManager.getBranch?.() ?? [],
    session.sessionManager.getCwd?.(),
  );
  let finishing = false;
  let closing: Promise<void> | undefined;
  let publishUsage: ((usage: ModelUsage) => void) | undefined;
  function restoreUsage(): void {
    const branch = session.sessionManager.getBranch?.();
    if (branch) usage.replace(sessionUsageCalls(branch));
  }
  restoreUsage();
  // Idle cache warming can append usage between runs. Keep this subscription
  // for the worker lifetime so the orchestrator's cached record stays current.
  const unsubscribeUsage = session.subscribe(event => {
    if (event.type !== 'entry_appended' || event.entry.type !== 'usage') return;
    restoreUsage();
    publishUsage?.(usage.snapshot());
  });
  return {
    sessionFile: session.sessionManager.getSessionFile(),
    resultFile,
    get usage() {
      restoreUsage();
      return usage.snapshot();
    },
    get conversation() {
      return conversation.snapshot();
    },
    async steer(message, starting) {
      if (finishing && !starting) return false;
      await session.steer(message);
      return true;
    },
    async run(message, signal, onActivity, onUsage, onConversation) {
      signal.throwIfAborted();
      if (onUsage) publishUsage = onUsage;
      finishing = false;
      conversation.begin();
      let aborting: Promise<void> | undefined;
      const abort = () => {
        session.clearQueue();
        session.abortCompaction();
        session.abortBash();
        aborting = session.abort().catch(() => {});
      };
      const unsubscribe = session.subscribe(event => {
        if (conversation.record(event))
          onConversation?.(conversation.snapshot());
        if (
          event.type === 'message_end' &&
          event.message.role === 'assistant'
        ) {
          let sequence = 0;
          let found = false;
          for (const entry of session.sessionManager.getBranch?.() ?? []) {
            if (entry.type !== 'message') continue;
            if (
              entry.message.role !== 'user' &&
              entry.message.role !== 'assistant'
            )
              continue;
            sequence++;
            if (entry.message === event.message) {
              found = true;
              break;
            }
          }
          // SDK listeners run before this assistant message is appended to history.
          if (!found) sequence++;
          const call = modelUsage(event.message, {
            id: `message-assistant-${event.message.timestamp}-${sequence}`,
            at: new Date(event.message.timestamp).toISOString(),
          });
          if (call && usage.record(call, sequence)) onUsage?.(usage.snapshot());
        }
        if (event.type === 'compaction_end' && event.result && !event.aborted) {
          restoreUsage();
          onUsage?.(usage.snapshot());
        }
        // Abort again if cancellation happened during prompt preflight.
        if (signal.aborted) {
          if (event.type === 'agent_start') abort();
          return;
        }
        if (event.type === 'tool_execution_start') {
          onActivity(`Using ${event.toolName}`);
        } else if (
          (event.type === 'message_start' || event.type === 'message_update') &&
          event.message.role === 'assistant'
        ) {
          const writing = event.message.content.some(
            part => part.type === 'text' && part.text,
          );
          onActivity(writing ? 'Responding' : 'Thinking');
        } else if (event.type === 'auto_retry_start') {
          onActivity(`Retrying (attempt ${event.attempt})`);
        } else if (event.type === 'compaction_start') {
          onActivity('Compacting conversation');
        }
      });
      signal.addEventListener('abort', abort, {once: true});
      let failure: unknown;
      try {
        await session.prompt(message, {expandPromptTemplates: false});
        finishing = true;
        signal.throwIfAborted();
        const lastAssistant = session.messages.findLast(
          item => item.role === 'assistant',
        );
        if (!lastAssistant || lastAssistant.role !== 'assistant') {
          throw new Error('Agent finished without an assistant response.');
        }
        if (
          lastAssistant.stopReason !== 'stop' ||
          lastAssistant.content.some(part => part.type === 'toolCall')
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
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        finishing = true;
        signal.removeEventListener('abort', abort);
        try {
          await aborting;
          const cause = signal.aborted ? signal.reason : failure;
          conversation.settle(
            signal.aborted,
            cause instanceof Error
              ? cause.message
              : cause === undefined
                ? undefined
                : String(cause),
          );
          onConversation?.(conversation.snapshot());
          restoreUsage();
          onUsage?.(usage.snapshot());
        } finally {
          unsubscribe();
        }
      }
    },
    dispose() {
      if (closing) return closing;
      publishUsage = undefined;
      unsubscribeUsage();
      closing = (async () => {
        try {
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
  const resources = createAppResourceFilter(
    settingsManager,
    options.cwd,
    agentDir,
  );
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager: resources.settingsManager,
    noThemes: true,
    noPromptTemplates: true,
    extensionFactories: [
      ...createBuiltinExtensions(),
      registerProjectTools,
      options.agentToolsExtension,
    ],
    appendSystemPrompt: [
      `You are the delegated agent ${JSON.stringify(options.name)}. Your agent ID is ${options.id}. Complete the assigned task and report your findings, changed files, checks, and any remaining issues to the parent agent.`,
      'Your conversation contains the delegated task and steering messages. Use project files for additional context. Other agents may work in this directory; coordinate file ownership with them using agent_send and preserve their changes.',
      'Use agent_list to find peers in this parent session and agent_send with a peer ID to message them directly. Use agent_send with id="parent" to store a message for the parent to read with agent_inbox. This does not notify or wake the parent. Put your final result in your final answer; avoid duplicating it through agent_send. Your name and ID are attached automatically. Peer messages steer active work at the next turn boundary; completed agents resume their conversation to handle them.',
      ...(options.instructions ? [options.instructions] : []),
    ],
  });
  await loader.reload();
  const sessionManager = SessionManager.create(options.cwd, directory);
  const modelRuntime = await createWorkerModelRuntime(
    options.modelRegistry,
    options.model,
    directory,
  );
  flushPendingVirtualModelRegistrations(
    loader.getExtensions().runtime,
    modelRuntime,
  );
  if (
    options.model.api === 'pi-virtual' &&
    !modelRuntime.getModel(options.model.provider, options.model.id)
  )
    throw new Error(
      `Virtual model ${options.model.provider}/${options.model.id} is not registered in this worker. Load its extension in the worker's project or global settings.`,
    );
  const {session} = await createAgentSession({
    cwd: options.cwd,
    model: options.model,
    modelRuntime,
    thinkingLevel: options.thinkingLevel,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  const worker = sessionWorker(session, join(directory, 'result.txt'));
  try {
    await session.bindExtensions({mode: 'rpc'});
    return worker;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}
