/** Native slash commands. Shared by discovery, desktop routing and SDK dispatch. */
export const nativeCommands = [
  {
    name: 'settings',
    description: 'Open session settings.',
    target: 'session',
    live: true,
  },
  {
    name: 'model',
    description: 'Choose a model, or use /model provider/model.',
    target: 'session',
    live: true,
  },
  {
    name: 'thinking',
    description: 'Choose a thinking level, or use /thinking level.',
    target: 'session',
    live: true,
  },
  {
    name: 'scoped-models',
    description: 'Choose models available in the model selector.',
    target: 'session',
    live: true,
  },
  {
    name: 'login',
    description: 'Connect a provider account.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'logout',
    description: 'Disconnect a provider account.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'new',
    description: 'Start a fresh conversation in this folder.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'resume',
    description: 'Choose a saved conversation to resume.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'name',
    description: 'Rename this conversation.',
    target: 'session',
    live: true,
  },
  {
    name: 'session',
    description: 'Show session information and statistics.',
    target: 'session',
    live: true,
  },
  {
    name: 'tree',
    description: 'Navigate branches of this conversation.',
    target: 'session',
    live: true,
  },
  {
    name: 'fork',
    description: 'Fork from an earlier user message.',
    target: 'session',
    live: true,
  },
  {
    name: 'clone',
    description: 'Duplicate this conversation at its current position.',
    target: 'session',
    live: true,
  },
  {
    name: 'compact',
    description: 'Compact context, with optional instructions.',
    target: 'session',
    live: true,
  },
  {
    name: 'import',
    description: 'Import and resume a JSONL conversation.',
    target: 'session',
    live: true,
  },
  {
    name: 'copy',
    description: 'Copy the last assistant message.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'export',
    description: 'Export this conversation as HTML or JSONL.',
    target: 'session',
    live: true,
  },
  {
    name: 'share',
    description: 'Review and share this conversation.',
    target: 'session',
    live: true,
  },
  {
    name: 'bug',
    description: 'Prepare a private Pi bug report for review.',
    target: 'session',
    live: true,
  },
  {
    name: 'trust',
    description: 'Save project trust for future sessions.',
    target: 'session',
    live: true,
  },
  {
    name: 'reload',
    description: 'Reload extensions, skills, prompts and settings.',
    target: 'session',
    live: false,
  },
  {
    name: 'hotkeys',
    description: 'Show VarisDev keyboard shortcuts.',
    target: 'desktop',
    live: true,
  },
  {
    name: 'changelog',
    description: 'Read the bundled Pi changelog.',
    target: 'session',
    live: true,
  },
  {name: 'quit', description: 'Quit VarisDev.', target: 'desktop', live: true},
];

/** @param {string} text */
export function parseSlashCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? {name: match[1], args: match[2]?.trim() || ''} : undefined;
}

/** @param {string} name */
export function nativeCommand(name) {
  return nativeCommands.find(command => command.name === name);
}
