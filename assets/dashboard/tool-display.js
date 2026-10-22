// Text-only tool presentation keeps native selection stable while output streams.
const names = {
  read: 'Read file',
  write: 'Write file',
  edit: 'Edit file',
  bash: 'Run command',
  browse: 'Browse URL',
  download: 'Download file',
  agent_spawn: 'Start agent',
  agent_send: 'Send agent message',
  agent_list: 'List agents',
  agent_inbox: 'Read agent messages',
  agent_cancel: 'Cancel agent',
  json_query: 'Inspect JSON',
  gamemaker_query: 'Inspect GameMaker data',
  image_query: 'Inspect images',
};
const labels = {
  path: 'Path',
  command: 'Command',
  content: 'Content',
  text: 'Text',
  oldText: 'Original text',
  newText: 'Replacement text',
  edits: 'Edits',
  offset: 'Start line',
  limit: 'Line limit',
  timeout: 'Timeout (seconds)',
  url: 'URL',
  method: 'Method',
  headers: 'Headers',
  body: 'Body',
  id: 'ID',
  message: 'Message',
  task: 'Task',
  name: 'Name',
  stdout: 'Standard output',
  stderr: 'Standard error',
  exitCode: 'Exit code',
  output: 'Output',
  error: 'Error',
  status: 'Status',
  result: 'Result',
};
function toolName(name = '') {
  return name.split('.').at(-1);
}
function decode(value) {
  if (typeof value !== 'string') return value;
  // Decode JSON once, including JSON string results containing escaped newlines.
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function label(key) {
  return (
    labels[key] ||
    key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, letter => letter.toUpperCase())
  );
}
function structured(value) {
  const parts = [];
  function visit(item, depth) {
    const pad = '  '.repeat(Math.min(depth, 16));
    if (item === null || typeof item !== 'object') {
      parts.push(String(item));
    } else if (depth >= 16) {
      parts.push(JSON.stringify(item, null, 2));
    } else if (Array.isArray(item)) {
      if (!item.length) parts.push('[]');
      for (let i = 0; i < item.length; i++) {
        if (i) parts.push('\n\n');
        parts.push(`${pad}${i + 1}.\n`);
        visit(item[i], depth + 1);
      }
    } else {
      const keys = Object.keys(item);
      if (!keys.length) parts.push('{}');
      for (let i = 0; i < keys.length; i++) {
        if (i) parts.push('\n\n');
        const key = keys[i];
        const value = item[key];
        parts.push(
          `${pad}${label(key)}:${typeof value === 'object' || String(value).includes('\n') ? '\n' : ' '}`,
        );
        visit(value, depth + 1);
      }
    }
  }
  visit(value, 0);
  return parts.join('');
}
function displayText(value) {
  const decoded = decode(value ?? '');
  try {
    return typeof decoded === 'object' && decoded !== null
      ? structured(decoded)
      : String(decoded);
  } catch (error) {
    // Preserve the public JSON if native serialization cannot handle its depth.
    if (typeof value === 'string') return value;
    throw error;
  }
}
export function formatToolInput(name, input) {
  const title = names[toolName(name)] || name || 'Operation';
  const result = displayText(input);
  return `${title}\n\n${result || 'No input'}`;
}
export function formatToolResult(output) {
  return displayText(output);
}
export function toolInputPreview(name, input) {
  const decoded = decode(input ?? '');
  const value =
    decoded && typeof decoded === 'object'
      ? (decoded.path ??
        decoded.command ??
        decoded.url ??
        decoded.task ??
        decoded.message ??
        decoded.id)
      : decoded;
  const fallback = names[toolName(name)] ?? name ?? 'No input';
  let text;
  try {
    text = String(value ?? fallback);
  } catch {
    text = fallback;
  }
  return text.split('\n')[0].slice(0, 240);
}
