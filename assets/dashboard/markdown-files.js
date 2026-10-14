/* global document, localStorage, setInterval, clearInterval */
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'varisdev.markdown-pins.v1';
const POSITION_KEY = 'varisdev.markdown-position';
const scopes = new Map();
let api;
let selected;
let current;
let polling;
let previousFocus;
let receivedSession = false;
let pins = {};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// File text is always appended as text nodes. Markdown never creates raw HTML.
function inline(target, text) {
  const tokens =
    /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    target.append(document.createTextNode(text.slice(start, match.index)));
    const item = match[2]
      ? node('code', match[2])
      : match[3] || match[4]
        ? node('strong', match[3] || match[4])
        : match[5]
          ? node('em', match[5])
          : node('span', match[6], 'markdown-link');
    if (match[7]) item.title = match[7];
    target.append(item);
    start = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(start)));
}

export function renderMarkdown(target, content) {
  const limit = 150_000;
  const lines = content.slice(0, limit).replace(/\r\n?/g, '\n').split('\n');
  const fragment = document.createDocumentFragment();
  let paragraph = [];
  let list;
  const flush = () => {
    if (paragraph.length) {
      const item = node('p');
      inline(item, paragraph.join('\n'));
      fragment.append(item);
      paragraph = [];
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flush();
      list = undefined;
      const code = [];
      const end = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++index < lines.length && !end.test(lines[index]))
        code.push(lines[index]);
      const pre = node('pre');
      pre.append(node('code', code.join('\n')));
      fragment.append(pre);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    const bullet = /^(\s*)(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (
      heading ||
      bullet ||
      quote ||
      /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)
    ) {
      flush();
      if (bullet) {
        const type = bullet[2] ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== type) {
          list = node(type);
          if (bullet[2]) list.start = Number(bullet[2]);
          fragment.append(list);
        }
        const item = node('li');
        const task = /^\[([ xX])\]\s*(.*)$/.exec(bullet[3]);
        if (task) {
          item.className = 'markdown-task';
          const checkbox = node('input');
          checkbox.type = 'checkbox';
          checkbox.checked = task[1].toLowerCase() === 'x';
          checkbox.disabled = true;
          checkbox.setAttribute('aria-label', task[2]);
          item.append(checkbox);
          inline(item, task[2]);
        } else inline(item, bullet[3]);
        // Keep nested task indentation readable without interpreting file HTML.
        item.style.marginInlineStart = `${Math.min(bullet[1].length, 16) * 0.45}em`;
        list.append(item);
      } else {
        list = undefined;
        const item = node(
          heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'hr',
        );
        if (heading || quote) inline(item, heading ? heading[2] : quote[1]);
        fragment.append(item);
      }
    } else if (!line.trim()) {
      flush();
      list = undefined;
    } else {
      list = undefined;
      paragraph.push(line);
    }
  }
  flush();
  if (content.length > limit)
    fragment.append(
      node(
        'p',
        'Preview limited to 150,000 characters. Edit opens the full file.',
        'muted',
      ),
    );
  target.replaceChildren(fragment);
}

function progress(content) {
  let total = 0;
  let complete = 0;
  let fence;
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const task = /^\s*[-*+]\s+\[([ xX])\]/.exec(line);
    if (task) {
      total++;
      if (task[1].toLowerCase() === 'x') complete++;
    }
  }
  return {total, complete};
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    $('markdown-storage-status').textContent =
      'Pins could not be saved for restart.';
  }
}
function getScope() {
  const snapshot = selected?.();
  const session = snapshot?.session;
  if (!session?.id || !session.cwd) return undefined;
  let scope = scopes.get(session.cwd);
  if (!scope) {
    scope = {
      key: session.cwd,
      documents: new Map(),
      aliases: new Map(),
      active: undefined,
    };
    for (const path of pins[session.cwd] || []) {
      scope.documents.set(path, {path, pinned: true});
      scope.active ||= path;
    }
    scopes.set(session.cwd, scope);
  }
  scope.sessionId = session.id;
  return scope;
}
function activeDocument() {
  return current?.documents.get(current.active);
}
function dirty(doc) {
  return doc?.editing && doc.draft !== doc.baseContent;
}
function savePins(scope) {
  pins[scope.key] = [...scope.documents.values()]
    .filter(doc => doc.pinned)
    .map(doc => doc.path);
  if (!pins[scope.key].length) delete pins[scope.key];
  persist();
}
function showPanel() {
  if ($('markdown-panel').hidden) previousFocus = document.activeElement;
  $('markdown-panel').hidden = false;
  $('markdown-launcher').setAttribute('aria-expanded', 'true');
}
function hidePanel() {
  $('markdown-panel').hidden = true;
  $('markdown-launcher').setAttribute('aria-expanded', 'false');
  if (previousFocus?.isConnected) previousFocus.focus();
  else $('markdown-launcher').focus();
}
function render() {
  const doc = activeDocument();
  $('markdown-session').textContent = current?.key || 'Select a parent session';
  $('markdown-open-path').disabled = !current;
  $('markdown-path').disabled = !current;
  const tabFocused = $('markdown-tabs').contains(document.activeElement);
  $('markdown-tabs').replaceChildren(
    ...[...(current?.documents.values() || [])].map(item => {
      const button = node(
        'button',
        `${item.pinned ? '● ' : ''}${item.path.split(/[\\/]/).pop()}${dirty(item) ? ' *' : ''}`,
      );
      button.type = 'button';
      button.title = item.path;
      button.setAttribute(
        'aria-label',
        `${item.path}${item.pinned ? ', pinned' : ''}${dirty(item) ? ', unsaved changes' : ''}`,
      );
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(item === doc));
      button.setAttribute('aria-controls', 'markdown-document');
      button.tabIndex = item === doc ? 0 : -1;
      button.addEventListener('click', () => {
        current.active = item.path;
        render();
        void refresh(current, item);
        $('markdown-tabs').querySelector('[aria-selected="true"]')?.focus();
      });
      return button;
    }),
  );
  if (tabFocused)
    $('markdown-tabs').querySelector('[aria-selected="true"]')?.focus();
  $('markdown-document').hidden = !doc;
  $('markdown-empty').hidden = Boolean(doc);
  if (!doc) return;
  $('markdown-file-path').textContent = doc.path;
  $('markdown-pin').textContent = doc.pinned ? 'Unpin' : 'Pin';
  $('markdown-pin').setAttribute('aria-pressed', String(Boolean(doc.pinned)));
  $('markdown-edit').hidden = Boolean(doc.editing);
  $('markdown-edit').disabled = !doc.disk || doc.loading;
  $('markdown-save').hidden = !doc.editing;
  $('markdown-cancel').hidden = !doc.editing;
  $('markdown-save').disabled = !dirty(doc) || doc.saving;
  $('markdown-cancel').disabled = Boolean(doc.saving);
  $('markdown-reload').hidden = !doc.error && !doc.diskChanged;
  $('markdown-reload').disabled = Boolean(doc.saving || doc.loading);
  $('markdown-reload').textContent = dirty(doc)
    ? 'Reload disk (discard draft)'
    : 'Reload disk';
  const editor = $('markdown-editor');
  editor.hidden = !doc.editing;
  editor.disabled = Boolean(doc.saving);
  if (doc.editing && editor.value !== doc.draft) editor.value = doc.draft;
  $('markdown-preview').hidden = Boolean(doc.editing);
  if (!doc.editing && doc.renderedVersion !== doc.disk?.version) {
    renderMarkdown($('markdown-preview'), doc.disk?.content || '');
    doc.renderedVersion = doc.disk?.version;
  }
  // The shared preview element needs repainting when tabs or parent sessions switch.
  if (
    !doc.editing &&
    $('markdown-preview').dataset.path !== `${current.key}:${doc.path}`
  ) {
    renderMarkdown($('markdown-preview'), doc.disk?.content || '');
    $('markdown-preview').dataset.path = `${current.key}:${doc.path}`;
  }
  const tasks = progress(doc.disk?.content || '');
  $('markdown-progress').hidden = !tasks.total;
  $('markdown-progress-text').textContent =
    `${tasks.complete} / ${tasks.total} tasks complete`;
  $('markdown-progress-bar').max = tasks.total || 1;
  $('markdown-progress-bar').value = tasks.complete;
  $('markdown-status').textContent = doc.saving
    ? 'Saving…'
    : doc.loading && !doc.disk
      ? 'Loading…'
      : dirty(doc)
        ? 'Unsaved changes'
        : doc.saved
          ? 'Saved'
          : doc.editing
            ? 'Editing'
            : doc.disk
              ? 'Current disk contents'
              : '';
  $('markdown-disk-status').textContent = doc.diskChanged
    ? 'File changed on disk. Your draft is preserved.'
    : '';
  $('markdown-error').hidden = !doc.error;
  $('markdown-error').textContent = doc.error || '';
}
async function refresh(scope, doc, force = false) {
  if (!scope || !doc || doc.saving || !api?.readMarkdown) return;
  if (doc.loading) {
    await doc.read?.catch(() => {});
    return scope.documents.get(scope.aliases.get(doc.path) || doc.path) || doc;
  }
  const requested = doc;
  doc.loading = true;
  if (force) {
    doc.error = undefined;
    doc.errorSource = undefined;
  }
  if (current === scope && activeDocument() === doc) render();
  try {
    doc.read = api.readMarkdown(scope.sessionId, doc.path);
    const result = await doc.read;
    if (result.path !== doc.path) {
      scope.aliases.set(doc.path, result.path);
      scope.documents.delete(doc.path);
      if (scope.active === doc.path) scope.active = result.path;
      const existing = scope.documents.get(result.path);
      if (existing) {
        // Aliases, including Windows paths and symlinks, share the existing draft.
        existing.pinned ||= doc.pinned;
        doc = existing;
        if (force) {
          doc.error = undefined;
          doc.errorSource = undefined;
        }
      } else {
        doc.path = result.path;
        scope.documents.set(doc.path, doc);
      }
      if (doc.pinned) savePins(scope);
    }
    if (doc.errorSource === 'read') {
      doc.error = undefined;
      doc.errorSource = undefined;
    }
    const previous = doc.disk;
    doc.disk = result;
    if (doc.editing && !dirty(doc)) {
      doc.draft = result.content;
      doc.baseContent = result.content;
      doc.editVersion = result.version;
    }
    doc.diskChanged = Boolean(
      doc.editing && result.version !== doc.editVersion,
    );
    if (previous?.version !== result.version) doc.saved = false;
  } catch (cause) {
    if (doc.errorSource !== 'save') {
      doc.error = cause.message || String(cause);
      doc.errorSource = 'read';
    }
  } finally {
    requested.loading = false;
    requested.read = undefined;
    if (current === scope && activeDocument() === doc) render();
  }
  return doc;
}
function edit(doc) {
  if (!doc?.disk) return;
  if (!doc.editing) {
    doc.editing = true;
    doc.draft = doc.disk.content;
    doc.baseContent = doc.disk.content;
    doc.editVersion = doc.disk.version;
    doc.diskChanged = false;
    doc.saved = false;
  }
  render();
  $('markdown-editor').focus();
}
export async function openMarkdownFile(
  path,
  {pin = false, edit: shouldEdit = false} = {},
) {
  updateMarkdownFiles();
  const scope = current;
  if (!scope || !path?.trim()) return;
  path = path.trim();
  let doc = scope.documents.get(scope.aliases.get(path) || path);
  if (!doc) {
    doc = {path};
    scope.documents.set(path, doc);
  }
  if (pin) {
    doc.pinned = true;
    savePins(scope);
  }
  scope.active = doc.path;
  showPanel();
  render();
  doc = (await refresh(scope, doc, true)) || doc;
  if (current !== scope || activeDocument() !== doc) return;
  if (shouldEdit) edit(doc);
  else $('markdown-file-path').focus();
}
export function updateMarkdownFiles() {
  const scope = getScope();
  if (scope === current) return;
  current = scope;
  // Preview content is shared by tabs; force its refresh after a scope change.
  $('markdown-preview').dataset.path = '';
  render();
  if (scope && !receivedSession) {
    receivedSession = true;
    if (activeDocument()?.pinned) showPanel();
  }
  if (scope && activeDocument()) void refresh(scope, activeDocument());
}
export function initMarkdownFiles(options) {
  api = options.api;
  selected = options.selected;
  $('open-context')?.insertAdjacentElement('afterend', $('markdown-launcher'));
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      pins = Object.fromEntries(
        Object.entries(stored)
          .filter(([, paths]) => Array.isArray(paths))
          .map(([key, paths]) => [
            key,
            [
              ...new Set(
                paths.filter(
                  path => typeof path === 'string' && path.length < 8192,
                ),
              ),
            ],
          ]),
      );
    }
  } catch {
    pins = {};
  }
  $('markdown-launcher').addEventListener('click', () => {
    updateMarkdownFiles();
    showPanel();
    $('markdown-path').focus();
    void refresh(current, activeDocument());
  });
  const positionPanel = side => {
    $('markdown-panel').dataset.side = side;
    $('markdown-position').textContent =
      side === 'left' ? 'Move right' : 'Move left';
  };
  let side = 'left';
  try {
    if (localStorage.getItem(POSITION_KEY) === 'right') side = 'right';
  } catch {
    /* Keep the default position. */
  }
  positionPanel(side);
  $('markdown-position').addEventListener('click', () => {
    const next = $('markdown-panel').dataset.side === 'left' ? 'right' : 'left';
    positionPanel(next);
    try {
      localStorage.setItem(POSITION_KEY, next);
    } catch {
      /* The position still applies to this window. */
    }
  });
  $('markdown-close').addEventListener('click', hidePanel);
  $('markdown-path-form').addEventListener('submit', event => {
    event.preventDefault();
    void openMarkdownFile($('markdown-path').value, {pin: true});
  });
  $('markdown-pin').addEventListener('click', () => {
    const doc = activeDocument();
    if (!doc) return;
    doc.pinned = !doc.pinned;
    savePins(current);
    render();
  });
  $('markdown-edit').addEventListener('click', () => edit(activeDocument()));
  $('markdown-editor').addEventListener('input', () => {
    const doc = activeDocument();
    if (!doc) return;
    doc.draft = $('markdown-editor').value;
    doc.saved = false;
    render();
  });
  $('markdown-cancel').addEventListener('click', () => {
    const doc = activeDocument();
    doc.editing = false;
    doc.diskChanged = false;
    doc.error = undefined;
    render();
    void refresh(current, doc, true);
    $('markdown-edit').focus();
  });
  $('markdown-save').addEventListener('click', async () => {
    const scope = current;
    const doc = activeDocument();
    if (!doc || !dirty(doc) || doc.saving) return;
    doc.saving = true;
    doc.error = undefined;
    doc.errorSource = undefined;
    render();
    try {
      await doc.read?.catch(() => {});
      doc.disk = await api.saveMarkdown(
        scope.sessionId,
        doc.path,
        doc.draft,
        doc.editVersion,
      );
      doc.editing = false;
      doc.diskChanged = false;
      doc.saved = true;
    } catch (cause) {
      doc.error = cause.message || String(cause);
      doc.errorSource = 'save';
    } finally {
      doc.saving = false;
      if (current === scope && activeDocument() === doc) render();
    }
  });
  $('markdown-reload').addEventListener('click', async () => {
    const scope = current;
    const doc = activeDocument();
    await refresh(scope, doc, true);
    if (!doc.error && doc.disk) {
      doc.draft = doc.disk.content;
      doc.baseContent = doc.disk.content;
      doc.editVersion = doc.disk.version;
      doc.diskChanged = false;
      if (current === scope && activeDocument() === doc) render();
    }
  });
  $('markdown-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      hidePanel();
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 's' &&
      activeDocument()?.editing
    ) {
      event.preventDefault();
      event.stopPropagation();
      $('markdown-save').click();
    }
  });
  $('markdown-tabs').addEventListener('keydown', event => {
    const tabs = [...$('markdown-tabs').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft')
      next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined && tabs[next]) {
      event.preventDefault();
      tabs[next].click();
    }
  });
  updateMarkdownFiles();
  if (activeDocument()?.pinned) showPanel();
  clearInterval(polling);
  polling = setInterval(() => {
    updateMarkdownFiles();
    if (!$('markdown-panel').hidden && !document.hidden)
      void refresh(current, activeDocument());
  }, 1500);
}
