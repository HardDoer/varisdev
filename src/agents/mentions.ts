import type {AutocompleteProvider} from '@earendil-works/pi-tui';
import {isAbsolute} from 'node:path';
import {agentCatalogAllows, type AgentPolicyProfile} from './policy.ts';
import {listAgentTemplates, type AgentTemplate} from './templates.ts';

export interface AgentMentionCandidate {
  id: string;
  name: string;
  description?: string;
  /** Invocation text, including quoting when the filename needs it. */
  mention?: string;
}

// Discovery distinguishes configuration names from ordinary file mentions.
const invocation =
  /^@(agent:)?("(?:\\.|[^"\\])*"|(?:builtin|global|repository|workspace):"(?:\\.|[^"\\])*"|[^\s"@]+)[ \t]+(\S[\s\S]*)$/u;
const quotedScope = /^(builtin|global|repository|workspace):("[\s\S]*")$/u;
const prefix =
  /^@(?:agent:)?(?:(?:(?:builtin|global|repository|workspace):)?"(?:\\.|[^"\\])*"?|[^\s"@]*)$/u;

export function parseAgentMention(text: string) {
  const match = invocation.exec(text);
  if (!match) return undefined;
  const explicit = Boolean(match[1]);
  const token = match[2];
  let id = token;
  const scoped = explicit && quotedScope.exec(token);
  const literalId = token.startsWith('"');
  try {
    if (literalId) id = JSON.parse(token);
    else if (scoped) id = `${scoped[1]}:${JSON.parse(scoped[2])}`;
  } catch {
    return undefined;
  }
  if (!explicit && !literalId && /[/:]/u.test(id)) return undefined;
  const path = !literalId
    ? id.replace(/^(?:builtin|global|repository|workspace):/u, '')
    : id;
  const parts = path.split(process.platform === 'win32' ? /[\\/]/u : '/');
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    parts.some(part => !part || part === '.' || part === '..')
  )
    return undefined;
  return {
    id,
    task: match[3].trimEnd(),
    ...(literalId ? {literalId: true} : {}),
  };
}

function mentionText(id: string): string | undefined {
  if (/[\s"\\@:]/u.test(id)) return `@agent:${JSON.stringify(id)}`;
  return id.includes('/') ? `@agent:${id}` : undefined;
}

export function eligibleAgentMentions(
  templates: readonly AgentTemplate[],
  parent: AgentPolicyProfile = {},
): AgentMentionCandidate[] {
  return templates
    .filter(
      template =>
        !template.hidden &&
        !template.disabled &&
        template.mode !== 'primary' &&
        agentCatalogAllows(parent, template.id),
    )
    .map(({id, name, description}) => {
      const mention = mentionText(id);
      return {id, name, description, ...(mention ? {mention} : {})};
    });
}

export async function discoverAgentMentions(
  cwd: string,
  parent: AgentPolicyProfile = {},
): Promise<AgentMentionCandidate[]> {
  return eligibleAgentMentions(
    (await listAgentTemplates(cwd)).templates,
    parent,
  );
}

/** Extend Pi's editor provider while retaining its file and command completion. */
export function agentMentionAutocomplete(
  current: AutocompleteProvider,
  candidates: () => Promise<AgentMentionCandidate[]>,
): AutocompleteProvider {
  const owned = new WeakSet<object>();
  return {
    triggerCharacters: [
      ...new Set([...(current.triggerCharacters ?? []), '@']),
    ],
    async getSuggestions(lines, line, column, options) {
      const query = lines[0]?.slice(0, column);
      if (line === 0 && query && prefix.test(query)) {
        const matches = (await candidates()).filter(candidate =>
          (candidate.mention ?? `@${candidate.id}`)
            .toLowerCase()
            .startsWith(query.toLowerCase()),
        );
        options.signal.throwIfAborted();
        if (matches.length) {
          const items = matches.map(candidate => ({
            value: candidate.mention ?? `@${candidate.id}`,
            label: candidate.mention ?? `@${candidate.id}`,
            description: candidate.description || candidate.name,
          }));
          items.forEach(item => owned.add(item));
          return {items, prefix: query};
        }
      }
      return current.getSuggestions(lines, line, column, options);
    },
    applyCompletion(lines, line, column, item, completionPrefix) {
      if (!owned.has(item))
        return current.applyCompletion(
          lines,
          line,
          column,
          item,
          completionPrefix,
        );
      const replacement = `${item.value} `;
      const updated = [...lines];
      updated[line] =
        replacement + lines[line].slice(column).replace(/^[ \t]+/, '');
      return {lines: updated, cursorLine: line, cursorCol: replacement.length};
    },
    shouldTriggerFileCompletion:
      current.shouldTriggerFileCompletion?.bind(current),
  };
}
