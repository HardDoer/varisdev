import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import lockfile from 'proper-lockfile';
import {agentStorageId, historyLastUsed} from './retention-policy.ts';
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
  lastUsed?: Record<string, string>;
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

function isWorkerConfiguration(
  value: unknown,
): value is AgentWorkerConfiguration {
  return (
    objectRow(value) &&
    (value.context === 'workspace' || value.context === 'task') &&
    stringFields(value.agentProfile, ['id', 'name', 'instructions']) &&
    Array.isArray(value.agentProfile.permissions)
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
  if (
    !Number.isSafeInteger(restored.creationOrder) ||
    restored.creationOrder! < 0
  )
    delete restored.creationOrder;
  for (const key of [
    'sessionFile',
    'resultFile',
    'output',
    'error',
    'startedAt',
    'finishedAt',
    'lastUsedAt',
    'thinkingLevel',
    'pinnedModel',
  ] as const)
    if (typeof restored[key] !== 'string') delete restored[key];
  return restored;
}

/** Each parent owns its history alongside its retained Pi worker sessions. */
export class AgentHistoryStore {
  private pending?: () => AgentHistory;
  private pendingRemoved = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  readonly path: string;
  readonly sessionId: string;

  constructor(agentDir: string, sessionId: string) {
    if (!agentStorageId.test(sessionId))
      throw new Error('Invalid agent session ID.');
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
      const lastUsed = historyLastUsed(history);
      const agents: AgentHistory['agents'] = history.agents.flatMap(value => {
        try {
          const agent = restoreAgent(value);
          return agent
            ? [
                {
                  ...agent,
                  lastUsedAt: lastUsed.get(agent.id) ?? agent.lastUsedAt,
                },
              ]
            : [];
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
        Object.entries(history.configurations).filter(([, value]) =>
          isWorkerConfiguration(value),
        ),
      ) as AgentHistory['configurations'];
      return {
        version: 1,
        sessionId: this.sessionId,
        lastUsed: Object.fromEntries(lastUsed),
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

  save(history: () => AgentHistory, removed: Iterable<string> = []): void {
    this.pending = history;
    for (const id of removed) this.pendingRemoved.add(id);
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
      const removed = new Set(this.pendingRemoved);
      this.pendingRemoved.clear();
      const history = pending();
      const write = async () => {
        await mkdir(dirname(this.path), {recursive: true});
        const release = await lockfile.lock(this.path, {
          realpath: false,
          lockfilePath: join(
            dirname(dirname(this.path)),
            `.history-${this.sessionId}.lock`,
          ),
          stale: 300000,
          retries: {retries: 100, minTimeout: 20, maxTimeout: 100},
        });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          let previous: unknown;
          try {
            previous = JSON.parse(readFileSync(this.path, 'utf8'));
          } catch (error) {
            if (
              !(error instanceof SyntaxError) &&
              (error as NodeJS.ErrnoException).code !== 'ENOENT'
            )
              throw error;
          }
          const saved =
            objectRow(previous) &&
            previous.version === 1 &&
            previous.sessionId === this.sessionId
              ? previous
              : {};
          const used = historyLastUsed(saved, history);
          const agents = history.agents.filter(agent => !removed.has(agent.id));
          const known = new Set(agents.map(agent => agent.id));
          const configurations = {...history.configurations};
          for (const id of removed) {
            used.delete(id);
            delete configurations[id];
          }
          // An omitted record may have been created by another owner. Only an
          // explicit expiry removes it and its saved resume configuration.
          for (const value of Array.isArray(saved.agents) ? saved.agents : []) {
            if (
              !objectRow(value) ||
              typeof value.id !== 'string' ||
              !agentStorageId.test(value.id) ||
              known.has(value.id) ||
              removed.has(value.id)
            )
              continue;
            let agent: AgentHistory['agents'][number] | undefined;
            try {
              agent = restoreAgent(value);
            } catch {
              continue;
            }
            if (!agent) continue;
            agents.push(agent);
            known.add(agent.id);
          }
          for (const agent of agents) {
            const configuration = objectRow(saved.configurations)
              ? saved.configurations[agent.id]
              : undefined;
            if (
              !Object.hasOwn(configurations, agent.id) &&
              isWorkerConfiguration(configuration)
            )
              configurations[agent.id] = configuration;
          }
          for (const id of used.keys())
            if (
              !agentStorageId.test(id) ||
              (!known.has(id) && !existsSync(join(dirname(this.path), id)))
            )
              used.delete(id);
          const merged = {
            ...history,
            lastUsed: Object.fromEntries(used),
            configurations,
            agents: agents.map(agent => ({
              ...agent,
              lastUsedAt: used.get(agent.id) ?? agent.lastUsedAt,
            })),
          };
          await writeFile(temporary, JSON.stringify(merged), {mode: 0o600});
          await rename(temporary, this.path);
        } finally {
          try {
            await rm(temporary, {force: true});
          } finally {
            await release();
          }
        }
      };
      this.writing = this.writing.catch(() => {}).then(write);
    }
    return this.writing;
  }
}
