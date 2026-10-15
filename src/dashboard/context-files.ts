import {basename, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
  parseSkillBlock,
  type BuildSystemPromptOptions,
  type ResourceLoader,
  type SessionContext,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type {SessionFeatures} from './features.ts';

type ContextFile = NonNullable<SessionFeatures['contextFiles']>[number];
type Messages = SessionContext['messages'];

const filePreviewLimit = 8000;
const totalPreviewLimit = 64000;

function instructions(
  files: NonNullable<BuildSystemPromptOptions['contextFiles']>,
): ContextFile[] {
  return files.map(file => ({
    path: file.path,
    name: basename(file.path),
    kind: 'instructions',
    status: 'included',
    description: 'Automatically included in the parent session system prompt.',
    content: file.content,
  }));
}

function skillFile(skill: Skill, selectedTools?: string[]): ContextFile {
  const canRead = (selectedTools ?? ['read', 'bash', 'edit', 'write']).some(
    tool => tool === 'read' || tool === 'bash',
  );
  const advertisement = skill.disableModelInvocation
    ? 'Automatic advertisement to the model is disabled.'
    : canRead
      ? 'Name, description and path are advertised in the system prompt.'
      : 'Metadata is not advertised because no read or bash tool is active.';
  return {
    path: skill.filePath,
    name: skill.name,
    kind: 'skill',
    status: 'available',
    description: `${skill.description} ${advertisement} The body is loaded only when read or invoked.`,
  };
}

function templateFile(
  path: string,
  name: string,
  description: string,
): ContextFile {
  return {
    path,
    name,
    kind: 'template',
    status: 'available',
    description: `${description} Inserted into the user message when /${name} is invoked.`,
  };
}

// Match the SDK file tools' @, tilde, Unicode space and file URL handling.
// No filesystem lookup: provenance comes from the retained tool call/result.
function toolPath(path: string, cwd: string): string {
  let normalized = path.replace(
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g,
    ' ',
  );
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (process.platform === 'win32' && !normalized.includes('\\')) {
    const drive = normalized.match(
      /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
    );
    if (drive)
      normalized = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll('/', '\\') ?? ''}`;
  }
  if (normalized === '~') normalized = homedir();
  else if (
    normalized.startsWith('~/') ||
    (process.platform === 'win32' && normalized.startsWith('~\\'))
  )
    normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith('file://')) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
}

type Replacement = {oldText: string; newText: string};
type DocumentCall = {path: string} & (
  | {name: 'read'; offset?: number; limit?: number}
  | {name: 'write'; content: string}
  | {name: 'edit'; edits: Replacement[]}
);

function isReplacement(value: unknown): value is Replacement {
  if (!value || typeof value !== 'object') return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === 'string' && typeof edit.newText === 'string';
}

// The SDK also accepts legacy fields and coerces single/JSON edits to an array.
function retainedEdits(
  args: Record<string, unknown>,
): Replacement[] | undefined {
  let edits = args.edits;
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      return undefined;
    }
  }
  if (isReplacement(edits)) edits = [edits];
  if (edits !== undefined && !Array.isArray(edits)) return undefined;
  const replacements: unknown[] = edits === undefined ? [] : [...edits];
  if (isReplacement(args)) replacements.push(args);
  return replacements.length && replacements.every(isReplacement)
    ? replacements
    : undefined;
}

/** Only text already retained in the current context; this never opens a path. */
function retainedDocuments(messages: Messages, cwd: string): ContextFile[] {
  const calls = new Map<string, DocumentCall>();
  const files: ContextFile[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (
          block.type !== 'toolCall' ||
          !['read', 'write', 'edit'].includes(block.name)
        )
          continue;
        const args = block.arguments;
        if (
          !args ||
          typeof args !== 'object' ||
          typeof args.path !== 'string' ||
          !/\.md$/i.test(args.path)
        )
          continue;
        let path: string;
        try {
          path = toolPath(args.path, cwd);
        } catch {
          // Invalid calls can remain in history beside their failed results.
          continue;
        }
        if (block.name === 'read') {
          calls.set(block.id, {
            name: 'read',
            path,
            ...(typeof args.offset === 'number' ? {offset: args.offset} : {}),
            ...(typeof args.limit === 'number' ? {limit: args.limit} : {}),
          });
        } else if (block.name === 'write' && typeof args.content === 'string') {
          calls.set(block.id, {name: 'write', path, content: args.content});
        } else if (block.name === 'edit') {
          const edits = retainedEdits(args);
          if (edits) calls.set(block.id, {name: 'edit', path, edits});
        }
      }
    } else if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId);
      if (!call || message.toolName !== call.name || message.isError) continue;
      let content: string;
      let description: string;
      if (call.name === 'read') {
        const result = message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        if (!result) continue;
        const portion = `Read from line ${call.offset ?? 1}${call.limit === undefined ? '' : `, requested up to ${call.limit} lines`}.`;
        description = `${portion} The successful read result is retained in the parent session context and may contain only part of the file.`;
        content = `${portion}\n${result}`;
      } else if (call.name === 'write') {
        description =
          'The full content supplied to a successful write call is retained in the parent session context.';
        content = `Written content:\n${call.content}`;
      } else {
        description =
          'Only the old and new replacement snippets from a successful edit call are retained in the parent session context.';
        content = call.edits
          .map(
            (edit, index) =>
              `Edit ${index + 1}, old text:\n${edit.oldText}\n\nEdit ${index + 1}, new text:\n${edit.newText}`,
          )
          .join('\n\n');
      }
      files.push({
        path: call.path,
        name: basename(call.path),
        kind: 'document',
        status: 'included',
        description,
        content,
      });
    } else if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n');
      const skill = parseSkillBlock(text);
      if (!skill) continue;
      files.push({
        path: skill.location,
        name: skill.name,
        kind: 'skill',
        status: 'included',
        description:
          'Invoked skill body retained in a user message in the parent session context.',
        content: skill.content,
      });
    }
  }
  return files;
}

function boundedPreviews(files: ContextFile[]): ContextFile[] {
  const byPath = new Map<string, ContextFile>();
  for (const file of files) {
    const key = resolve(file.path);
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, {...file});
      continue;
    }
    if (file.status === 'included') previous.status = 'included';
    if (previous.kind === 'document' && file.kind !== 'document') {
      previous.kind = file.kind;
      previous.name = file.name;
    }
    if (!previous.description.includes(file.description))
      previous.description += ` ${file.description}`;
    if (file.content !== undefined && previous.content !== file.content)
      previous.content =
        previous.content === undefined
          ? file.content
          : `${previous.content}\n\n${file.content}`;
  }
  let remaining = totalPreviewLimit;
  return [...byPath.values()].map(file => {
    if (file.content === undefined) return file;
    const {content, ...metadata} = file;
    if (!remaining) return metadata;
    const limit = Math.min(filePreviewLimit, remaining);
    const preview = content.slice(0, limit);
    remaining -= preview.length;
    return {
      ...metadata,
      content:
        preview + (content.length > limit ? '\n[Preview truncated]' : ''),
    };
  });
}

export function loaderContextFiles(
  loader: ResourceLoader,
  selectedTools: string[],
  messages: Messages,
  cwd: string,
): ContextFile[] {
  const files = instructions(loader.getAgentsFiles().agentsFiles);
  const systemSource = loader.getSystemPromptSource();
  const systemContent = loader.getSystemPrompt();
  if (systemSource && systemContent)
    files.push({
      path: systemSource.path,
      name: basename(systemSource.path),
      kind: 'system',
      status: 'included',
      description: 'Replaces the default parent session system prompt.',
      content: systemContent,
    });
  const appendSources = loader.getAppendSystemPromptSources();
  const appendContent = loader.getAppendSystemPrompt();
  // The SDK omits inline values from source paths. Only pair cached content
  // with paths when every append value has a source.
  if (appendContent.join('\n\n'))
    appendSources.forEach((source, index) => {
      files.push({
        path: source.path,
        name: basename(source.path),
        kind: 'append',
        status: 'included',
        description:
          'Automatically appended to the parent session system prompt.',
        ...(appendSources.length === appendContent.length
          ? {content: appendContent[index]}
          : {}),
      });
    });
  files.push(
    ...retainedDocuments(messages, cwd),
    ...loader.getSkills().skills.map(skill => skillFile(skill, selectedTools)),
    ...loader
      .getPrompts()
      .prompts.map(prompt =>
        templateFile(prompt.filePath, prompt.name, prompt.description),
      ),
  );
  return boundedPreviews(files);
}

export function attachedContextFiles(
  options: BuildSystemPromptOptions | undefined,
  commands: SessionFeatures['commands'],
  messages: Messages | undefined,
  cwd: string,
): SessionFeatures['contextFiles'] {
  const files = instructions(options?.contextFiles ?? []);
  const skills = options?.skills ?? [];
  files.push(
    ...retainedDocuments(messages ?? [], cwd),
    ...skills.map(skill => skillFile(skill, options?.selectedTools)),
  );
  for (const command of commands) {
    if (!command.path) continue;
    if (command.source === 'prompt')
      files.push(templateFile(command.path, command.name, command.description));
    else if (
      command.source === 'skill' &&
      !skills.some(skill => skill.filePath === command.path)
    )
      files.push({
        path: command.path,
        name: command.name.replace(/^skill:/, ''),
        kind: 'skill',
        status: 'available',
        description: `${command.description} Available through /${command.name}; its body is loaded when invoked.`,
      });
  }
  return options || messages || files.length
    ? boundedPreviews(files)
    : undefined;
}
