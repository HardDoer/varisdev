/* global document, window, setTimeout, clearTimeout */
import {openMarkdownFile} from './markdown-files.js';
import {nativeCommands} from './command-catalog.js';
const $ = id => document.getElementById(id);
const cache = new Map();
const loading = new Map();
const contextErrors = new Map();
const contextDisclosures = new Map();
let parentView = true;
let contextSignature;
let contextConversation;
let contextRefreshTimer;
const dismissed = new Set();
const seenEditor = new Map();
const builtinCommands = nativeCommands.map(command => ({
  ...command,
  source: 'builtin',
}));
const sourceName = {
  skill: 'Skill',
  prompt: 'Template',
  extension: 'Extension',
  builtin: 'Command',
};
let api;
let selected;
let draftChanged;
let current;
let previousId;
let previousModel;
let previousThinkingLevel;
let activeDialog;
let dialogBusy = false;
let settingsBusy = false;
let suggestionIndex = 0;
let suggestions = [];
let terminalView;
let terminalOutput = '';

function renderTerminal(request) {
  if (request.kind !== 'terminal') return;
  const frame = request.terminal;
  if (!frame) return;
  if (!terminalView) {
    terminalView = new window.Terminal({
      cols: frame.columns,
      rows: frame.rows,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 1000,
      // Extension components use Pi's terminal theme and its ANSI colors.
      theme: {background: '#101c27', foreground: '#edf4f6'},
    });
    terminalView.open($('extension-dialog-terminal'));
    terminalView.onData(value => {
      if (!activeDialog || activeDialog.kind !== 'terminal' || dialogBusy)
        return;
      void api
        .respondToDialog(activeDialog.sessionId, activeDialog.id, value)
        .catch(cause => error($('extension-dialog-error'), cause));
    });
    terminalOutput = '';
    terminalView.focus();
  }
  if (terminalView.cols !== frame.columns || terminalView.rows !== frame.rows)
    terminalView.resize(frame.columns, frame.rows);
  if (frame.output !== terminalOutput) {
    if (frame.output.startsWith(terminalOutput))
      terminalView.write(frame.output.slice(terminalOutput.length));
    else {
      terminalView.reset();
      terminalView.write(frame.output);
    }
    terminalOutput = frame.output;
  }
}
function disposeTerminal() {
  terminalView?.dispose();
  terminalView = undefined;
  terminalOutput = '';
}

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}
function error(target, value) {
  target.textContent = value instanceof Error ? value.message : String(value);
  target.hidden = false;
}
function features() {
  return cache.get(current?.session.id);
}
async function load(force = false, id = current?.session.id) {
  if (!id || !api?.sessionFeatures) return;
  if (!force && cache.has(id)) return cache.get(id);
  if (!force && loading.has(id)) return loading.get(id);
  contextErrors.delete(id);
  const operation = api
    .sessionFeatures(id)
    .then(result => {
      if (loading.get(id) !== operation) return result;
      cache.set(id, result);
      if (selected()?.session.id === id) {
        renderCatalog();
        renderSuggestions();
      }
      return result;
    })
    .catch(cause => {
      if (loading.get(id) !== operation) return;
      contextErrors.set(id, cause);
      if (selected()?.session.id === id) {
        $('commands-status').textContent = cause.message;
      }
    })
    .finally(() => {
      if (loading.get(id) !== operation) return;
      loading.delete(id);
      if (selected()?.session.id === id) renderContext();
    });
  loading.set(id, operation);
  renderContext();
  return operation;
}
export function refreshContext() {
  renderContext();
  void load(true);
}
function renderContext() {
  if (!current) return;
  const id = current.session.id;
  const resource = features();
  const files = resource?.contextFiles || [];
  const cause = contextErrors.get(id);
  $('context-recipient').textContent =
    `${current.session.name} · parent session`;
  $('refresh-context').disabled = !api?.sessionFeatures || loading.has(id);
  $('context-status').textContent = loading.has(id)
    ? 'Refreshing context files…'
    : files.length
      ? ''
      : cause
        ? ''
        : 'No context files reported for this parent session.';
  $('context-error').hidden = !cause;
  if (cause) error($('context-error'), cause);
  const signature = JSON.stringify([id, files]);
  if (signature === contextSignature) return;
  for (const preview of $('context-files').querySelectorAll('details'))
    contextDisclosures.set(preview.dataset.key, preview.open);
  contextSignature = signature;
  $('context-files').replaceChildren(
    ...['included', 'available'].flatMap(status => {
      const entries = files.filter(file => file.status === status);
      if (!entries.length) return [];
      const section = node('section', 'context-section');
      section.append(
        node(
          'h3',
          '',
          status === 'included' ? 'Included in context' : 'Available resources',
        ),
      );
      for (const file of entries) {
        const card = node('article', 'context-file');
        const title = node('div', 'context-file-heading');
        const kind = {
          document: 'Read document',
          instructions: 'Project instructions',
          system: 'System prompt',
          append: 'Appended instructions',
          skill: 'Skill',
          template: 'Prompt template',
        }[file.kind];
        title.append(
          node('strong', '', file.name),
          node('span', 'muted', kind),
        );
        card.append(title, node('p', 'context-file-path mono', file.path));
        if (file.description) card.append(node('p', '', file.description));
        if (/\.md$/i.test(file.path)) {
          const actions = node('div', 'file-actions');
          for (const [label, options] of [
            ['Open', {edit: true}],
            ['Pin', {pin: true}],
          ]) {
            const button = node('button', 'quiet-button', label);
            button.type = 'button';
            button.addEventListener('click', () =>
              openMarkdownFile(file.path, options),
            );
            actions.append(button);
          }
          card.append(actions);
        }
        if (file.content !== undefined) {
          const preview = node('details', 'context-preview');
          preview.dataset.key = `${id}:${file.kind}:${file.status}:${file.path}`;
          preview.open = contextDisclosures.get(preview.dataset.key) ?? false;
          preview.append(
            node('summary', '', 'Content preview'),
            node('pre', 'prose', file.content),
          );
          card.append(preview);
        }
        section.append(card);
      }
      return [section];
    }),
  );
}
function commands(query = '') {
  const needle = query.toLocaleLowerCase().replace(/^\//, '');
  return [
    ...builtinCommands,
    ...(features()?.commands || []).filter(
      command => !builtinCommands.some(local => local.name === command.name),
    ),
  ].filter(command =>
    `${command.name} ${command.description} ${sourceName[command.source] || ''}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
function insertCommand(command) {
  const editor = $('parent-prompt');
  const prefix = `/${command.name.replace(/^\//, '')}`;
  const existing = editor.value;
  const rest = existing.startsWith('/')
    ? existing.replace(/^\/\S*\s*/, '')
    : existing;
  editor.value = `${prefix} ${rest}`;
  editor.focus({preventScroll: true});
  editor.setSelectionRange(editor.value.length, editor.value.length);
  draftChanged();
  $('command-suggestions').hidden = true;
}
function renderCatalog() {
  const resource = features();
  const matches = commands($('command-search').value);
  $('commands-status').textContent = resource
    ? `${matches.length} commands`
    : 'Loading resources…';
  $('command-catalog').replaceChildren(
    ...matches.map(command => {
      const button = node('button', 'command-choice');
      button.type = 'button';
      const title = node('span', 'command-choice-title');
      title.append(
        node('strong', '', `/${command.name.replace(/^\//, '')}`),
        node('small', 'muted', sourceName[command.source] || command.source),
      );
      button.append(
        title,
        node(
          'span',
          'command-description',
          command.description || 'No description',
        ),
      );
      if (command.path)
        button.append(node('small', 'command-path mono', command.path));
      button.addEventListener('click', () => insertCommand(command));
      return button;
    }),
  );
  $('available-tools').replaceChildren(
    ...(resource?.tools || []).map(tool => {
      const row = node('p', 'resource-tool');
      row.append(
        node('strong', '', tool.name),
        node('span', '', tool.description || ''),
      );
      return row;
    }),
  );
  const diagnostics = resource?.diagnostics || [];
  $('resource-diagnostics').hidden = diagnostics.length === 0;
  $('resource-diagnostics').textContent = diagnostics
    .map(item => `${item.message}${item.path ? ` (${item.path})` : ''}`)
    .join('\n');
}
function renderSuggestions() {
  const value = $('parent-prompt').value;
  const match = value.match(/^\/([^\s]*)$/);
  const container = $('command-suggestions');
  if (!match || document.activeElement !== $('parent-prompt')) {
    container.hidden = true;
    return;
  }
  const needle = match[1].toLocaleLowerCase();
  const rank = command => {
    const name = command.name.toLocaleLowerCase();
    return name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;
  };
  suggestions = commands(needle)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 8);
  suggestionIndex = Math.min(
    suggestionIndex,
    Math.max(0, suggestions.length - 1),
  );
  container.replaceChildren(
    ...suggestions.map((command, index) => {
      const button = node('button', 'command-suggestion');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === suggestionIndex));
      button.append(
        node('strong', '', `/${command.name.replace(/^\//, '')}`),
        node('span', '', command.description || sourceName[command.source]),
      );
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => insertCommand(command));
      return button;
    }),
  );
  container.hidden = suggestions.length === 0;
}
function canRunCommand(name) {
  return (
    parentView &&
    current?.session.controllable &&
    (current.session.status === 'idle' ||
      (['running', 'compacting'].includes(current.session.status) &&
        nativeCommands.find(command => command.name === name)?.live))
  );
}
function renderSettingsControls() {
  $('session-maintenance').hidden = !parentView;
  $('session-maintenance-name').textContent = current?.session.name || '';
  $('compact-session').disabled = settingsBusy || !canRunCommand('compact');
  $('reload-session').disabled = settingsBusy || !canRunCommand('reload');
}
async function runSessionCommand(name, args = '') {
  if (settingsBusy || !canRunCommand(name)) return;
  const id = current.session.id;
  settingsBusy = true;
  $('session-settings-error').hidden = true;
  renderSettingsControls();
  try {
    await api.promptSession(id, {prompt: `/${name}${args ? ` ${args}` : ''}`});
    await load(true, id);
  } catch (cause) {
    if (current?.session.id === id) error($('session-settings-error'), cause);
  } finally {
    settingsBusy = false;
    renderSettingsControls();
  }
}
function renderExtensionUI(data) {
  const ui = data.ui;
  const notices = (ui?.notifications || []).filter(
    item => !dismissed.has(item.id),
  );
  const signature = JSON.stringify(notices);
  const container = $('extension-notifications');
  container.hidden = notices.length === 0;
  if (container.dataset.signature !== signature) {
    container.dataset.signature = signature;
    container.replaceChildren(
      ...notices.map(item => {
        const notice = node('div', `extension-notification ${item.type}`);
        const close = node('button', 'quiet-button', 'Dismiss');
        close.type = 'button';
        close.addEventListener('click', () => {
          dismissed.add(item.id);
          renderExtensionUI(data);
        });
        notice.append(node('p', '', item.message), close);
        return notice;
      }),
    );
  }
  const statuses = [...(ui?.statuses || [])];
  for (const widget of ui?.widgets || [])
    statuses.push({key: widget.key, text: widget.lines.join('\n')});
  $('extension-statuses').hidden = statuses.length === 0;
  $('extension-statuses').replaceChildren(
    ...statuses.map(item => {
      const entry = node('p');
      entry.append(
        node('strong', '', `${item.key}: `),
        node('span', '', item.text),
      );
      return entry;
    }),
  );
  $('extension-editor').hidden = !ui?.extensionEditor;
  let editorChanged = false;
  if (ui?.editor && seenEditor.get(data.session.id) !== ui.editor.id) {
    seenEditor.set(data.session.id, ui.editor.id);
    $('parent-prompt').value = ui.editor.text;
    draftChanged();
    editorChanged = true;
  }
  const request = ui?.dialogs?.[0];
  if (
    activeDialog?.sessionId === data.session.id &&
    activeDialog.id === request?.id
  ) {
    renderTerminal(request);
    renderDialogActions();
    return;
  }
  const dialog = $('extension-dialog');
  if (dialog.open) dialog.close();
  disposeTerminal();
  activeDialog = undefined;
  if (!request) {
    if (editorChanged) {
      const editor = $('parent-prompt');
      editor.focus({preventScroll: true});
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }
    return;
  }
  activeDialog = {...request, sessionId: data.session.id};
  dialogBusy = false;
  $('extension-dialog-title').textContent = request.title;
  $('extension-dialog-session').textContent = data.session.name;
  $('extension-dialog-message').textContent = request.message || '';
  $('extension-dialog-message').hidden = !request.message;
  $('extension-dialog-error').hidden = true;
  $('submit-extension-dialog').disabled = false;
  $('submit-extension-dialog').hidden = request.kind === 'terminal';
  $('extension-dialog-terminal').hidden = request.kind !== 'terminal';
  renderDialogActions();
  dialog.classList.toggle('terminal-dialog', request.kind === 'terminal');
  $('cancel-extension-dialog').disabled = false;
  $('cancel-extension-dialog').textContent =
    request.kind === 'info' ? 'Close' : 'Cancel';
  $('submit-extension-dialog').textContent =
    request.kind === 'info' ? 'OK' : 'Continue';
  $('extension-dialog-search').hidden =
    request.kind !== 'select' || !request.searchable;
  $('extension-dialog-search').value = '';
  $('extension-dialog-current').hidden =
    request.kind !== 'select' || !request.selected;
  $('extension-dialog-current').textContent = request.selected
    ? `Current: ${request.selected}`
    : '';
  $('extension-dialog-input').hidden = request.kind !== 'input';
  $('extension-dialog-editor').hidden = request.kind !== 'editor';
  $('extension-dialog-select').hidden = request.kind !== 'select';
  $('extension-dialog-input').value = request.prefill || '';
  $('extension-dialog-input').placeholder = request.placeholder || '';
  $('extension-dialog-editor').value = request.prefill || '';
  renderDialogOptions();
  dialog.showModal();
  if (request.kind === 'terminal') {
    renderTerminal(request);
    return;
  }
  const target =
    request.kind === 'input'
      ? 'extension-dialog-input'
      : request.kind === 'editor'
        ? 'extension-dialog-editor'
        : request.kind === 'select'
          ? request.searchable
            ? 'extension-dialog-search'
            : 'extension-dialog-select'
          : 'submit-extension-dialog';
  $(target).focus();
}
function renderDialogActions() {
  const actions =
    activeDialog?.kind === 'terminal' ? activeDialog.actions || [] : [];
  $('extension-dialog-actions').hidden = !actions.length;
  for (const button of $('extension-dialog-actions').querySelectorAll(
    'button',
  )) {
    const action = actions.find(item => item.id === button.dataset.action);
    button.hidden = !action;
    button.disabled = dialogBusy;
    if (action) button.textContent = action.label;
  }
}
async function respondAction(action) {
  const request = activeDialog;
  if (
    dialogBusy ||
    request?.kind !== 'terminal' ||
    !request.actions?.some(item => item.id === action)
  )
    return;
  dialogBusy = true;
  renderDialogActions();
  $('cancel-extension-dialog').disabled = true;
  try {
    await api.respondToDialog(request.sessionId, request.id, {action});
  } catch (cause) {
    error($('extension-dialog-error'), cause);
  } finally {
    dialogBusy = false;
    renderDialogActions();
    $('cancel-extension-dialog').disabled = false;
    if (activeDialog?.id === request.id) terminalView?.focus();
  }
}
function renderDialogOptions() {
  const request = activeDialog;
  if (!request || request.kind !== 'select') {
    $('extension-dialog-select').replaceChildren();
    $('extension-dialog-empty').hidden = true;
    return;
  }
  const select = $('extension-dialog-select');
  const needle = request.searchable
    ? $('extension-dialog-search').value.trim().toLocaleLowerCase()
    : '';
  const values = (request.options || []).filter(value =>
    value.toLocaleLowerCase().includes(needle),
  );
  select.replaceChildren(
    ...values.map(value => {
      const option = node('option', '', value);
      option.value = value;
      return option;
    }),
  );
  const preferred = request.selection || request.selected;
  if (values.includes(preferred)) select.value = preferred;
  else if (values.length) select.selectedIndex = 0;
  $('extension-dialog-empty').hidden = values.length > 0;
  $('extension-dialog-empty').textContent = needle
    ? 'No options match your search.'
    : 'No options available.';
  $('submit-extension-dialog').disabled = dialogBusy || !values.length;
}
async function respond(cancelled) {
  if (!activeDialog || dialogBusy) return;
  const request = activeDialog;
  if (request.kind === 'terminal' && !cancelled) return;
  if (
    request.kind === 'select' &&
    !cancelled &&
    $('extension-dialog-select').selectedIndex < 0
  )
    return;
  const value = cancelled
    ? undefined
    : ['confirm', 'info'].includes(request.kind)
      ? true
      : request.kind === 'select'
        ? $('extension-dialog-select').value
        : request.kind === 'editor'
          ? $('extension-dialog-editor').value
          : $('extension-dialog-input').value;
  dialogBusy = true;
  $('submit-extension-dialog').disabled = true;
  $('cancel-extension-dialog').disabled = true;
  try {
    await api.respondToDialog(request.sessionId, request.id, value);
    if (activeDialog?.id === request.id) {
      $('extension-dialog').close();
      activeDialog = undefined;
      disposeTerminal();
    }
  } catch (cause) {
    error($('extension-dialog-error'), cause);
  } finally {
    dialogBusy = false;
    $('submit-extension-dialog').disabled = false;
    $('cancel-extension-dialog').disabled = false;
  }
}
export function initSessionFeatures(options) {
  api = options.api;
  selected = options.selected;
  draftChanged = options.draftChanged;
  $('refresh-context').addEventListener('click', refreshContext);
  $('extension-editor').addEventListener('click', () => {
    const data = selected();
    if (!data?.ui?.extensionEditor) return;
    void api
      .respondToDialog(
        data.session.id,
        data.ui.extensionEditor.id,
        $('parent-prompt').value,
      )
      .catch(cause => error($('prompt-error'), cause));
  });
  $('open-commands').addEventListener('click', () => {
    if (!parentView) return;
    const dialog = $('commands-dialog');
    if (!dialog.open) {
      if ($('parent-controls').matches(':popover-open')) {
        dialog.inert = false;
        dialog.showModal();
      } else dialog.show();
    }
    $('command-search').value = '';
    renderCatalog();
    void load(true);
    $('command-search').focus();
  });
  const closeCommands = () => {
    $('commands-dialog').close();
    $('parent-prompt').focus({preventScroll: true});
  };
  $('close-commands').addEventListener('click', closeCommands);
  $('commands-dialog').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeCommands();
  });
  $('command-search').addEventListener('input', renderCatalog);
  $('compact-session').addEventListener(
    'click',
    () =>
      void runSessionCommand('compact', $('compact-instructions').value.trim()),
  );
  $('reload-session').addEventListener(
    'click',
    () => void runSessionCommand('reload'),
  );
  $('parent-prompt').addEventListener('input', () => {
    suggestionIndex = 0;
    renderSuggestions();
    if (!features()) void load();
  });
  $('parent-prompt').addEventListener(
    'keydown',
    event => {
      if (
        $('command-suggestions').hidden ||
        !suggestions.length ||
        event.isComposing
      )
        return;
      if (
        !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') $('command-suggestions').hidden = true;
      else if (event.key === 'Enter' || event.key === 'Tab')
        insertCommand(suggestions[suggestionIndex]);
      else {
        suggestionIndex =
          (suggestionIndex +
            (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) %
          suggestions.length;
        renderSuggestions();
      }
    },
    {capture: true},
  );
  $('parent-prompt').addEventListener('blur', () => {
    $('command-suggestions').hidden = true;
  });
  $('extension-dialog-search').addEventListener('input', renderDialogOptions);
  $('extension-dialog-select').addEventListener('change', () => {
    if (activeDialog?.kind === 'select')
      activeDialog.selection = $('extension-dialog-select').value;
  });
  for (const button of $('extension-dialog-actions').querySelectorAll('button'))
    button.addEventListener(
      'click',
      () => void respondAction(button.dataset.action),
    );
  $('extension-dialog-form').addEventListener('submit', event => {
    event.preventDefault();
    void respond(false);
  });
  $('cancel-extension-dialog').addEventListener(
    'click',
    () => void respond(true),
  );
  $('extension-dialog').addEventListener('cancel', event => {
    event.preventDefault();
    if (activeDialog?.kind !== 'terminal') void respond(true);
  });
  window.addEventListener('unload', disposeTerminal);
}
export function renderSessionFeatures(data, options = {parent: true}) {
  parentView = !!data && options.parent;
  if (!parentView) {
    for (const id of ['commands-dialog', 'extension-dialog'])
      if ($(id).open) $(id).close();
    disposeTerminal();
    activeDialog = undefined;
  }
  if (!data) {
    current = undefined;
    previousId = undefined;
    contextConversation = undefined;
    clearTimeout(contextRefreshTimer);
    $('command-suggestions').hidden = true;
    $('open-commands').disabled = true;
    renderSettingsControls();
    return;
  }
  const changedSession = current?.session.id !== data.session.id;
  if (changedSession) $('session-settings-error').hidden = true;
  current = data;
  const conversation = JSON.stringify([
    data.session.id,
    (data.conversation || [])
      .filter(item => !item.streaming && item.status !== 'running')
      .map(item => [item.id, item.status, item.text?.length]),
  ]);
  if (contextConversation !== conversation) {
    contextConversation = conversation;
    clearTimeout(contextRefreshTimer);
    if (!changedSession && !$('panel-context').hidden)
      contextRefreshTimer = setTimeout(() => {
        if (
          current?.session.id === data.session.id &&
          !$('panel-context').hidden
        )
          refreshContext();
      }, 200);
  }
  if (
    previousId !== data.session.id ||
    previousModel !== data.session.model ||
    previousThinkingLevel !== data.session.thinkingLevel
  ) {
    previousId = data.session.id;
    previousModel = data.session.model;
    previousThinkingLevel = data.session.thinkingLevel;
    $('command-suggestions').hidden = true;
    void load(true);
  }
  const available = !!api?.sessionFeatures && data.session.status !== 'closed';
  $('open-commands').disabled = !available;
  renderSettingsControls();
  renderContext();
  if (parentView) renderExtensionUI(data);
}
