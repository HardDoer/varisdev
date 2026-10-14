/* global document, window, localStorage, setInterval, clearInterval */
import {createDraftStore} from './draft-storage.js';
const $ = id => document.getElementById(id);
const STORAGE_KEY = 'varisdev.markdown-pins.v1';
const PLACEMENT_KEY = 'varisdev.markdown-placement.v1';
let placement = {x: 20, y: 80, width: 520, height: 650, locked: false};
const scopes = new Map();
let api;
let selected;
let current;
let polling;
let previousFocus;
let receivedSession = false;
let pins = {};
let draftStore;
let draftStorageError;
const DRAFT_KEY = 'varisdev.markdown-drafts.v1';
function validDraft(id, value) {
  return (
    value &&
    typeof value.cwd === 'string' &&
    value.cwd.length < 8192 &&
    typeof value.path === 'string' &&
    value.path.length < 8192 &&
    id === JSON.stringify([value.cwd, value.path]) &&
    typeof value.draft === 'string' &&
    value.draft.length <= 1_048_576 &&
    typeof value.baseContent === 'string' &&
    value.baseContent.length <= 1_048_576 &&
    value.draft !== value.baseContent &&
    typeof value.editVersion === 'string' &&
    value.editVersion.length > 0 &&
    value.editVersion.length <= 256 &&
    Number.isFinite(value.savedAt)
  );
}
function saveMarkdownDraft(scope, doc) {
  if (!scope || !doc || !draftStore) return;
  const id = JSON.stringify([scope.key, doc.path]);
  const previous = draftStore.get(id);
  const unchanged =
    previous?.draft === doc.draft &&
    previous?.baseContent === doc.baseContent &&
    previous?.editVersion === doc.editVersion;
  const record = dirty(doc)
    ? {
        cwd: scope.key,
        path: doc.path,
        draft: doc.draft,
        baseContent: doc.baseContent,
        editVersion: doc.editVersion,
        savedAt: unchanged ? previous.savedAt : Date.now(),
      }
    : undefined;
  if (draftStore.save(id, record)) {
    if (
      draftStorageError &&
      $('markdown-storage-status').textContent === draftStorageError
    )
      $('markdown-storage-status').textContent = '';
    draftStorageError = undefined;
  }
}

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
  if (!content.length)
    fragment.append(node('p', 'This file is empty.', 'muted'));
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
    const recovered = [...(draftStore?.entries() || [])]
      .map(([, record]) => record)
      .filter(record => record.cwd === session.cwd)
      .sort((a, b) => a.savedAt - b.savedAt);
    for (const record of recovered) {
      const doc = scope.documents.get(record.path) || {path: record.path};
      Object.assign(doc, {
        editing: true,
        recovered: true,
        draft: record.draft,
        baseContent: record.baseContent,
        editVersion: record.editVersion,
        disk: {
          path: record.path,
          content: record.baseContent,
          version: record.editVersion,
        },
      });
      scope.documents.set(record.path, doc);
      scope.active = record.path;
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
  applyPlacement(false, true);
  $('markdown-launcher').setAttribute('aria-expanded', 'true');
}
function applyPlacement(save = false, besideComposer = false) {
  // Reserve the bottom of the window for the parent session composer.
  const margin = 8;
  let availableWidth = Math.max(1, window.innerWidth - margin * 2);
  const height = Math.max(1, window.innerHeight - 104);
  const editor = $('parent-prompt');
  const composer = editor?.getBoundingClientRect();
  // Keep the initial placement beside the composer at every window size.
  const besideWidth = composer?.left - Math.max(margin, placement.x) - margin;
  if (besideComposer && composer?.width && besideWidth >= 260)
    availableWidth = Math.min(availableWidth, besideWidth);
  const width = Math.min(
    availableWidth,
    Math.max(Math.min(280, availableWidth), placement.width),
  );
  const panelHeight = Math.min(
    height,
    Math.max(Math.min(460, height), placement.height),
  );
  const geometry = {
    x: Math.min(
      window.innerWidth - width - margin,
      Math.max(margin, placement.x),
    ),
    y: Math.min(
      window.innerHeight - 96 - panelHeight,
      Math.max(margin, placement.y),
    ),
    width,
    height: panelHeight,
  };
  const panel = $('markdown-panel');
  Object.assign(panel.style, {
    left: `${geometry.x}px`,
    top: `${geometry.y}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
  });
  panel.dataset.compact = String(width < 400 || height < 460);
  // Window and zoom changes constrain the display without overwriting the user's placement.
  if (save) Object.assign(placement, geometry);
  panel.dataset.locked = String(placement.locked);
  $('markdown-lock').textContent = placement.locked ? 'Unlock' : 'Lock';
  $('markdown-lock').setAttribute('aria-pressed', String(placement.locked));
  $('markdown-heading').setAttribute('aria-disabled', String(placement.locked));
  $('markdown-resize').disabled = placement.locked;
  if (save) {
    try {
      localStorage.setItem(PLACEMENT_KEY, JSON.stringify(placement));
    } catch {
      $('markdown-storage-status').textContent =
        'Panel placement could not be saved for restart.';
    }
  }
}
function panelGeometry() {
  const box = $('markdown-panel').getBoundingClientRect();
  return {x: box.left, y: box.top, width: box.width, height: box.height};
}
function initPlacement() {
  try {
    const stored = JSON.parse(localStorage.getItem(PLACEMENT_KEY) || 'null');
    if (
      stored &&
      ['x', 'y', 'width', 'height'].every(key => Number.isFinite(stored[key]))
    )
      placement = {
        ...placement,
        ...Object.fromEntries(
          ['x', 'y', 'width', 'height'].map(key => [key, stored[key]]),
        ),
        locked: stored.locked === true,
      };
  } catch {
    /* Use the default placement. */
  }
  applyPlacement();
  $('markdown-lock').addEventListener('click', () => {
    Object.assign(placement, panelGeometry());
    placement.locked = !placement.locked;
    applyPlacement(true);
  });
  for (const [id, resize] of [
    ['markdown-heading', false],
    ['markdown-resize', true],
  ]) {
    const handle = $(id);
    let gesture;
    handle.addEventListener('pointerdown', event => {
      if (
        placement.locked ||
        event.button !== 0 ||
        (!resize && event.target.closest('button'))
      )
        return;
      event.preventDefault();
      handle.focus();
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: {...placement, ...panelGeometry()},
      };
      Object.assign(placement, gesture.start);
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== event.pointerId || placement.locked)
        return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (resize) {
        placement.width = Math.min(
          window.innerWidth - 8 - placement.x,
          gesture.start.width + dx,
        );
        placement.height = Math.min(
          window.innerHeight - 96 - placement.y,
          gesture.start.height + dy,
        );
      } else {
        placement.x = gesture.start.x + dx;
        placement.y = gesture.start.y + dy;
      }
      applyPlacement();
    });
    const finish = () => {
      if (!gesture) return;
      gesture = undefined;
      applyPlacement(true);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (
        event.target !== handle ||
        placement.locked ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      )
        return;
      event.preventDefault();
      Object.assign(placement, panelGeometry());
      const amount = event.shiftKey ? 40 : 10;
      const horizontal =
        event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const key = resize
        ? horizontal
          ? 'width'
          : 'height'
        : horizontal
          ? 'x'
          : 'y';
      placement[key] +=
        (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) *
        amount;
      if (resize) {
        placement.width = Math.min(
          window.innerWidth - 8 - placement.x,
          placement.width,
        );
        placement.height = Math.min(
          window.innerHeight - 96 - placement.y,
          placement.height,
        );
      }
      applyPlacement(true);
    });
  }
  window.addEventListener('resize', () =>
    window.requestAnimationFrame(() => applyPlacement(false, true)),
  );
}
async function discoverFiles(scope) {
  if (!scope || scope.finding) return scope?.finding;
  const snapshot = selected?.();
  const changed = [...(snapshot?.changes || [])]
    .reverse()
    .map(item => item.path)
    .filter(path => /\.md$/i.test(path));
  scope.choices = [...new Set(changed)];
  scope.catalogError = false;
  scope.finding = (async () => {
    try {
      const resource = await api.sessionFeatures?.(scope.sessionId);
      const files = (resource?.contextFiles || []).filter(file =>
        /\.md$/i.test(file.path),
      );
      files.sort((a, b) => {
        const rank = file =>
          (file.path.startsWith(scope.key + '/') ? 0 : 2) +
          (file.status === 'included' ? 0 : 1);
        return rank(a) - rank(b);
      });
      scope.choices = [
        ...new Set([...changed, ...files.map(file => file.path)]),
      ];
    } catch {
      scope.catalogError = true;
    } finally {
      scope.finding = undefined;
      if (current === scope) render();
    }
  })();
  render();
  await scope.finding;
}
async function launch() {
  updateMarkdownFiles();
  const scope = current;
  showPanel();
  if (activeDocument()) {
    void refresh(scope, activeDocument());
    $('markdown-file-path').focus();
  }
  await discoverFiles(scope);
  if (current !== scope || $('markdown-panel').hidden) return;
  if (!activeDocument() && scope?.choices?.length)
    await openMarkdownFile(scope.choices[0]);
  else if (!activeDocument()) $('markdown-path').focus();
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
  const choices = [
    ...new Set(
      [
        ...(current?.choices || []),
        ...[...(current?.documents.keys() || [])],
      ].map(path => current.aliases.get(path) || path),
    ),
  ];
  const picker = $('markdown-files');
  const signature = JSON.stringify(choices);
  if (picker.dataset.choices !== signature) {
    picker.replaceChildren(
      ...choices.map(path => {
        const option = node('option', path);
        option.value = path;
        return option;
      }),
    );
    picker.dataset.choices = signature;
  }
  $('markdown-empty').textContent = !current
    ? 'Select a parent session.'
    : current.finding
      ? 'Loading files…'
      : current.catalogError
        ? 'Could not load the file list. Enter a file path.'
        : 'Choose a file or enter its path.';
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
  $('markdown-file-path').title = doc.path;
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
  const preview = $('markdown-preview');
  // Cache against the shared preview, so changed tabs and parent sessions repaint.
  const previewKey = JSON.stringify([
    current.key,
    doc.path,
    doc.disk?.version,
    !doc.disk && doc.loading,
    !doc.disk && doc.error,
  ]);
  if (!doc.editing && preview.dataset.document !== previewKey) {
    if (doc.disk) renderMarkdown(preview, doc.disk.content);
    else
      preview.replaceChildren(
        node(
          'p',
          doc.loading ? 'Loading…' : 'File contents could not be loaded.',
          'muted',
        ),
      );
    preview.dataset.document = previewKey;
  }
  const updated = $('markdown-updated');
  updated.hidden = !doc.updatedAt;
  if (doc.updatedAt) {
    const at = new Date(doc.updatedAt);
    updated.textContent = `Updated ${at.toLocaleTimeString()}`;
    updated.dateTime = at.toISOString();
    updated.title = `File changed on disk · ${at.toLocaleString()}`;
    const updateKey = `${current.key}:${doc.path}:${doc.updatedAt}`;
    if (updated.dataset.update !== updateKey) {
      updated.classList.remove('is-updated');
      if (doc.notifiedUpdatedAt !== doc.updatedAt) {
        void updated.offsetWidth;
        updated.classList.add('is-updated');
        doc.notifiedUpdatedAt = doc.updatedAt;
      }
      updated.dataset.update = updateKey;
    }
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
        ? doc.recovered
          ? 'Recovered draft · Unsaved changes'
          : 'Unsaved changes'
        : doc.saved
          ? 'Saved'
          : doc.editing
            ? 'Editing'
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
    if (previous && previous.content !== result.content)
      doc.updatedAt = Date.now();
    if (doc.editing && !dirty(doc)) {
      doc.draft = result.content;
      doc.baseContent = result.content;
      doc.editVersion = result.version;
    }
    doc.diskChanged = Boolean(
      doc.editing && result.version !== doc.editVersion,
    );
    if (previous?.version !== result.version) doc.saved = false;
    if (doc.editing) saveMarkdownDraft(scope, doc);
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
  $('markdown-preview').dataset.document = '';
  render();
  if (scope && !receivedSession) {
    receivedSession = true;
    if (activeDocument()?.pinned || dirty(activeDocument())) showPanel();
  }
  if (scope && activeDocument()) void refresh(scope, activeDocument());
  else if (scope && !$('markdown-panel').hidden) {
    void discoverFiles(scope).then(() => {
      if (
        current === scope &&
        !$('markdown-panel').hidden &&
        !activeDocument() &&
        scope.choices?.length
      )
        void openMarkdownFile(scope.choices[0]);
    });
  }
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
  draftStore = createDraftStore(DRAFT_KEY, {
    validate: validDraft,
    onError: () => {
      draftStorageError =
        'Markdown draft recovery could not be saved. Your changes remain in this window.';
      $('markdown-storage-status').textContent = draftStorageError;
    },
  });
  initPlacement();
  $('markdown-launcher').addEventListener('click', () => void launch());
  $('markdown-close').addEventListener('click', hidePanel);
  $('markdown-path-form').addEventListener('submit', event => {
    event.preventDefault();
    void openMarkdownFile($('markdown-path').value);
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
    doc.recovered = false;
    doc.saved = false;
    saveMarkdownDraft(current, doc);
    render();
  });
  $('markdown-cancel').addEventListener('click', () => {
    const doc = activeDocument();
    doc.editing = false;
    doc.recovered = false;
    doc.diskChanged = false;
    doc.error = undefined;
    saveMarkdownDraft(current, doc);
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
      doc.recovered = false;
      doc.diskChanged = false;
      doc.saved = true;
      saveMarkdownDraft(scope, doc);
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
      doc.recovered = false;
      saveMarkdownDraft(scope, doc);
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
  if (activeDocument()?.pinned || dirty(activeDocument())) showPanel();
  window.addEventListener('unload', () => {
    for (const scope of scopes.values())
      for (const doc of scope.documents.values())
        if (dirty(doc)) saveMarkdownDraft(scope, doc);
    draftStore.flush();
  });
  clearInterval(polling);
  polling = setInterval(() => {
    updateMarkdownFiles();
    if (!$('markdown-panel').hidden && !document.hidden) {
      for (const doc of current?.documents.values() || [])
        if (doc.pinned || doc === activeDocument()) void refresh(current, doc);
    }
  }, 1500);
}
