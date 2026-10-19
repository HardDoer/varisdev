import type {AutocompleteProvider} from '@earendil-works/pi-tui';
import {agentCatalogAllows, type AgentPolicyProfile} from './policy.ts';
import {listAgentTemplates, type AgentTemplate} from './templates.ts';

export interface AgentMentionCandidate {
  id: string;
  name: string;
  description?: string;
  /** Explicit syntax for configurations whose IDs contain directory segments. */
  mention?: string;
}

// Configuration IDs only; paths, email addresses, and scoped file references
// stay with Pi's normal input and file completion.
const mentionId = '[a-z0-9]+(?:-[a-z0-9]+)*';
const invocation = new RegExp(`^@(${mentionId})[ \\t]+(\\S[\\s\\S]*)$`);
const scopedInvocation = new RegExp(
  `^@agent:(${mentionId}(?:/${mentionId})*)[ \\t]+(\\S[\\s\\S]*)$`,
);
const prefix = /^@(?:[a-zA-Z0-9_-]*|agent:[a-z0-9/-]*)$/;

export function parseAgentMention(text: string) {
  const match = scopedInvocation.exec(text) ?? invocation.exec(text);
  return match && match[1].length <= 160
    ? {id: match[1], task: match[2].trimEnd()}
    : undefined;
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
    .map(({id, name, description}) => ({
      id,
      name,
      description,
      ...(id.includes('/') ? {mention: `@agent:${id}`} : {}),
    }));
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
