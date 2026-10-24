import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {AgentTemplate, AgentContextScope} from './templates.ts';
import type {AgentSessionSnapshot} from './team.ts';
import {WorkerConversation} from './conversation.ts';
import {
  messageText,
  projectMessage,
  type ConversationMessage,
} from '../conversation.ts';
import {
  copyModelUsage,
  ModelUsageTracker,
  sessionUsageCalls,
} from '../usage.ts';

export interface AgentWorkerConfiguration {
  agentProfile: AgentTemplate;
  instructions?: string;
  context: AgentContextScope;
}

export interface AgentHistory extends AgentSessionSnapshot {
  version: 1;
  messageSequence: number;
  configurations: Record<string, AgentWorkerConfiguration>;
}

function objectRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringFields(
  value: unknown,
  fields: string[],
): value is Record<string, string> {
  return (
    objectRow(value) && fields.every(field => typeof value[field] === 'string')
  );
}

function restoreAgent(
  value: unknown,
): AgentHistory['agents'][number] | undefined {
  if (
    !stringFields(value, [
      'id',
      'name',
      'task',
      'cwd',
      'model',
      'createdAt',
      'activity',
    ]) ||
    ![
      'queued',
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
    ].includes(value.status) ||
    !Array.isArray(value.conversation)
  )
    return undefined;
  const agent = value as unknown as AgentHistory['agents'][number];
  const conversation = agent.conversation.flatMap(row => {
    if (
      !stringFields(row, ['id', 'role', 'text', 'at']) ||
      !['user', 'assistant', 'tool'].includes(row.role)
    )
      return [];
    try {
      return [projectMessage(row as unknown as ConversationMessage)];
    } catch {
      return [];
    }
  });
  let usage: typeof agent.usage;
  try {
    if (agent.usage) usage = copyModelUsage(agent.usage);
  } catch {
    // Retain the conversation even when its usage summary is damaged.
  }
  const restored = {...agent, conversation, usage};
  for (const key of [
    'sessionFile',
    'resultFile',
    'output',
    'error',
    'startedAt',
    'finishedAt',
    'thinkingLevel',
    'pinnedModel',
  ] as const)
    if (typeof restored[key] !== 'string') delete restored[key];
  return restored;
}

/** Each parent owns its history alongside its retained Pi worker sessions. */
export class AgentHistoryStore {
  private pending?: () => AgentHistory;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  readonly path: string;
  readonly sessionId: string;

  constructor(agentDir: string, sessionId: string) {
    this.sessionId = sessionId;
    this.path = join(agentDir, 'varisdev', 'agents', sessionId, 'history.json');
  }

  read(): AgentHistory | undefined {
    try {
      if (!existsSync(this.path)) return this.readLegacy();
      const history: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (
        !objectRow(history) ||
        history.version !== 1 ||
        history.sessionId !== this.sessionId ||
        !Array.isArray(history.agents) ||
        !Array.isArray(history.messages) ||
        !Array.isArray(history.changes) ||
        !objectRow(history.configurations)
      )
        throw new Error('Invalid agent history.');
      const agents = history.agents.flatMap(value => {
        try {
          const agent = restoreAgent(value);
          return agent ? [agent] : [];
        } catch {
          return [];
        }
      });
      if (agents.length < history.agents.length) {
        const retained = new Set(agents.map(agent => agent.id));
        for (const agent of this.readLegacy()?.agents ?? [])
          if (!retained.has(agent.id)) agents.push(agent);
      }
      const messages = history.messages.filter(
        value =>
          stringFields(value, ['id', 'createdAt', 'message']) &&
          stringFields(value.from, ['id', 'name']),
      ) as AgentHistory['messages'];
      const changes = history.changes.filter(
        (value): value is AgentHistory['changes'][number] =>
          stringFields(value, [
            'id',
            'unitId',
            'unitName',
            'path',
            'tool',
            'at',
            'diff',
            'summary',
          ]),
      );
      const configurations = Object.fromEntries(
        Object.entries(history.configurations).filter(
          ([, value]) =>
            objectRow(value) &&
            ['workspace', 'task'].includes(String(value.context)) &&
            stringFields(value.agentProfile, ['id', 'name', 'instructions']) &&
            Array.isArray(value.agentProfile.permissions),
        ),
      ) as AgentHistory['configurations'];
      return {
        version: 1,
        sessionId: this.sessionId,
        agents,
        messages,
        changes,
        configurations,
        messageSequence:
          Number.isSafeInteger(history.messageSequence) &&
          Number(history.messageSequence) >= messages.length
            ? Number(history.messageSequence)
            : messages.length,
      };
    } catch (error) {
      console.error('Could not restore agent history:', error);
      return this.readLegacy();
    }
  }

  private readLegacy(): AgentHistory | undefined {
    try {
      return this.importLegacy();
    } catch (error) {
      console.error('Could not read older agent history:', error);
      return undefined;
    }
  }

  private importLegacy(): AgentHistory | undefined {
    const directory = dirname(this.path);
    if (!existsSync(directory)) return undefined;
    const agents: AgentHistory['agents'] = [];
    for (const folder of readdirSync(directory, {withFileTypes: true})) {
      if (!folder.isDirectory()) continue;
      try {
        const workerDirectory = join(directory, folder.name);
        const transcript = readdirSync(workerDirectory)
          .filter(name => name.endsWith('.jsonl'))
          .sort()
          .at(-1);
        if (!transcript) continue;
        const sessionFile = join(workerDirectory, transcript);
        const manager = SessionManager.open(sessionFile);
        const header = manager.getHeader();
        if (!header) continue;
        const branch = manager.getBranch();
        const messages = branch.flatMap(entry =>
          entry.type === 'message' ? [entry.message] : [],
        );
        const task = messages.find(message => message.role === 'user');
        if (!task) continue;
        const last = messages.at(-1);
        const assistant = last?.role === 'assistant' ? last : undefined;
        const completed =
          assistant?.stopReason === 'stop' &&
          !assistant.content.some(part => part.type === 'toolCall');
        const failed = assistant?.stopReason === 'error';
        const context = manager.buildSessionContext();
        const usage = new ModelUsageTracker();
        usage.replace(sessionUsageCalls(branch));
        agents.push({
          id: folder.name,
          name: manager.getSessionName() ?? 'Agent',
          task: messageText(task),
          cwd: manager.getCwd(),
          model: context.model
            ? `${context.model.provider}/${context.model.modelId}`
            : '',
          thinkingLevel: context.thinkingLevel,
          status: completed ? 'completed' : failed ? 'failed' : 'cancelled',
          activity: completed ? 'Completed' : failed ? 'Failed' : 'Interrupted',
          resumable: false,
          createdAt: header.timestamp,
          startedAt: new Date(task.timestamp).toISOString(),
          finishedAt: branch.at(-1)?.timestamp ?? header.timestamp,
          sessionFile,
          ...(existsSync(join(workerDirectory, 'result.txt'))
            ? {resultFile: join(workerDirectory, 'result.txt')}
            : {}),
          ...(completed ? {output: messageText(assistant)} : {}),
          ...(assistant?.errorMessage ? {error: assistant.errorMessage} : {}),
          usage: usage.snapshot(),
          ...new WorkerConversation(branch, manager.getCwd()).snapshot(),
        });
      } catch (error) {
        console.error('Could not restore an older agent conversation:', error);
      }
    }
    return agents.length
      ? {
          version: 1,
          sessionId: this.sessionId,
          agents,
          messages: [],
          changes: [],
          messageSequence: 0,
          configurations: {},
        }
      : undefined;
  }

  save(history: () => AgentHistory): void {
    this.pending = history;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(error => {
        console.error('Could not save agent history:', error);
      });
    }, 100);
    this.timer.unref();
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      const history = pending();
      const write = async () => {
        await mkdir(dirname(this.path), {recursive: true});
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(history), {mode: 0o600});
          await rename(temporary, this.path);
        } finally {
          await rm(temporary, {force: true});
        }
      };
      this.writing = this.writing.catch(() => {}).then(write);
    }
    return this.writing;
  }
}
