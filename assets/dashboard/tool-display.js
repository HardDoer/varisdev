// Text-only tool presentation keeps native selection stable while output streams.
const LIMIT = 64 * 1024;
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
  let size = 0;
  function append(text) {
    if (size > LIMIT) return;
    parts.push(text.slice(0, LIMIT + 1 - size));
    size += text.length;
  }
  function visit(item, depth) {
    if (size > LIMIT) return;
    const pad = '  '.repeat(Math.min(depth, 16));
    if (item === null || typeof item !== 'object') {
      append(String(item));
    } else if (depth >= 16) {
      append(JSON.stringify(item, null, 2));
    } else if (Array.isArray(item)) {
      if (!item.length) append('[]');
      for (let i = 0; i < item.length && size <= LIMIT; i++) {
        if (i) append('\n\n');
        append(`${pad}${i + 1}.\n`);
        visit(item[i], depth + 1);
      }
    } else {
      const keys = Object.keys(item);
      if (!keys.length) append('{}');
      for (let i = 0; i < keys.length && size <= LIMIT; i++) {
        if (i) append('\n\n');
        const key = keys[i];
        const value = item[key];
        append(
          `${pad}${label(key)}:${typeof value === 'object' || String(value).includes('\n') ? '\n' : ' '}`,
        );
        visit(value, depth + 1);
      }
    }
  }
  visit(value, 0);
  return parts.join('');
}
function bounded(value) {
  return value.length > LIMIT
    ? `${value.slice(0, LIMIT)}\n[Display truncated]`
    : value;
}
export function formatToolInput(name, input) {
  const decoded = decode(input ?? '');
  const title = names[toolName(name)] || name || 'Operation';
  const result =
    typeof decoded === 'object' && decoded !== null
      ? structured(decoded)
      : String(decoded);
  return bounded(`${title}\n\n${result || 'No input'}`);
}
export function formatToolResult(output) {
  const decoded = decode(output ?? '');
  return bounded(
    typeof decoded === 'object' && decoded !== null
      ? structured(decoded)
      : String(decoded),
  );
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
  return String(value ?? names[toolName(name)] ?? name ?? 'No input')
    .split('\n')[0]
    .slice(0, 240);
}
