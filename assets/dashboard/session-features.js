/* global document, window */
const $ = id => document.getElementById(id);
const cache = new Map();
const loading = new Map();
const dismissed = new Set();
const seenEditor = new Map();
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
      if (!activeDialog || activeDialog.kind !== 'terminal') return;
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
async function load(force = false) {
  const id = current?.session.id;
  if (!id || !api?.sessionFeatures) return;
  if (!force && cache.has(id)) return cache.get(id);
  if (loading.has(id)) return loading.get(id);
  const operation = api
    .sessionFeatures(id)
    .then(result => {
      cache.set(id, result);
      if (selected()?.session.id === id) {
        renderCatalog();
        renderSettings();
        renderSuggestions();
      }
      return result;
    })
    .catch(cause => {
      if (selected()?.session.id === id) {
        $('commands-status').textContent = cause.message;
        error($('session-settings-error'), cause);
      }
    })
    .finally(() => loading.delete(id));
  loading.set(id, operation);
  return operation;
}
function commands(query = '') {
  const needle = query.toLocaleLowerCase().replace(/^\//, '');
  return (features()?.commands || []).filter(command =>
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
  suggestions = commands(match[1]).slice(0, 8);
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
function renderSettings() {
  const resource = features();
  if (!resource) return;
  const model = $('session-model');
  model.replaceChildren(
    ...resource.models.map(item => {
      const option = node(
        'option',
        '',
        `${item.name || item.id} · ${item.provider}`,
      );
      option.value = `${item.provider}/${item.id}`;
      option.selected =
        item.provider === resource.model?.provider &&
        item.id === resource.model?.id;
      return option;
    }),
  );
  $('session-thinking').replaceChildren(
    ...resource.thinkingLevels.map(level => {
      const option = node('option', '', level);
      option.value = level;
      option.selected = level === resource.thinkingLevel;
      return option;
    }),
  );
  const running = !current || current.session.status !== 'idle';
  $('session-settings-note').textContent = running
    ? 'Model changes, compaction and reload are available when this session is idle.'
    : 'Uses the same models and credentials as Pi.';
  for (const id of [
    'apply-session-settings',
    'compact-session',
    'reload-session',
  ])
    $(id).disabled = settingsBusy || running;
  $('session-model').disabled =
    settingsBusy || running || !resource.models.length;
  $('session-thinking').disabled = settingsBusy || running;
  $('reload-session').disabled =
    settingsBusy || running || !current?.session.owned;
  $('reload-session').title = current?.session.owned
    ? ''
    : 'Use /reload in the attached terminal session.';
}
async function maintain(action) {
  if (settingsBusy || !current || current.session.status !== 'idle') return;
  const id = current.session.id;
  settingsBusy = true;
  $('session-settings-error').hidden = true;
  renderSettings();
  try {
    await action(id);
    if (selected()?.session.id === id) {
      await load(true);
      $('session-settings-note').textContent = 'Updated.';
    }
  } catch (cause) {
    error($('session-settings-error'), cause);
  } finally {
    settingsBusy = false;
    renderSettings();
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
  dialog.classList.toggle('terminal-dialog', request.kind === 'terminal');
  $('cancel-extension-dialog').disabled = false;
  $('extension-dialog-input').hidden = request.kind !== 'input';
  $('extension-dialog-editor').hidden = request.kind !== 'editor';
  $('extension-dialog-select').hidden = request.kind !== 'select';
  $('extension-dialog-input').value = request.prefill || '';
  $('extension-dialog-input').placeholder = request.placeholder || '';
  $('extension-dialog-editor').value = request.prefill || '';
  $('extension-dialog-select').replaceChildren(
    ...(request.options || []).map(value => {
      const option = node('option', '', value);
      option.value = value;
      return option;
    }),
  );
  if (request.options?.length) $('extension-dialog-select').selectedIndex = 0;
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
          ? 'extension-dialog-select'
          : 'submit-extension-dialog';
  $(target).focus();
}
async function respond(cancelled) {
  if (!activeDialog || dialogBusy) return;
  const request = activeDialog;
  if (request.kind === 'terminal' && !cancelled) return;
  const value = cancelled
    ? undefined
    : request.kind === 'confirm'
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
  $('open-session-settings').addEventListener('click', () => {
    $('session-settings-error').hidden = true;
    $('session-settings-dialog').showModal();
    renderSettings();
    void load(true);
  });
  $('close-session-settings').addEventListener('click', () =>
    $('session-settings-dialog').close(),
  );
  $('session-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    const model = features()?.models.find(
      item => `${item.provider}/${item.id}` === $('session-model').value,
    );
    if (!model) return;
    const thinkingLevel = $('session-thinking').value;
    void maintain(id =>
      api.configureSession(id, {
        provider: model.provider,
        modelId: model.id,
        thinkingLevel,
      }),
    );
  });
  $('compact-session').addEventListener(
    'click',
    () =>
      void maintain(id =>
        api.compactSession(
          id,
          $('compact-instructions').value.trim() || undefined,
        ),
      ),
  );
  $('reload-session').addEventListener(
    'click',
    () => void maintain(id => api.reloadSession(id)),
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
export function renderSessionFeatures(data) {
  current = data;
  if (previousId !== data.session.id || previousModel !== data.session.model) {
    previousId = data.session.id;
    previousModel = data.session.model;
    $('command-suggestions').hidden = true;
    void load(true);
  }
  const available = !!api?.sessionFeatures && data.session.status !== 'closed';
  $('open-commands').disabled = !available;
  $('open-session-settings').disabled = !available;
  if ($('session-settings-dialog').open) {
    const running = data.session.status !== 'idle';
    for (const id of [
      'apply-session-settings',
      'compact-session',
      'reload-session',
    ])
      $(id).disabled = settingsBusy || running;
    $('session-model').disabled =
      settingsBusy || running || !features()?.models.length;
    $('session-thinking').disabled = settingsBusy || running;
    $('reload-session').disabled =
      settingsBusy || running || !data.session.owned;
  }
  renderExtensionUI(data);
}
