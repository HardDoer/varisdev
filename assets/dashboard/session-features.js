/* global document, window, setTimeout, clearTimeout, ResizeObserver */
import {openMarkdownFile} from './markdown-files.js';
import {nativeCommands} from './command-catalog.js';
const $ = id => document.getElementById(id);
const cache = new Map();
const sessionModels = new Map();
const loading = new Map();
const contextErrors = new Map();
const speedErrors = new Map();
const contextDisclosures = new Map();
let conversationView = true;
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
  agent: 'Agent',
};
let api;
let selected;
let draftChanged;
let current;
let previousId;
let previousModel;
let previousThinkingLevel;
let previousSpeedMode;
let activeDialog;
let dialogBusy = false;
const settingsBusy = new Set();
let suggestionIndex = 0;
let suggestions = [];
let terminalView;
let terminalFit;
let terminalObserver;
let terminalResizeFrame;
let terminalSize = '';
let terminalOutput = '';

function terminalTheme(appearance) {
  return appearance === 'light'
    ? {background: '#fafafa', foreground: '#202124'}
    : {background: '#10171d', foreground: '#e2edf3'};
}
function requestTerminalFit() {
  if (terminalResizeFrame !== undefined)
    window.cancelAnimationFrame(terminalResizeFrame);
  terminalResizeFrame = window.requestAnimationFrame(() => {
    terminalResizeFrame = undefined;
    const request = activeDialog;
    const panel = $('extension-dialog-terminal');
    if (
      !request?.terminal ||
      !terminalView ||
      panel.hidden ||
      !panel.isConnected
    )
      return;
    const proposed = terminalFit?.proposeDimensions();
    if (proposed) {
      panel.dataset.proposedColumns = String(proposed.cols);
      panel.dataset.proposedRows = String(proposed.rows);
    }
    terminalFit?.fit();
    panel.dataset.terminalColumns = String(terminalView.cols);
    panel.dataset.terminalRows = String(terminalView.rows);
    const columns = Math.max(20, Math.min(240, terminalView.cols));
    const rows = Math.max(6, Math.min(100, terminalView.rows));
    const size = `${columns}:${rows}`;
    if (
      size === terminalSize ||
      (columns === request.terminal.columns && rows === request.terminal.rows)
    )
      return;
    terminalSize = size;
    void api
      .respondToDialog(request.sessionId, request.id, {columns, rows})
      .catch(cause => {
        if (isActiveDialog(request)) error($('extension-dialog-error'), cause);
      });
  });
}
function renderTerminal(request) {
  const frame = request.terminal;
  if (!frame) return;
  if (!terminalView) {
    terminalView = new window.Terminal({
      cols: frame.columns,
      rows: frame.rows,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, monospace',
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      scrollback: 1000,
      // Extension components use Pi's terminal theme and its ANSI colors.
      theme: terminalTheme(frame.appearance),
    });
    terminalFit = new window.FitAddon.FitAddon();
    terminalView.loadAddon(terminalFit);
    terminalView.open($('extension-dialog-terminal'));
    terminalObserver = new ResizeObserver(requestTerminalFit);
    terminalObserver.observe($('extension-dialog-terminal'));
    terminalView.onData(value => {
      const request = activeDialog;
      if (!request?.terminal || dialogBusy) return;
      void api
        .respondToDialog(request.sessionId, request.id, {input: value})
        .catch(cause => {
          if (isActiveDialog(request))
            error($('extension-dialog-error'), cause);
        });
    });
    terminalOutput = '';
    terminalView.focus();
    requestTerminalFit();
  }
  const theme = terminalTheme(frame.appearance);
  terminalView.options.theme = theme;
  const panel = $('extension-dialog-terminal');
  panel.dataset.appearance = frame.appearance === 'light' ? 'light' : 'dark';
  panel.style.background = theme.background;
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
  requestTerminalFit();
}
function disposeTerminal() {
  terminalObserver?.disconnect();
  terminalObserver = undefined;
  if (terminalResizeFrame !== undefined)
    window.cancelAnimationFrame(terminalResizeFrame);
  terminalResizeFrame = undefined;
  terminalFit = undefined;
  terminalView?.dispose();
  terminalView = undefined;
  terminalSize = '';
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
function renderAgentProfile() {
  const resource = features();
  const profile =
    current?.session.agentProfile ||
    resource?.agentProfile ||
    (resource ? {id: 'default', name: 'Default'} : undefined);
  const label = $('agent-profile-label');
  const settings = $('session-maintenance-profile');
  if (!current || !profile) {
    label.hidden = true;
    label.textContent = '';
    label.style.removeProperty('--agent-profile-color');
    settings.hidden = true;
    $('session-maintenance-agent').textContent = '';
    return;
  }
  const name = profile.name || profile.id;
  const color = /^#[0-9a-f]{6}$/i.test(profile?.color || '')
    ? profile.color
    : '';
  label.textContent = name;
  label.title = `Configuration: ${name}${profile.id && profile.id !== name ? ` (${profile.id})` : ''}`;
  label.hidden = false;
  if (color) label.style.setProperty('--agent-profile-color', color);
  else label.style.removeProperty('--agent-profile-color');
  $('session-maintenance-agent').textContent = name;
  settings.hidden = false;
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
        renderAgentProfile();
        renderSettingsControls();
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
      if (selected()?.session.id === id) {
        renderContext();
        renderSettingsControls();
      }
    });
  loading.set(id, operation);
  renderContext();
  renderSettingsControls();
  return operation;
}
export function refreshSessionFeatures(id) {
  return load(true, id);
}
export function refreshContext() {
  renderContext();
  void refreshSessionFeatures();
}
export function refreshSpeed() {
  const id = current?.session.id;
  speedErrors.delete(id);
  if (!loading.has(id)) void load(true);
  else renderSettingsControls();
}
function renderContext() {
  if (!current) return;
  const id = current.session.id;
  const resource = features();
  const files = resource?.contextFiles || [];
  const cause = contextErrors.get(id);
  $('context-recipient').textContent = current.session.name;
  $('refresh-context').disabled = !api?.sessionFeatures || loading.has(id);
  $('context-status').textContent = loading.has(id)
    ? 'Refreshing context files…'
    : files.length
      ? ''
      : cause
        ? ''
        : 'No context files reported for this agent.';
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
    ...builtinCommands.filter(
      command =>
        !current?.agentId ||
        [
          'model',
          'thinking',
          'compact',
          'reload',
          'approvals',
          'fast',
          'ultrafast',
        ].includes(command.name),
    ),
    ...(features()?.commands || []).filter(
      command => !builtinCommands.some(local => local.name === command.name),
    ),
  ].filter(command =>
    `${command.name} ${command.description} ${sourceName[command.source] || ''}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
function suggestionPrefix(command) {
  return command.source === 'agent'
    ? `@${command.name}`
    : `/${command.name.replace(/^\//, '')}`;
}
function insertCommand(command) {
  const editor = $('parent-prompt');
  const prefix = suggestionPrefix(command);
  const existing = editor.value;
  const rest =
    command.source === 'agent' && existing.startsWith('@')
      ? ''
      : /^[/@]/.test(existing)
        ? existing.replace(/^[/@]\S*\s*/, '')
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
  const match = value.match(
    /^([/@])((?:agent:)?(?:(?:(?:builtin|global|repository|workspace):)?"(?:\\.|[^"\\])*"?|[^\s"@]*))$/u,
  );
  const container = $('command-suggestions');
  if (!match || document.activeElement !== $('parent-prompt')) {
    container.hidden = true;
    return;
  }
  const mentioning = match[1] === '@';
  if (
    mentioning &&
    (current?.agentId || features()?.agentProfile?.mode === 'subagent')
  ) {
    container.hidden = true;
    return;
  }
  const needle = match[2].toLocaleLowerCase();
  const rank = command => {
    const name = command.name.toLocaleLowerCase();
    return name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;
  };
  const candidates = mentioning
    ? (features()?.agentMentions || [])
        .filter(agent =>
          (agent.mention || `@${agent.id}`)
            .slice(1)
            .toLocaleLowerCase()
            .startsWith(needle),
        )
        .map(agent => ({
          name: (agent.mention || `@${agent.id}`).slice(1),
          description: agent.description || agent.name,
          source: 'agent',
        }))
    : commands(needle);
  suggestions = candidates.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
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
        node('strong', '', suggestionPrefix(command)),
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
    conversationView &&
    (current?.session.controllable ?? current?.session.owned) &&
    (current.session.status === 'idle' ||
      (['running', 'compacting'].includes(current.session.status) &&
        nativeCommands.find(command => command.name === name)?.live))
  );
}
function renderSettingsControls() {
  const speed = $('session-speed');
  const resource = features();
  const modes = ['regular', 'fast', 'ultrafast'].filter(mode =>
    (resource?.speedModes || ['regular']).includes(mode),
  );
  const signature = JSON.stringify(modes);
  if (speed.dataset.options !== signature) {
    speed.dataset.options = signature;
    speed.replaceChildren(
      ...['regular', 'fast', 'ultrafast'].map(mode => {
        const option = node(
          'option',
          '',
          mode === 'ultrafast'
            ? 'Ultrafast'
            : mode === 'fast'
              ? 'Fast'
              : 'Regular',
        );
        option.value = mode;
        option.disabled = !modes.includes(mode);
        return option;
      }),
    );
  }
  const busy = settingsBusy.has(current?.session.id);
  if (!busy) {
    const mode = resource?.speedMode ?? current?.session.speedMode ?? 'regular';
    speed.value = modes.includes(mode) ? mode : 'regular';
  }
  speed.disabled =
    busy ||
    contextErrors.has(current?.session.id) ||
    !canRunCommand('fast') ||
    !resource ||
    modes.length < 2;
  const cause =
    speedErrors.get(current?.session.id) ||
    contextErrors.get(current?.session.id);
  let speedStatus = '';
  if (current && !cause && !busy && !loading.has(current.session.id)) {
    if (!(current.session.controllable ?? current.session.owned))
      speedStatus = 'This conversation cannot be controlled.';
    else if (!resource?.model && !current.session.model)
      speedStatus = 'Choose a model to change speed.';
    else if (resource && modes.length < 2) {
      const model = resource.model
        ? `${resource.model.provider}/${resource.model.id}`
        : current.session.model;
      speedStatus = `${model} supports Regular speed only with the current provider and sign-in.`;
    }
  }
  $('speed-status').textContent = speedStatus;
  $('speed-status').hidden = !speedStatus;
  $('speed-error').hidden = !cause;
  if (cause) error($('speed-error'), cause);
  $('session-maintenance').hidden = !conversationView;
  $('session-maintenance-name').textContent = current?.session.name || '';
  $('compact-session').disabled =
    settingsBusy.has(current?.session.id) || !canRunCommand('compact');
  $('reload-session').disabled =
    settingsBusy.has(current?.session.id) || !canRunCommand('reload');
  $('open-approvals').disabled =
    settingsBusy.has(current?.session.id) || !canRunCommand('approvals');
}
async function runSessionCommand(name, args = '') {
  if (settingsBusy.has(current?.session.id) || !canRunCommand(name)) return;
  const id = current.session.id;
  settingsBusy.add(id);
  $('session-settings-error').hidden = true;
  const speedCommand = ['fast', 'ultrafast'].includes(name);
  const directCommand = name === 'approvals' || speedCommand;
  if (speedCommand) speedErrors.delete(id);
  else if (directCommand) $('app-error').hidden = true;
  renderSettingsControls();
  try {
    if (directCommand)
      await api.commandSession(id, `/${name}${args ? ` ${args}` : ''}`);
    else if (current.agentId && name === 'compact')
      await api.compactSession(id, args);
    else if (current.agentId && name === 'reload') await api.reloadSession(id);
    else
      await api.promptSession(id, {
        prompt: `/${name}${args ? ` ${args}` : ''}`,
      });
    await load(true, id);
  } catch (cause) {
    if (speedCommand) speedErrors.set(id, cause);
    else if (current?.session.id === id)
      error($(directCommand ? 'app-error' : 'session-settings-error'), cause);
  } finally {
    settingsBusy.delete(id);
    renderSettingsControls();
  }
}
function isActiveDialog(request) {
  return (
    activeDialog?.sessionId === request.sessionId &&
    activeDialog?.id === request.id
  );
}
function closeExtensionDialog() {
  const dialog = $('extension-dialog');
  if (!dialog.open) return;
  const editor = $('parent-prompt');
  const position = {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    direction: editor.selectionDirection,
    top: editor.scrollTop,
    left: editor.scrollLeft,
  };
  // The browser can restore a selection saved before another draft was loaded.
  dialog.close();
  editor.setSelectionRange(position.start, position.end, position.direction);
  editor.scrollTop = position.top;
  editor.scrollLeft = position.left;
  draftChanged();
}
function renderExtensionNotifications(notifications = []) {
  const notices = notifications.filter(item => !dismissed.has(item.id));
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
          renderExtensionNotifications(notifications);
        });
        notice.append(node('p', '', item.message), close);
        return notice;
      }),
    );
  }
}
function renderExtensionUI(data) {
  const ui = data.ui;
  const ownerId = data.uiOwnerId || data.session.id;
  renderExtensionNotifications(ui?.notifications);
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
  if (activeDialog?.sessionId === ownerId && activeDialog.id === request?.id) {
    activeDialog = {...activeDialog, ...request};
    renderDialogTabs();
    renderTerminal(request);
    renderDialogActions();
    return;
  }
  const dialog = $('extension-dialog');
  closeExtensionDialog();
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
  activeDialog = {...request, sessionId: ownerId};
  dialogBusy = false;
  renderDialogTabs();
  $('extension-dialog-title').textContent = request.title;
  $('extension-dialog-session').textContent =
    data.uiOwnerName || data.session.name;
  const terminal = Boolean(request.terminal);
  $('extension-dialog-message').textContent = request.message || '';
  $('extension-dialog-message').hidden = terminal || !request.message;
  $('extension-dialog-error').hidden = true;
  $('submit-extension-dialog').disabled = false;
  $('submit-extension-dialog').hidden = terminal;
  $('extension-dialog-terminal').hidden = !terminal;
  renderDialogActions();
  dialog.classList.toggle('terminal-dialog', terminal);
  $('cancel-extension-dialog').disabled = false;
  $('cancel-extension-dialog').textContent =
    request.kind === 'info' ? 'Close' : 'Cancel';
  $('submit-extension-dialog').textContent =
    request.kind === 'info' ? 'OK' : 'Continue';
  $('extension-dialog-search').hidden =
    terminal || request.kind !== 'select' || !request.searchable;
  $('extension-dialog-search').value = '';
  $('extension-dialog-current').hidden =
    terminal || request.kind !== 'select' || !request.selected;
  $('extension-dialog-current').textContent = request.selected
    ? `Current: ${request.selected}`
    : '';
  $('extension-dialog-input').hidden = terminal || request.kind !== 'input';
  $('extension-dialog-editor').hidden = terminal || request.kind !== 'editor';
  $('extension-dialog-select').hidden = terminal || request.kind !== 'select';
  $('extension-dialog-input').value = request.prefill || '';
  $('extension-dialog-input').placeholder = request.placeholder || '';
  $('extension-dialog-editor').value = request.prefill || '';
  renderDialogOptions();
  dialog.showModal();
  if (terminal) {
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
function renderDialogTabs() {
  const tabs = activeDialog?.tabs || [];
  $('extension-dialog-tabs').hidden = !tabs.length;
  for (const button of $('extension-dialog-tabs').querySelectorAll('button')) {
    const tab = tabs.find(item => item.id === button.dataset.tab);
    const selected = activeDialog?.activeTab === button.dataset.tab;
    button.hidden = !tab;
    button.disabled = dialogBusy;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (tab) button.textContent = tab.label;
  }
  const panel = $('extension-dialog-terminal');
  if (tabs.length) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute(
      'aria-labelledby',
      `extension-dialog-tab-${activeDialog.activeTab}`,
    );
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-labelledby');
  }
}
function renderDialogActions() {
  const actions = activeDialog?.terminal ? activeDialog.actions || [] : [];
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
async function respondAction(action, focusTab) {
  const request = activeDialog;
  if (
    dialogBusy ||
    !request?.terminal ||
    !(
      request.actions?.some(item => item.id === action) ||
      request.tabs?.some(item => `tab:${item.id}` === action)
    )
  )
    return;
  dialogBusy = true;
  renderDialogTabs();
  renderDialogActions();
  $('cancel-extension-dialog').disabled = true;
  try {
    await api.respondToDialog(request.sessionId, request.id, {action});
  } catch (cause) {
    if (isActiveDialog(request)) error($('extension-dialog-error'), cause);
  } finally {
    if (isActiveDialog(request)) {
      dialogBusy = false;
      renderDialogTabs();
      renderDialogActions();
      $('cancel-extension-dialog').disabled = false;
      if (focusTab) $(focusTab).focus();
      else terminalView?.focus();
    }
  }
}
function renderDialogOptions() {
  const request = activeDialog;
  if (!request || request.kind !== 'select' || request.terminal) {
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
  if (request.terminal && !cancelled) return;
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
    if (isActiveDialog(request)) {
      closeExtensionDialog();
      activeDialog = undefined;
      disposeTerminal();
    }
  } catch (cause) {
    if (isActiveDialog(request)) error($('extension-dialog-error'), cause);
  } finally {
    if (isActiveDialog(request)) {
      dialogBusy = false;
      $('submit-extension-dialog').disabled = false;
      $('cancel-extension-dialog').disabled = false;
    }
  }
}
export function initSessionFeatures(options) {
  api = options.api;
  selected = options.selected;
  draftChanged = options.draftChanged;
  $('refresh-context').addEventListener('click', refreshContext);
  $('app-menu-panel').addEventListener(
    'varisdev:app-menu-open',
    () => void load(true),
  );
  $('session-speed').addEventListener('change', () => {
    const mode = $('session-speed').value;
    if (!features()?.speedModes?.includes(mode)) return;
    void runSessionCommand(
      mode === 'ultrafast' ? 'ultrafast' : 'fast',
      mode === 'regular' ? 'off' : 'on',
    );
  });
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
    if (!conversationView) return;
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
  $('open-approvals').addEventListener(
    'click',
    () => void runSessionCommand('approvals'),
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
      if (
        event.key === 'Enter' &&
        suggestions[suggestionIndex].source !== 'agent' &&
        $('parent-prompt').value ===
          suggestionPrefix(suggestions[suggestionIndex])
      ) {
        $('command-suggestions').hidden = true;
        return;
      }
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
  for (const button of $('extension-dialog-tabs').querySelectorAll('button')) {
    button.addEventListener(
      'click',
      () => void respondAction(`tab:${button.dataset.tab}`),
    );
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      const tabs = activeDialog?.tabs || [];
      const index = tabs.findIndex(tab => tab.id === button.dataset.tab);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
              tabs.length;
      const tab = tabs[next];
      if (tab)
        void respondAction(`tab:${tab.id}`, `extension-dialog-tab-${tab.id}`);
    });
  }
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
    void respond(true);
  });
  window.addEventListener('unload', disposeTerminal);
}
export function renderSessionFeatures(data, options = {parent: true}) {
  conversationView = !!data && (options.available ?? options.parent);
  if (
    (!data || current?.session.id !== data.session.id) &&
    $('commands-dialog').open
  )
    $('commands-dialog').close();
  if (!data) {
    closeExtensionDialog();
    disposeTerminal();
    activeDialog = undefined;
    dialogBusy = false;
  }
  if (!data) {
    current = undefined;
    previousId = undefined;
    contextConversation = undefined;
    clearTimeout(contextRefreshTimer);
    $('command-suggestions').hidden = true;
    $('open-commands').disabled = true;
    renderAgentProfile();
    renderSettingsControls();
    return;
  }
  const changedSession = current?.session.id !== data.session.id;
  if (changedSession) {
    $('session-settings-error').hidden = true;
    speedErrors.delete(data.session.id);
  }
  if (
    sessionModels.has(data.session.id) &&
    sessionModels.get(data.session.id) !== data.session.model
  )
    cache.delete(data.session.id);
  sessionModels.set(data.session.id, data.session.model);
  current = data;
  renderAgentProfile();
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
    previousThinkingLevel !== data.session.thinkingLevel ||
    previousSpeedMode !== data.session.speedMode
  ) {
    previousId = data.session.id;
    previousModel = data.session.model;
    previousThinkingLevel = data.session.thinkingLevel;
    previousSpeedMode = data.session.speedMode;
    $('command-suggestions').hidden = true;
    void load(true);
  }
  const available = !!api?.sessionFeatures && data.session.status !== 'closed';
  $('open-commands').disabled = !available;
  renderAgentProfile();
  renderSettingsControls();
  renderContext();
  renderExtensionUI(data);
}
