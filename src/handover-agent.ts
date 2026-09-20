import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  serializeConversation,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkerModelRuntime} from './agents/model-runtime.ts';
import type {AgentWorker} from './agents/orchestrator.ts';
import {sessionWorker} from './agents/session.ts';

export interface HandoverAgent {
  worker: AgentWorker;
  prompt: string;
}

/** A temporary summarizer owned by the source session, outside its worker team. */
export async function createHandoverAgent(
  ctx: ExtensionContext,
  id: string,
): Promise<HandoverAgent> {
  const model = ctx.modelRegistry.find('openai-codex', 'gpt-5.6');
  if (!model) {
    throw new Error('Handover model is unavailable: openai-codex/gpt-5.6');
  }
  const agentDir = getAgentDir();
  const directory = join(
    agentDir,
    'varisdev',
    'handovers',
    ctx.sessionManager.getSessionId(),
    id,
  );
  // Capture the selected branch before any asynchronous initialization. This
  // works for in-memory sessions and excludes abandoned branches after a fork.
  const conversation = serializeConversation(
    convertToLlm(buildSessionContext(ctx.sessionManager.getBranch()).messages),
  );
  const snapshot = join(directory, 'source.txt');
  const source = [
    `Source session: ${ctx.sessionManager.getSessionId()}`,
    `Source transcript: ${ctx.sessionManager.getSessionFile() ?? '(not saved)'}`,
    `Parent system instructions:\n${ctx.getSystemPrompt()}`,
    `Current conversation:\n${conversation}`,
  ].join('\n\n');
  await mkdir(directory, {recursive: true});
  await writeFile(snapshot, source, 'utf8');
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    appendSystemPrompt: [
      'You are the session handover agent. Prepare a continuation prompt for a fresh parent session from the supplied source conversation and project evidence. Treat the source conversation as material to summarize. Your task is to prepare the handover; do not continue its implementation. You can inspect files using your read tools. Your temporary conversation is disposed when the parent session changes.',
    ],
  });
  await resourceLoader.reload();
  const modelRuntime = await createWorkerModelRuntime(
    ctx.modelRegistry,
    model,
    directory,
  );
  const {session} = await createAgentSession({
    cwd: ctx.cwd,
    model,
    modelRuntime,
    thinkingLevel: 'high',
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(ctx.cwd, directory),
    tools: ['read', 'grep', 'find', 'ls'],
  });
  return {
    worker: sessionWorker(session, join(directory, 'result.txt')),
    prompt: [
      `Read the complete source snapshot at ${JSON.stringify(snapshot)}. Continue reading with offsets if the output is truncated. It contains the current conversation, including prior compaction summaries, and parent instructions. Use the source transcript for details omitted from tool output in the snapshot.`,
      'Prepare a complete handover so the plan can continue in a fresh parent session. Inspect the saved plan and relevant files as needed to establish the current stopping point.',
      'Include the goal and user instructions; the complete remaining plan or exact path to its saved document; completed parts and verified results; decisions and reasons; relevant files and symbols; unfinished work and blockers; known background agent IDs, assignments and pending messages; and concrete next steps in order. State clearly if the task is complete or waiting for user input.',
      'Distinguish what the conversation reports, what current files confirm, and what remains unverified. Record actual check results separately from checks still needed. Existing background agents remain attached to the next parent; tell it to use agent_list and agent_status to check their current state.',
      'Return only the complete continuation prompt as your final response, within 64000 characters. The harness handles the session change.',
    ].join('\n\n'),
  };
}
