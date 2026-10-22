/* global document, window, localStorage, setInterval, clearInterval, setTimeout, clearTimeout */
import {createTerminalTabs} from './terminal.js';
import {createRenderScheduler} from './render-scheduler.js';
import {bindConversationLinks, renderFileLinks} from './file-links.js';
import {createThemeScene} from './theme-scene.js';
import {createDraftStore, flushDrafts} from './draft-storage.js';
import {createFactoryCane} from './factory-cane.js';
import {createFactoryGun} from './factory-gun.js';
import {createFactoryFlamethrower} from './factory-flamethrower.js';
import {createProcessingEffects} from './processing-effects.js';
import {initThemes} from './themes.js';
import {initZoom} from './zoom.js';
import {initUpdates} from './updates.js';
import {initAccounts} from './accounts.js';
import {
  createNativeCommandRouter,
  createNavigationReceiver,
} from './native-commands.js';
import {initToolSettings} from './tool-settings.js';
import {initEnvironment} from './environment.js';
import {nativeCommand, parseSlashCommand} from './command-catalog.js';
import {initAppMenu} from './app-menu.js';
import {initLiveView} from './live-view.js';
import {initPanelResize} from './panel-resize.js';
import {initComposerResize} from './composer-resize.js';
import {initSessionHistory} from './session-history.js';
import {initRecentProjects} from './recent-projects.js';
import {initAgentControls} from './agent-controls.js';
import {initAgentTemplates} from './agent-templates.js';
import {createConversationVisualizations} from './visualizations.js';
import {initUsage, renderUsage} from './usage.js';
import {
  formatToolInput,
  formatToolResult,
  toolInputPreview,
} from './tool-display.js';
import {
  initMarkdownFiles,
  updateMarkdownFiles,
  openMarkdownFile,
} from './markdown-files.js';
import {
  initSessionFeatures,
  renderSessionFeatures,
  refreshContext,
} from './session-features.js';

const $ = id => document.getElementById(id);
const processingEffects = createProcessingEffects($('scene'), {
  getOrigin: () => $('parent-prompt'),
});
const LIVE = new Set(['queued', 'running', 'cancelling']);
const WORKING = new Set(['running', 'cancelling']);
const TABS = [
  'conversation',
  'details',
  'feed',
  'changes',
  'tokens',
  'context',
];
const STATUS = {
  idle: 'Ready',
  running: 'Working',
  compacting: 'Compacting',
  closed: 'Closed',
  queued: 'Queued',
  cancelling: 'Stopping',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const api = window.pidev;
const conversationVisualizations = createConversationVisualizations({
  api,
  root: $('panel-conversation'),
  dialog: $('conversation-image-dialog'),
});
const state = {
  hub: {sessions: [], launchCwd: ''},
  sessionId: null,
  unitId: 'parent',
  desiredSessionId: null,
  tab: 'conversation',
  historyQuery: '',
  motion: true,
  disposed: false,
};
const terminalTabs = createTerminalTabs(api, () => state.sessionId);
const parentNodes = new Map();
const workerNodes = new Map();
const historyNodes = new Map();
const labelNodes = new Map();
const fallbackNodes = new Map();
const feedNodes = new Map();
const changeNodes = new Map();
const conversationNodes = new Map();
const steeringNodes = new Map();
const disclosures = new Map();
const disclosureStorage = 'varisdev.factory.disclosures';
try {
  const saved = JSON.parse(localStorage.getItem(disclosureStorage) || '[]');
  if (Array.isArray(saved))
    for (const entry of saved.slice(-2000))
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'boolean'
      )
        disclosures.set(entry[0], entry[1]);
} catch {
  // Actions start collapsed when no saved preference is available.
}
let promptDraftStorageError;
const promptDraftStore = createDraftStore('varisdev.composer-drafts.v1', {
  maxLength: 500_000,
  validate: (id, draft) =>
    typeof id === 'string' &&
    id.length < 8192 &&
    draft &&
    typeof draft.value === 'string' &&
    draft.value.length <= 500_000 &&
    Number.isSafeInteger(draft.revision) &&
    draft.revision >= 0 &&
    ['start', 'end', 'scrollTop', 'scrollLeft'].every(
      key =>
        draft[key] === undefined ||
        (Number.isFinite(draft[key]) && draft[key] >= 0),
    ) &&
    (draft.direction === undefined ||
      ['none', 'forward', 'backward'].includes(draft.direction)) &&
    (draft.height === undefined ||
      (typeof draft.height === 'string' &&
        /^(?:\d+(?:\.\d+)?px)?$/.test(draft.height))),
  onError: () => {
    promptDraftStorageError =
      'Composer draft recovery could not be saved. Your draft remains in this window.';
    text($('prompt-error'), promptDraftStorageError);
    $('prompt-error').hidden = false;
  },
});
const promptDrafts = new Map(
  [...promptDraftStore.entries()].map(([id, draft]) => [
    id,
    {
      start: 0,
      end: 0,
      direction: 'none',
      scrollTop: 0,
      scrollLeft: 0,
      height: '',
      ...draft,
    },
  ]),
);
const composerHeightKey = 'varisdev.composer-heights.v1';
const composerHeights = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(composerHeightKey) || '[]');
  if (Array.isArray(saved))
    for (const entry of saved.slice(-200))
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        /^\d+(?:\.\d+)?px$/.test(entry[1])
      )
        composerHeights.set(entry[0], entry[1]);
} catch {
  // Use responsive defaults when panel preferences are unavailable.
}
function saveComposerHeight(id, height) {
  if ((composerHeights.get(id) || '') === height) return;
  composerHeights.delete(id);
  if (height) composerHeights.set(id, height);
  while (composerHeights.size > 200)
    composerHeights.delete(composerHeights.keys().next().value);
  try {
    if (composerHeights.size)
      localStorage.setItem(
        composerHeightKey,
        JSON.stringify([...composerHeights]),
      );
    else localStorage.removeItem(composerHeightKey);
  } catch {
    // Size preferences must not prevent recovery of unsent messages.
  }
}
const workspaceCache = new Map();
const workspacePending = new Set();
const promptErrors = new Map();
const sending = new Set();
const stopping = new Set();
const closingSessions = new Set();
const pausedActivity = new Set();
let stopEffectTimer;
let stopEffectSession;
let sceneMotion;
let unsubscribe;
let clock;
let inspectorKey = '';
let feedKey = '';
let lastFeedId;
let changeKey = '';
let conversationKey = '';
let conversationFollowing = true;
let conversationPointerActive = false;
let conversationScrollFrame;
let lastLayout = [];
let workspaceRendered = '';
let creating = false;
// Keep the original folder when closing succeeds but creation needs a retry.
let pendingReplacement;
let expandedEditor = null;
let pendingDraftPosition = null;
const composingEditors = new Set();
let snapshotVersion = 0;
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const renderScheduler = createRenderScheduler(render);
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const messageFields = [
  'role',
  'toolName',
  'text',
  'input',
  'at',
  'finishedAt',
  'status',
  'streaming',
  'error',
];

function node(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = String(content);
  return item;
}
function text(item, value) {
  const next =
    value === undefined || value === null || value === '' ? '—' : String(value);
  if (item.textContent !== next) item.textContent = next;
}
function conversationKind(unit, parent = false) {
  return parent
    ? 'main'
    : unit?.agentMode === 'subagent'
      ? 'subagent'
      : 'primary';
}
function conversationKindLabel(kind) {
  return kind === 'main'
    ? 'Main agent'
    : kind === 'subagent'
      ? 'Subagent'
      : 'Primary agent';
}
function updateRobot(item, kind) {
  item.className = `robot-glyph${kind === 'main' ? '' : ' agent'} robot-${kind}`;
  item.dataset.agentKind = kind;
  item.setAttribute('role', 'img');
  item.setAttribute('aria-label', conversationKindLabel(kind));
}
function robot(kind = 'main') {
  const item = node('span');
  updateRobot(item, kind);
  item.append(node('i'), node('span', 'robot-crown'));
  item.lastChild.setAttribute('aria-hidden', 'true');
  return item;
}
function statusName(status) {
  return STATUS[status] || 'Unknown';
}
function badge(item, status) {
  const className = `status-badge ${Object.hasOwn(STATUS, status) ? status : ''}`;
  if (item.className !== className) item.className = className;
  text(item, statusName(status));
}
function canControl(session) {
  return session.controllable ?? session.owned;
}
function parentHasWork(data) {
  return (
    ['running', 'compacting'].includes(data.session.status) ||
    sending.has(data.session.id) ||
    Boolean(data.queue?.steering?.length || data.queue?.followUp?.length)
  );
}
function parentHasError(session) {
  return session.status === 'idle' && Boolean(session.error);
}
function parentBadge(item, session) {
  badge(item, session.status);
  if (parentHasError(session)) {
    item.className = 'status-badge failed';
    text(item, 'Error');
  }
}
function snapshot() {
  return state.hub.sessions.find(item => item.session.id === state.sessionId);
}
function selectedUnit() {
  const data = snapshot();
  return state.unitId === 'parent'
    ? data?.session
    : data?.agents.find(item => item.id === state.unitId);
}
// Root keys retain the existing stored drafts; spawned conversations include their owner.
function conversationId(ownerId = state.sessionId, unitId = state.unitId) {
  return unitId === 'parent'
    ? ownerId
    : `agent:${JSON.stringify([ownerId, unitId])}`;
}
const conversationTargets = new Map();
function agentResumable(agent) {
  return agent.resumable ?? !(agent.autoCleanup && !LIVE.has(agent.status));
}
function conversationSnapshot() {
  const data = snapshot();
  if (!data || state.unitId === 'parent') return data;
  const agent = selectedUnit();
  if (!agent) return;
  const id = conversationId();
  conversationTargets.set(id, {ownerId: data.session.id, agentId: agent.id});
  return {
    ...data,
    session: {
      ...agent,
      id,
      owned: data.session.owned,
      controllable: canControl(data.session) && agentResumable(agent),
      status: !agentResumable(agent)
        ? 'closed'
        : LIVE.has(agent.status)
          ? 'running'
          : 'idle',
    },
    conversation: agent.conversation || [],
    queue: agent.queue || {steering: [], followUp: []},
    ui: data.ui && {dialogs: data.ui.dialogs},
    uiOwnerId: data.session.id,
    uiOwnerName: data.session.name,
    agentId: agent.id,
  };
}
function conversationControllable(data = snapshot(), unit = selectedUnit()) {
  return (
    !!data &&
    !!unit &&
    canControl(data.session) &&
    (state.unitId === 'parent'
      ? unit.status !== 'closed'
      : agentResumable(unit) && !!api?.agentSession)
  );
}
function conversationPromptable(data = snapshot(), unit = selectedUnit()) {
  return (
    conversationControllable(data, unit) &&
    (state.unitId === 'parent' || unit.agentMode !== 'subagent')
  );
}
function conversationHasWork(data = snapshot(), unit = selectedUnit()) {
  return state.unitId === 'parent'
    ? parentHasWork(data)
    : LIVE.has(unit.status) ||
        sending.has(conversationId()) ||
        Boolean(unit.queue?.steering?.length || unit.queue?.followUp?.length);
}
function featureRequest(id, action, fields, root) {
  const target = conversationTargets.get(id);
  return target
    ? api.agentSession(target.ownerId, {
        agentId: target.agentId,
        action,
        ...fields,
      })
    : root();
}
const conversationApi = {
  ...api,
  respondToDialog: (id, dialogId, value) =>
    api.respondToDialog(
      conversationTargets.get(id)?.ownerId || id,
      dialogId,
      value,
    ),
  sessionFeatures: id =>
    featureRequest(id, 'features', {}, () => api.sessionFeatures(id)),
  configureSession: (id, configuration) =>
    featureRequest(id, 'configure', {configuration}, () =>
      api.configureSession(id, configuration),
    ),
  promptSession: (id, request) =>
    featureRequest(id, 'prompt', request, () => api.promptSession(id, request)),
  commandSession: (id, command) =>
    featureRequest(id, 'command', {command}, () =>
      api.promptSession(id, {prompt: command}),
    ),
  compactSession: (id, instructions) =>
    featureRequest(id, 'compact', {instructions}, () =>
      api.compactSession(id, instructions),
    ),
  reloadSession: id =>
    featureRequest(id, 'reload', {}, () => api.reloadSession(id)),
};
function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : dateFormatter.format(parsed);
}
function duration(item) {
  const start = Date.parse(item.startedAt || item.createdAt || '');
  const finished =
    item.finishedAt || (item.status === 'closed' ? item.updatedAt : undefined);
  const end = finished ? Date.parse(finished) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
function counts(data) {
  return {
    working: data.agents.filter(item => WORKING.has(item.status)).length,
    queued: data.agents.filter(item => item.status === 'queued').length,
    completed: data.agents.filter(item => item.status === 'completed').length,
    failed: data.agents.filter(item => item.status === 'failed').length,
  };
}
function orderedAgents(agents) {
  const rank = item =>
    WORKING.has(item.status) ? 0 : item.status === 'queued' ? 1 : 2;
  return [...agents].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(b.finishedAt || b.createdAt).localeCompare(
        String(a.finishedAt || a.createdAt),
      ),
  );
}
function reconcile(container, map, items, key, create, update) {
  const ids = new Set(items.map(key));
  for (const [id, entry] of map) {
    if (!ids.has(id)) {
      entry.element.remove();
      map.delete(id);
    }
  }
  items.forEach((item, index) => {
    const id = key(item);
    let entry = map.get(id);
    if (!entry) {
      entry = create(item);
      map.set(id, entry);
    }
    update(entry, item);
    if (container.children[index] !== entry.element)
      container.insertBefore(entry.element, container.children[index] || null);
  });
}
function showError(error, target = $('app-error')) {
  text(target, error instanceof Error ? error.message : String(error));
  target.hidden = false;
}
function editorPosition(textarea) {
  return {
    start: textarea.selectionStart,
    end: textarea.selectionEnd,
    direction: textarea.selectionDirection,
    scrollTop: textarea.scrollTop,
    scrollLeft: textarea.scrollLeft,
    height: textarea.style.height,
  };
}
function restorePosition(textarea, position) {
  textarea.setSelectionRange(position.start, position.end, position.direction);
  textarea.scrollTop = position.scrollTop;
  textarea.scrollLeft = position.scrollLeft;
}
function persistComposerDraft(id) {
  const draft = promptDrafts.get(id);
  if (promptDraftStore.save(id, draft?.value ? draft : undefined)) {
    if (
      promptDraftStorageError &&
      $('prompt-error').textContent === promptDraftStorageError
    )
      $('prompt-error').hidden = true;
    promptDraftStorageError = undefined;
  }
}
function saveDraft() {
  if (!state.sessionId) return;
  const textarea = $('parent-prompt');
  const id = conversationId();
  const previous = promptDrafts.get(id);
  const position = editorPosition(textarea);
  saveComposerHeight(id, position.height);
  if (
    previous?.value === textarea.value &&
    Object.keys(position).every(key => previous[key] === position[key])
  )
    return;
  const revision =
    (previous?.revision || 0) + Number(previous?.value !== textarea.value);
  promptDrafts.set(id, {
    value: textarea.value,
    revision,
    ...position,
  });
  persistComposerDraft(id);
}
function restoreDraft(id) {
  const textarea = $('parent-prompt');
  const draft = promptDrafts.get(id) || {
    value: '',
    revision: 0,
    start: 0,
    end: 0,
    direction: 'none',
    scrollTop: 0,
    scrollLeft: 0,
    height: '',
  };
  textarea.value = draft.value;
  textarea.style.height = composerHeights.get(id) ?? draft.height;
  const error = promptErrors.get(id) || promptDraftStorageError;
  $('prompt-error').hidden = !error;
  if (error) text($('prompt-error'), error);
  restorePosition(textarea, draft);
  pendingDraftPosition = {id, position: draft};
}
function clearSubmittedDraft(id, submitted) {
  const current = promptDrafts.get(id);
  if (
    current?.revision !== submitted.revision ||
    current.value !== submitted.value
  )
    return;
  if (id === conversationId() && $('parent-prompt').value !== submitted.value)
    return;
  promptDrafts.set(id, {
    ...current,
    value: '',
    revision: current.revision + 1,
    start: 0,
    end: 0,
    direction: 'none',
    scrollTop: 0,
    scrollLeft: 0,
  });
  persistComposerDraft(id);
  if (id === conversationId()) restoreDraft(id);
}
function expandEditor(element, textarea, button) {
  if (expandedEditor) {
    collapseEditor();
    return;
  }
  const position = editorPosition(textarea);
  const inertNodes = [];
  let current = element;
  while (current.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling !== current) {
        inertNodes.push({element: sibling, inert: sibling.inert});
        sibling.inert = true;
      }
    }
    current = current.parentElement;
    if (current === document.body) break;
  }
  expandedEditor = {
    element,
    textarea,
    button,
    inertNodes,
    height: position.height,
  };
  element.classList.add('editor-expanded');
  element.setAttribute('popover', 'manual');
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', 'parent-editor-label');
  button.setAttribute('aria-expanded', 'true');
  text(button, 'Close editor');
  element.showPopover();
  textarea.focus({preventScroll: true});
  restorePosition(textarea, position);
}
function collapseEditor(focus = true) {
  if (!expandedEditor) return;
  const {element, textarea, button, inertNodes, height} = expandedEditor;
  const position = editorPosition(textarea);
  expandedEditor = null;
  element.hidePopover();
  element.classList.remove('editor-expanded');
  for (const name of ['popover', 'role', 'aria-modal', 'aria-labelledby'])
    element.removeAttribute(name);
  for (const entry of inertNodes) entry.element.inert = entry.inert;
  textarea.style.height = height;
  button.setAttribute('aria-expanded', 'false');
  text(button, 'Expand editor');
  if (focus) textarea.focus({preventScroll: true});
  restorePosition(textarea, position);
  if (textarea === $('parent-prompt')) saveDraft();
  sizeInspector();
}
function resizeTextarea(textarea, height) {
  if (height === undefined) textarea.style.removeProperty('height');
  else if (typeof height === 'string') textarea.style.height = height;
  else {
    const style = window.getComputedStyle(textarea);
    const min = Number.parseFloat(style.minHeight) || 0;
    const max = Number.parseFloat(style.maxHeight) || window.innerHeight;
    const next = Math.min(Math.max(height, min), max);
    textarea.style.height = `${Math.round(next)}px`;
  }
  saveDraft();
  sizeInspector();
}
function initTextareaResize(handle, textarea) {
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = textarea.getBoundingClientRect().height;
    const move = moveEvent => {
      resizeTextarea(textarea, startHeight + moveEvent.clientY - startY);
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });
  handle.addEventListener('keydown', event => {
    if (
      !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home'].includes(
        event.key,
      )
    )
      return;
    event.preventDefault();
    const step = event.key.startsWith('Page') ? 48 : 16;
    if (event.key === 'Home') resizeTextarea(textarea, 0);
    else
      resizeTextarea(
        textarea,
        textarea.getBoundingClientRect().height +
          (event.key === 'ArrowUp' || event.key === 'PageUp' ? -step : step),
      );
  });
}
function submitFromEditor(event, form) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229 ||
    composingEditors.has(event.currentTarget)
  )
    return;
  event.preventDefault();
  if (event.repeat) return;
  if (!form.checkValidity()) {
    if (expandedEditor?.textarea === event.currentTarget) collapseEditor(false);
    form.reportValidity();
    return;
  }
  form.requestSubmit();
}

function selectSession(id, unitId = 'parent') {
  if (
    (state.sessionId === id && state.unitId === unitId) ||
    !state.hub.sessions.some(item => item.session.id === id)
  )
    return;
  saveDraft();
  saveConversationDisclosures();
  state.sessionId = id;
  state.unitId = unitId;
  if (unitId !== 'parent') terminalTabs.showPrompt();
  state.historyQuery = '';
  $('history-search').value = '';
  restoreDraft(conversationId());
  setTab('conversation');
  render();
}
function selectUnit(id) {
  if (id !== 'parent' && !snapshot()?.agents.some(item => item.id === id))
    return;
  liveView.close();
  if (state.unitId !== id) {
    saveConversationDisclosures();
    saveDraft();
    state.unitId = id;
    if (id !== 'parent') terminalTabs.showPrompt();
    restoreDraft(conversationId());
  }
  setTab('conversation');
  render();
}
function createParentCard(data) {
  const element = node('button', 'parent-card');
  element.type = 'button';
  const header = node('span', 'parent-card-header');
  const name = node('span', 'parent-card-name');
  const status = node('span', 'status-badge');
  header.append(robot(), name, status);
  const path = node('span', 'project-path mono');
  const activity = node('span', 'parent-card-activity');
  element.append(header, path, activity);
  element.addEventListener('click', () => selectSession(data.session.id));
  return {element, name, status, path, activity};
}
function renderOverview() {
  const workspaces = [...state.hub.sessions].sort((a, b) => {
    const active = data =>
      ['running', 'compacting'].includes(data.session.status) ||
      data.agents.some(agent => LIVE.has(agent.status));
    return (
      Number(active(b)) - Number(active(a)) ||
      String(b.session.startedAt).localeCompare(String(a.session.startedAt))
    );
  });
  reconcile(
    $('parents'),
    parentNodes,
    workspaces,
    data => data.session.id,
    createParentCard,
    (entry, data) => {
      const session = data.session;
      const selected = session.id === state.sessionId;
      entry.element.classList.toggle('selected', selected);
      entry.element.setAttribute('aria-pressed', String(selected));
      text(entry.name, session.name);
      parentBadge(entry.status, session);
      const needsInput = !!data.ui?.dialogs?.length;
      entry.element.classList.toggle(
        'attention',
        Boolean(session.error) || needsInput,
      );
      text(entry.path, session.cwd);
      text(
        entry.activity,
        needsInput
          ? `Needs input: ${data.ui.dialogs[0].title}`
          : session.error || session.activity || 'Waiting for a task',
      );
      entry.element.title = `${session.name}\n${session.cwd}\n${session.activity || ''}\n${data.agents.length + 1} agents${session.error ? `\n${session.error}` : ''}`;
    },
  );
  const working = workspaces.reduce(
    (sum, data) =>
      sum +
      Number(['running', 'compacting'].includes(data.session.status)) +
      data.agents.filter(agent => WORKING.has(agent.status)).length,
    0,
  );
  text(
    $('hub-counts'),
    workspaces.length
      ? `${workspaces.length} ${workspaces.length === 1 ? 'workspace' : 'workspaces'} · ${working} working ${working === 1 ? 'agent' : 'agents'}`
      : 'No workspaces yet',
  );
  $('hub-counts').title = $('hub-counts').textContent;
}
function createSceneLabel(id) {
  const element = node(
    'button',
    `scene-label${id === 'parent' ? ' parent-label' : ''}`,
  );
  element.type = 'button';
  const name = node('span', 'scene-label-name');
  element.append(name);
  element.addEventListener('click', () => selectUnit(id));
  $('scene-labels').append(element);
  return {element, name};
}
function layoutLabels(layout) {
  lastLayout = layout;
  processingEffects.layout(layout);
  const data = snapshot();
  if (!data || !scene?.hasCanvas()) return;
  const ids = new Set(layout.map(item => item.id));
  for (const [id, entry] of labelNodes) {
    if (!ids.has(id)) {
      entry.element.remove();
      labelNodes.delete(id);
    }
  }
  for (const anchor of layout) {
    const unit =
      anchor.id === 'parent'
        ? data.session
        : data.agents.find(item => item.id === anchor.id);
    if (!unit) continue;
    let entry = labelNodes.get(anchor.id);
    if (!entry) {
      entry = createSceneLabel(anchor.id);
      labelNodes.set(anchor.id, entry);
    }

    const name = anchor.detail ? `${unit.name} · ${anchor.detail}` : unit.name;
    const selected = state.unitId === anchor.id;
    const title = `${unit.name}${anchor.detail ? `\n${anchor.detail}` : ''}\n${anchor.id === 'parent' ? unit.prompt || '' : unit.task}\n${unit.activity || ''}`;
    text(entry.name, name);
    if (entry.selected !== selected) {
      entry.selected = selected;
      entry.element.classList.toggle('selected', selected);
      entry.element.setAttribute('aria-pressed', String(selected));
    }
    if (entry.element.title !== title) entry.element.title = title;
  }
}
function sceneAgents(data) {
  const agents = orderedAgents(data.agents);
  const live = agents.filter(item => LIVE.has(item.status));
  const history = agents.filter(item => !LIVE.has(item.status));
  const selected = history.find(item => item.id === state.unitId);
  return [
    ...live,
    ...(selected ? [selected] : []),
    ...history.filter(item => item !== selected),
  ].slice(0, Math.max(6, Math.min(8, live.length)));
}
function renderFallback(data) {
  const units = [{...data.session, id: 'parent'}, ...sceneAgents(data)];
  reconcile(
    $('fallback-units'),
    fallbackNodes,
    units,
    unit => unit.id,
    unit => {
      const element = node('button');
      element.type = 'button';
      const mark = robot(conversationKind(unit, unit.id === 'parent'));
      const status = node('span');
      const name = node('strong');
      const task = node('p');
      const activity = node('p', 'muted');
      element.append(mark, status, name, task, activity);
      element.addEventListener('click', () => selectUnit(unit.id));
      return {element, mark, status, name, task, activity};
    },
    (entry, unit) => {
      entry.element.dataset.unitId = unit.id;
      const parent = unit.id === 'parent';
      const kind = conversationKind(unit, parent);
      const task = parent ? unit.prompt || 'Main agent prompt' : unit.task;
      const activity = unit.activity || statusName(unit.status);
      entry.element.className = `fallback-station ${parent ? 'parent-session' : 'agent'} ${Object.hasOwn(STATUS, unit.status) ? unit.status : ''}`;
      entry.element.dataset.agentKind = kind;
      updateRobot(entry.mark, kind);
      entry.element.classList.toggle('selected', state.unitId === unit.id);
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === unit.id),
      );
      entry.element.title = `${conversationKindLabel(kind)} · ${unit.name}\n${task}\n${activity}`;
      badge(entry.status, unit.status);
      text(entry.name, unit.name);
      text(entry.task, task);
      text(entry.activity, activity);
    },
  );
}
function sizeInspector() {
  if (!snapshot() || $('factory-workspace').hidden) return;
  const element = $('inspector');
  const available = Math.max(300, $('factory-workspace').clientHeight);
  element.style.setProperty('--inspector-space', `${Math.round(available)}px`);
}
function sizeScene() {
  const element = $('scene');
  element.classList.toggle(
    'compact-scene',
    element.clientHeight < (scene?.hasCanvas() ? 360 : 620),
  );
}
function resizeFactory() {
  sizeScene();
  sizeInspector();
  if (scene?.hasCanvas()) layoutLabels(lastLayout);
}
function setSceneMotion(enabled) {
  const animation = scene;
  if (!animation || sceneMotion === enabled) return;
  sceneMotion = enabled;
  animation.setMotion(enabled);
  factoryCane.setMotion(enabled);
  factoryGun.setMotion(enabled);
  factoryFlamethrower.setMotion(enabled);
}
function activityPhase(data) {
  if (stopping.has(data.session.id)) return 'Stopping';
  if (pausedActivity.has(data.session.id))
    return data.agents.some(agent => WORKING.has(agent.status))
      ? 'Agents running'
      : '';
  if (data.ui?.dialogs?.length) return 'Needs input';
  if (data.session.status === 'compacting') return 'Compacting';
  if (data.session.status !== 'running')
    return data.agents.some(agent => WORKING.has(agent.status))
      ? 'Agents running'
      : '';
  if (/thinking/i.test(data.session.activity)) return 'Thinking';
  if (
    /using|tool|running (bash|read|write|edit|agent_)/i.test(
      data.session.activity,
    )
  )
    return 'Running tools';
  if (/responding|writing/i.test(data.session.activity)) return 'Writing';
  return 'Working';
}
function renderProcessing(data) {
  if (!parentHasWork(data)) pausedActivity.delete(data.session.id);
  const phase = activityPhase(data);
  const processing = !!phase && !['Stopping', 'Needs input'].includes(phase);
  $('scene').classList.toggle('is-processing', processing);
  $('scene').classList.toggle('is-stopping', phase === 'Stopping');
  $('processing-bubble').hidden = !processing;
  $('processing-bubble').dataset.phase = phase;
  text($('processing-bubble-text'), phase);
  $('processing-state').hidden = !phase;
  $('processing-state').classList.toggle('paused', !processing);
  text($('processing-state-text'), phase);
  setSceneMotion(state.motion && !motionPreference.matches);
}
function clearStopEffect() {
  clearTimeout(stopEffectTimer);
  const session = stopEffectSession;
  stopEffectSession = undefined;
  $('scene').classList.remove('is-startled');
  scene?.clearStartle();
  const data = snapshot();
  if (!state.disposed && session && data?.session.id === session)
    renderProcessing(data);
}
function stopEffect() {
  clearStopEffect();
  stopEffectSession = state.sessionId;
  const element = $('scene');
  // Restart the alert and fallback robot animation for each stop.
  void element.offsetWidth;
  element.classList.add('is-startled');
  scene?.startle(state.motion && !motionPreference.matches);
  stopEffectTimer = setTimeout(clearStopEffect, 1100);
}
function renderFactory() {
  const data = snapshot();
  if (!data) return;
  const session = data.session;
  if (stopEffectSession && stopEffectSession !== session.id) clearStopEffect();
  const tally = counts(data);
  const selected = selectedUnit() || session;
  updateRobot(
    $('selected-conversation-mark'),
    conversationKind(selected, state.unitId === 'parent'),
  );
  text($('factory-title'), selected.name);
  $('factory-title').title = selected.name;
  text($('factory-model'), selected.model);
  $('factory-model').title = selected.model || '';
  text($('factory-effort'), `Effort: ${selected.thinkingLevel ?? ''}`);
  $('factory-effort').hidden = !selected.thinkingLevel;
  if (state.unitId === 'parent') parentBadge($('parent-status'), selected);
  else badge($('parent-status'), selected.status);
  for (const [key, value] of Object.entries(tally)) {
    const item = $(
      `metric-${key === 'failed' ? 'attention' : key === 'working' ? 'running' : key}`,
    );
    if (item) text(item, value);
  }
  const context = selected.context;
  text(
    $('context-meter'),
    context
      ? `${context.percent === null ? '—' : `${Math.round(context.percent)}%`} · ${context.tokens === null ? '—' : context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens`
      : '',
  );
  $('context-meter').hidden = !context;
  text(
    $('parent-activity'),
    selected.activity || selected.task || 'Waiting for a task',
  );
  $('parent-activity').title = $('parent-activity').textContent;
  renderProcessing(data);
  agentControls.render();
  processingEffects.update(data, {
    motion: state.motion && !motionPreference.matches,
    stopping: stopping.has(session.id) || pausedActivity.has(session.id),
  });
  if (!scene.hasCanvas()) renderFallback(data);
  scene.update(data, state.unitId);
  if (scene.hasCanvas()) layoutLabels(lastLayout);
}
function createWorkerCard(agent) {
  const element = node('button', 'worker-card');
  element.type = 'button';
  const header = node('span', 'worker-card-header');
  const mark = robot(conversationKind(agent));
  const name = node('span', 'worker-card-name');
  const status = node('span');
  header.append(mark, name, status);
  const task = node('span', 'worker-card-task');
  const activity = node('span', 'worker-card-activity');
  const meta = node('span', 'worker-card-meta');
  const model = node('span');
  const time = node('span');
  meta.append(model, time);
  element.append(header, task, activity, meta);
  element.addEventListener('click', () => selectUnit(agent.id));
  return {element, mark, name, status, task, activity, model, time};
}
function createHistoryRow(agent) {
  const element = node('button', 'history-row');
  element.type = 'button';
  const mark = robot(conversationKind(agent));
  const info = node('span', 'history-row-info');
  const name = node('span', 'history-row-name');
  const task = node('span', 'history-row-task');
  const status = node('span');
  info.append(name, task);
  element.append(mark, info, status);
  element.addEventListener('click', () => selectUnit(agent.id));
  return {element, mark, name, task, status};
}
function renderWorkers() {
  const data = snapshot();
  if (!data) return;
  const agents = orderedAgents(data.agents);
  const active = agents.filter(item => LIVE.has(item.status));
  const history = agents.filter(item => !LIVE.has(item.status));
  reconcile(
    $('active-workers'),
    workerNodes,
    active,
    item => item.id,
    createWorkerCard,
    (entry, agent) => {
      const kind = conversationKind(agent);
      entry.element.classList.toggle('selected', state.unitId === agent.id);
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === agent.id),
      );
      entry.element.dataset.status = agent.status;
      entry.element.dataset.agentKind = kind;
      updateRobot(entry.mark, kind);
      text(entry.name, agent.name);
      badge(entry.status, agent.status);
      text(entry.task, agent.task);
      text(entry.activity, agent.activity || 'Waiting for activity');
      text(entry.model, agent.model);
      text(entry.time, duration(agent));
      entry.element.title = `${conversationKindLabel(kind)} · ${agent.name}\n${agent.task}\n${agent.activity || ''}\n${agent.model}`;
    },
  );
  $('no-workers').hidden = active.length > 0;
  const filtered = history.filter(
    item =>
      !state.historyQuery ||
      `${item.name}\n${item.task}\n${item.id}`
        .toLocaleLowerCase()
        .includes(state.historyQuery),
  );
  reconcile(
    $('history-workers'),
    historyNodes,
    filtered,
    item => item.id,
    createHistoryRow,
    (entry, agent) => {
      const kind = conversationKind(agent);
      entry.element.classList.toggle('selected', state.unitId === agent.id);
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === agent.id),
      );
      entry.element.dataset.agentKind = kind;
      updateRobot(entry.mark, kind);
      text(entry.name, agent.name);
      text(entry.task, agent.task);
      badge(entry.status, agent.status);
      entry.element.title = `${conversationKindLabel(kind)} · ${agent.name}\n${agent.task}`;
    },
  );
  text($('active-count'), active.length);
  text($('history-count'), history.length);
  $('no-history').hidden = filtered.length > 0;
  text(
    $('no-history'),
    history.length
      ? 'No agents match this history search.'
      : 'Completed agents appear here.',
  );
}
function facts(target, pairs) {
  if (
    target._facts?.length === pairs.length &&
    pairs.every(
      ([key, value], index) =>
        target._facts[index][0] === key && target._facts[index][1] === value,
    )
  )
    return;
  target._facts = pairs;
  target.replaceChildren(
    ...pairs.flatMap(([key, value]) => [
      node('dt', '', key),
      node(
        'dd',
        '',
        value === undefined || value === null || value === '' ? '—' : value,
      ),
    ]),
  );
}
function renderDiff(target, value) {
  target.replaceChildren(
    ...String(value || '')
      .split('\n')
      .map(line => {
        let type = '';
        if (
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('@@') ||
          line.startsWith('diff ')
        )
          type = 'header';
        else if (line.startsWith('+')) type = 'add';
        else if (line.startsWith('-')) type = 'remove';
        return node('span', `diff-line ${type}`, line);
      }),
  );
}
function detailValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return formatToolResult(value);
}
function renderFeedDetails(entry, event, tool, worker) {
  const fields = {
    ...(worker
      ? {
          Agent: worker.name,
          Task: worker.task,
          'Current activity': worker.activity,
          'Latest result': worker.output,
        }
      : {}),
    ...event.details,
    ...(tool
      ? {
          Tool: tool.toolName,
          Status: statusName(tool.status),
          Input: tool.input ?? '',
          Output:
            tool.text ||
            (tool.status === 'running'
              ? 'Waiting for output…'
              : 'No text output'),
          Error: tool.error,
          Started: date(tool.at),
          Finished: tool.finishedAt ? date(tool.finishedAt) : undefined,
        }
      : {}),
  };
  if (fields.Message === event.message) delete fields.Message;
  if (fields.Status && STATUS[fields.Status])
    fields.Status = statusName(fields.Status);
  const values = Object.entries(fields).filter(
    ([label, value]) =>
      (label === 'Input' && value !== undefined) ||
      (value !== undefined && value !== null && value !== ''),
  );
  const selection = window.getSelection();
  reconcile(
    entry.content,
    entry.fields,
    values,
    ([label]) => label,
    ([label]) => {
      const element = node('div', 'feed-detail');
      const heading = node('dt', '', label);
      const value = node('dd');
      const content = node(
        'pre',
        label === 'Diff' ? 'diff' : 'feed-detail-text',
      );
      const textNode = document.createTextNode('');
      if (label !== 'Diff') content.append(textNode);
      value.append(content);
      element.append(heading, value);
      element.classList.toggle('error', label === 'Error');
      return {element, content, textNode, previous: undefined};
    },
    (field, [label, value]) => {
      const toolName = label === 'Input' ? fields.Tool : undefined;
      if (field.previous === value && field.toolName === toolName) return;
      field.previous = value;
      field.toolName = toolName;
      const formatted =
        label === 'Input'
          ? formatToolInput(toolName, value)
          : detailValue(value);
      if (label === 'Diff') renderDiff(field.content, formatted);
      else updateStreamText(field.textNode, formatted, selection);
    },
  );
}
function renderFeed(data) {
  const key = `${state.sessionId}:${state.unitId}`;
  if (feedKey !== key) {
    feedNodes.clear();
    $('live-feed').replaceChildren();
    lastFeedId = undefined;
    feedKey = key;
  }
  const events = data.events.filter(item => item.sourceId === state.unitId);
  const worker = data.agents.find(item => item.id === state.unitId);
  const tools = new Map(
    (state.unitId === 'parent'
      ? data.conversation
      : worker?.conversation || []
    ).map(message => [message.id, message]),
  );
  const body = $('panel-feed');
  const nearBottom =
    body.scrollHeight - body.scrollTop - body.clientHeight < 70;
  reconcile(
    $('live-feed'),
    feedNodes,
    events,
    item => item.id,
    event => {
      const element = node('li', 'feed-event');
      const details = node('details');
      const disclosureKey = `${key}:${event.id}`;
      preserveDisclosure(details, `feed:${disclosureKey}`);
      const summary = node('summary');
      const meta = node('span', 'feed-event-meta');
      const kind = node('span', 'feed-event-kind');
      const status = node('span', 'status-badge');
      const at = node('time');
      const message = node('span', 'feed-event-message');
      const content = node('dl', 'feed-details');
      meta.append(kind, status, at);
      summary.append(meta, message);
      details.append(summary, content);
      element.append(details);
      return {element, kind, status, at, message, content, fields: new Map()};
    },
    (entry, event) => {
      const tool = tools.get(event.conversationId);
      // Event details preserve the status at that point in the agent's work.
      const status =
        event.kind === 'error'
          ? 'failed'
          : event.details?.Status || tool?.status;
      const hasStatus = Object.hasOwn(STATUS, status);
      if (hasStatus) entry.element.dataset.status = status;
      else delete entry.element.dataset.status;
      entry.status.hidden = !hasStatus;
      if (hasStatus) badge(entry.status, status);
      entry.element.classList.toggle('error', event.kind === 'error');
      const [kind, label] =
        event.kind === 'tool'
          ? toolAction(event.details?.Tool || tool?.toolName)
          : [
              event.kind,
              {
                session: 'Session',
                agent: 'Agent',
                message: 'Message',
                error: 'Error',
              }[event.kind] || 'Activity',
            ];
      entry.element.dataset.action = kind === 'message' ? 'user' : kind;
      text(entry.kind, `${label} · ${event.sourceName}`);
      text(entry.at, date(event.at));
      entry.at.dateTime = event.at;
      text(entry.message, event.message);
      renderFeedDetails(entry, event, tool, worker);
    },
  );
  const latest = events.at(-1)?.id;
  if (
    $('follow-feed').checked &&
    state.tab === 'feed' &&
    (nearBottom || lastFeedId === undefined) &&
    latest !== lastFeedId
  )
    body.scrollTop = body.scrollHeight;
  lastFeedId = latest;
  text($('feed-count'), events.length);
  $('feed-empty').hidden = events.length > 0;
}
function renderChanges(data) {
  const key = `${state.sessionId}:${state.unitId}`;
  if (changeKey !== key) {
    changeNodes.clear();
    $('unit-changes').replaceChildren();
    changeKey = key;
  }
  const changes = data.changes
    .filter(item => item.unitId === state.unitId)
    .toReversed();
  reconcile(
    $('unit-changes'),
    changeNodes,
    changes,
    item => item.id,
    change => {
      const element = node('details', 'change-entry');
      preserveDisclosure(element, `change:${key}:${change.id}`);
      const summary = node('summary');
      const path = node('span', 'change-path');
      const meta = node('span', 'change-meta');
      const description = node('p', 'change-summary');
      const diff = node('pre', 'diff');
      const actions = node('div', 'file-actions');
      for (const [label, options] of [
        ['Open', {edit: true}],
        ['Pin', {pin: true}],
      ]) {
        const button = node('button', 'quiet-button', label);
        button.type = 'button';
        button.addEventListener('click', () =>
          openMarkdownFile(element.dataset.path, options),
        );
        actions.append(button);
      }
      summary.append(path, meta);
      element.append(summary, actions, description, diff);
      return {element, path, meta, description, diff, previousDiff: null};
    },
    (entry, change) => {
      entry.element.dataset.path = change.path;
      entry.element.querySelector('.file-actions').hidden = !/\.md$/i.test(
        change.path,
      );
      text(entry.path, change.path);
      text(
        entry.meta,
        `${change.tool} · ${date(change.at)} · ${change.unitName}`,
      );
      text(entry.description, change.summary);
      entry.description.hidden = !change.summary;
      if (entry.previousDiff !== change.diff) {
        renderDiff(entry.diff, change.diff);
        entry.previousDiff = change.diff;
      }
    },
  );
  text($('changes-count'), changes.length);
  $('changes-empty').hidden = changes.length > 0;
}
function conversationScope() {
  return `${state.sessionId}:${state.unitId}`;
}
function conversationData(data = snapshot()) {
  if (!data || state.unitId === 'parent') return data;
  const agent = data.agents.find(item => item.id === state.unitId);
  return (
    agent && {
      session: agent,
      conversation: agent.conversation || [],
    }
  );
}
function saveConversationDisclosures() {
  if (!state.sessionId || conversationKey !== conversationScope()) return;
  for (const details of $('conversation').querySelectorAll(
    'details[data-disclosure-key]',
  )) {
    const key = details.dataset.disclosureKey;
    if (details.open !== (disclosures.get(key) ?? false))
      disclosures.set(key, details.open);
  }
}
function followConversationBottom() {
  conversationFollowing = true;
  $('follow-conversation').checked = true;
  scheduleConversationBottom();
}
function cancelConversationBottom() {
  window.cancelAnimationFrame(conversationScrollFrame);
  conversationScrollFrame = undefined;
}
function scheduleConversationBottom() {
  if (
    state.tab !== 'conversation' ||
    !conversationFollowing ||
    conversationPointerActive ||
    !$('follow-conversation').checked ||
    conversationScrollFrame !== undefined
  )
    return;
  const key = conversationScope();
  conversationScrollFrame = window.requestAnimationFrame(() => {
    conversationScrollFrame = undefined;
    if (
      state.disposed ||
      state.tab !== 'conversation' ||
      conversationScope() !== key ||
      !conversationFollowing ||
      !$('follow-conversation').checked
    )
      return;
    const selection = window.getSelection();
    if (
      !selection?.isCollapsed &&
      $('conversation').contains(selection?.anchorNode)
    )
      return;
    const body = $('panel-conversation');
    body.scrollTop = body.scrollHeight;
  });
}
// Keep existing text nodes so selection and open tool details survive snapshots.
function updateStreamText(textNode, value, selection) {
  const next = String(value || '');
  const previous = textNode.data;
  if (next === previous) return false;
  if (next.startsWith(previous)) {
    textNode.appendData(next.slice(previous.length));
  } else {
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const startsHere = range?.startContainer === textNode;
    const endsHere = range?.endContainer === textNode;
    const start = range?.startOffset;
    const end = range?.endOffset;
    textNode.replaceData(0, previous.length, next);
    if (startsHere) range.setStart(textNode, Math.min(start, next.length));
    if (endsHere) range.setEnd(textNode, Math.min(end, next.length));
  }
  return true;
}
function preserveDisclosure(details, key) {
  details.dataset.disclosureKey = key;
  details.open = disclosures.get(key) ?? !key.startsWith('tool:');
  let previousOpen = details.open;
  details.addEventListener('toggle', () => {
    if (!details.isConnected || previousOpen === details.open) return;
    previousOpen = details.open;
    disclosures.delete(key);
    disclosures.set(key, details.open);
    if (disclosures.size > 2000)
      disclosures.delete(disclosures.keys().next().value);
    try {
      localStorage.setItem(disclosureStorage, JSON.stringify([...disclosures]));
    } catch {
      // Preserve the choice in memory if storage is unavailable.
    }
  });
}
function toolAction(name = '') {
  name = name.split('.').at(-1);
  if (name === 'bash') return ['command', 'Command'];
  if (['write', 'edit'].includes(name)) return ['edit', 'File change'];
  if (name === 'read') return ['read', 'Read file'];
  if (name.startsWith('agent_')) return ['agent', 'Agent'];
  if (['browse', 'download'].includes(name)) return ['web', 'Web'];
  if (['openai_image', 'image_preview'].includes(name))
    return ['media', 'Media'];
  if (name.endsWith('_query')) return ['read', 'Inspect data'];
  return ['tool', 'Tool'];
}
function conversationEntry(message) {
  const tool = message.role === 'tool';
  const element = node(
    'li',
    `conversation-message${tool ? ' conversation-tool' : ''}`,
  );
  const header = node('div', 'conversation-message-header');
  const role = node('strong');
  if (tool) {
    const [kind, label] = toolAction(message.toolName);
    element.dataset.action = kind;
    header.append(node('span', 'action-label', label));
  } else element.dataset.action = message.role;
  const time = node('time');
  const streaming = node(
    'span',
    tool ? 'tool-status' : 'conversation-streaming',
  );
  header.append(role, time, streaming);
  const content = node('pre', tool ? 'tool-output' : 'prose conversation-text');
  const textNode = document.createTextNode('');
  content.append(textNode);
  const error = node('p', 'conversation-error');
  const visualizations = conversationVisualizations.create();
  let inputNode;
  let inputPreview;
  let outputLabel;
  if (tool) {
    const details = node('details');
    const key = `${conversationScope()}:${message.id}`;
    preserveDisclosure(details, `tool:${key}`);
    const summary = node('summary');
    inputPreview = node('code', 'tool-input-preview');
    summary.append(header, inputPreview);
    const body = node('div', 'tool-body');
    const input = node('pre', 'tool-input');
    inputNode = document.createTextNode('');
    input.append(inputNode);
    outputLabel = node('h3', '', 'Output');
    body.append(
      node('h3', '', 'Input'),
      input,
      outputLabel,
      content,
      visualizations.element,
      error,
    );
    details.append(summary, body);
    element.append(details);
  } else {
    element.append(header, content, visualizations.element, error);
  }
  return {
    element,
    role,
    time,
    streaming,
    content,
    textNode,
    inputNode,
    inputPreview,
    outputLabel,
    error,
    visualizations,
    status: undefined,
  };
}
function renderConversation(snapshot) {
  const data = conversationData(snapshot);
  const parent = state.unitId === 'parent';
  const key = conversationScope();
  const sessionChanged = conversationKey !== key;
  if (sessionChanged) {
    conversationVisualizations.reset();
    conversationNodes.clear();
    $('conversation').replaceChildren();
    conversationKey = key;
    cancelConversationBottom();
    conversationFollowing = true;
    $('follow-conversation').checked = true;
  }
  const selection = window.getSelection();
  const selectedText =
    selection &&
    !selection.isCollapsed &&
    $('conversation').contains(selection.anchorNode);
  const messages = data.conversation || [];
  const messageKeys = new Set(messages.map(message => `${key}:${message.id}`));
  for (const [id, entry] of conversationNodes) {
    if (!messageKeys.has(id)) entry.visualizations.dispose();
  }
  let changed = sessionChanged || messages.length !== conversationNodes.size;
  text($('conversation-recipient'), `Agent · ${data.session.name}`);
  reconcile(
    $('conversation'),
    conversationNodes,
    messages,
    item => `${key}:${item.id}`,
    conversationEntry,
    (entry, message) => {
      entry.visualizations.update(message);
      if (
        entry.message &&
        messageFields.every(field => entry.message[field] === message[field])
      )
        return;
      const previous = entry.message;
      entry.message = message;
      changed = true;
      const tool = message.role === 'tool';
      entry.element.classList.toggle('user', message.role === 'user');
      text(
        entry.role,
        tool
          ? message.toolName
          : message.role === 'user'
            ? parent
              ? 'You'
              : 'User'
            : 'Assistant',
      );
      text(
        entry.time,
        tool
          ? duration({startedAt: message.at, finishedAt: message.finishedAt})
          : date(message.at),
      );
      entry.time.dateTime = message.at;
      entry.time.title = date(message.at);
      if (tool) {
        const status = message.status || 'completed';
        entry.element.dataset.status = status;
        entry.streaming.className = `tool-status ${status}`;
        text(
          entry.streaming,
          status === 'running' ? 'Running' : statusName(status),
        );
        changed = changed || status !== entry.status;
        entry.status = status;
        entry.streaming.hidden = false;
        if (
          !previous ||
          previous.input !== message.input ||
          previous.toolName !== message.toolName
        ) {
          text(
            entry.inputPreview,
            toolInputPreview(message.toolName, message.input),
          );
          updateStreamText(
            entry.inputNode,
            formatToolInput(message.toolName, message.input),
            selection,
          );
        }
        text(
          entry.outputLabel,
          message.text
            ? 'Output'
            : status === 'running'
              ? 'Waiting for output…'
              : 'No text output',
        );
      } else {
        entry.streaming.hidden = !message.streaming;
        text(entry.streaming, 'Streaming');
      }
      if (!previous || previous.text !== message.text) {
        if (tool)
          updateStreamText(
            entry.textNode,
            formatToolResult(message.text),
            selection,
          );
        else
          renderFileLinks(entry.content, message.text || '', (target, value) =>
            updateStreamText(target, value, selection),
          );
      }
      entry.error.hidden =
        !message.error || (tool && message.error === message.text);
      text(entry.error, message.error);
    },
  );
  const active = (
    parent ? ['running', 'compacting'] : ['running', 'cancelling']
  ).includes(data.session.status);
  const phase = parent
    ? activityPhase(data)
    : data.session.status === 'cancelling'
      ? 'Stopping'
      : '';
  const activity = $('conversation-activity');
  const activityText = $('conversation-activity-text');
  changed =
    changed ||
    activity.hidden === active ||
    activityText.textContent !== data.session.activity;
  activity.hidden = !active;
  activity.classList.toggle(
    'paused',
    phase === 'Stopping' ||
      phase === 'Needs input' ||
      (parent && pausedActivity.has(data.session.id)),
  );
  text(
    activityText,
    phase === 'Stopping' ? 'Stopping…' : data.session.activity || 'Working',
  );
  $('conversation-empty').hidden = messages.length > 0 || active;
  text(
    $('conversation-empty'),
    parent
      ? 'Messages and tool activity appear here as work happens.'
      : data.session.status === 'queued'
        ? 'Waiting for this agent to start.'
        : 'No conversation recorded for this agent.',
  );
  if (
    state.tab === 'conversation' &&
    $('follow-conversation').checked &&
    !selectedText &&
    (conversationFollowing || sessionChanged) &&
    changed
  ) {
    conversationFollowing = true;
    scheduleConversationBottom();
  }
}
function renderSteering(data) {
  const messages = (data.queue?.steering || []).map((text, index) => ({
    index,
    text,
  }));
  $('steering-messages').hidden = messages.length === 0;
  text($('steering-messages-title'), `Steering · ${messages.length}`);
  // Retain rows while snapshots arrive so steering text remains selectable.
  reconcile(
    $('steering-message-list'),
    steeringNodes,
    messages,
    item => `${data.session.id}:${item.index}:${item.text}`,
    () => {
      const element = node('li');
      const content = node('pre');
      element.append(content);
      return {element, content};
    },
    (entry, message) => text(entry.content, message.text),
  );
}
function renderInspector() {
  terminalTabs.update();
  const data = snapshot();
  const unit = selectedUnit();
  if (!data || !unit) return;
  const parent = state.unitId === 'parent';
  const kind = conversationKind(unit, parent);
  $('inspector').dataset.conversationKind = kind;
  document.querySelector('.conversation-kind').dataset.agentKind = kind;
  text($('conversation-kind-label'), conversationKindLabel(kind));
  const key = `${state.sessionId}:${state.unitId}`;
  if (inspectorKey !== key) {
    for (const tab of ['details', 'feed', 'changes', 'tokens'])
      $(`panel-${tab}`).scrollTop = 0;
    inspectorKey = key;
  }
  text($('inspector-title'), unit.name);
  $('inspector-title').title = unit.name;
  if (parent) parentBadge($('inspector-status'), unit);
  else badge($('inspector-status'), unit.status);
  text(
    $('inspector-activity'),
    unit.activity || (parent ? 'No current activity' : statusName(unit.status)),
  );
  $('back-to-parent').hidden = parent;
  $('tab-context').hidden =
    !api?.sessionFeatures || !conversationControllable(data, unit);
  if (!parent) {
    const active = WORKING.has(unit.status);
    $('processing-state').hidden = !active;
    $('processing-state').classList.toggle(
      'paused',
      unit.status === 'cancelling',
    );
    text(
      $('processing-state-text'),
      unit.status === 'cancelling' ? 'Stopping' : 'Agent working',
    );
  }
  renderInspectorPanel(data, unit, parent);
  renderSteering(conversationSnapshot());
  renderSessionFeatures(conversationSnapshot(), {
    parent,
    available: conversationControllable(data, unit),
  });
  updateMarkdownFiles();
  renderComposer(data, unit, parent);
}
function renderInspectorPanel(data, unit, parent) {
  if (state.tab === 'conversation') renderConversation(data);
  else if (state.tab === 'feed') renderFeed(data);
  else if (state.tab === 'changes') {
    renderChanges(data);
    renderWorkspace();
  } else if (state.tab === 'tokens') renderUsage(data);
  if (state.tab !== 'details') return;
  facts($('unit-facts'), [
    [
      'Configuration',
      unit.agentProfile?.name &&
      unit.agentProfile.id &&
      unit.agentProfile.name !== unit.agentProfile.id
        ? `${unit.agentProfile.name} (${unit.agentProfile.id})`
        : unit.agentProfile?.name || unit.agentProfile?.id,
    ],
    [
      'Status',
      parent && parentHasError(unit) ? 'Error' : statusName(unit.status),
    ],
    ['Model', unit.model],
    ['Effort', unit.thinkingLevel],
    ['Elapsed', duration(unit)],
    ['Started', date(unit.startedAt)],
    ['Created', date(parent ? unit.startedAt : unit.createdAt)],
    [
      parent ? 'Updated' : 'Finished',
      date(parent ? unit.updatedAt : unit.finishedAt),
    ],
    ['ID', unit.id],
    ...(parent
      ? [
          [
            'Control',
            canControl(unit)
              ? unit.owned
                ? 'Desktop agent'
                : 'Connected agent'
              : 'Unavailable',
          ],
        ]
      : [['Cleanup', unit.autoCleanup ? 'Automatic' : 'Retained']]),
  ]);
  text(
    $('unit-task'),
    parent ? unit.prompt || 'No prompt recorded yet.' : unit.task,
  );
  const result = parent ? unit.response : unit.output;
  text($('unit-result'), result);
  $('result-section').hidden = !result;
  $('result-truncated').hidden = !unit.outputTruncated;
  text($('unit-error'), unit.error);
  $('error-section').hidden = !unit.error;
  facts($('unit-paths'), [
    ['Folder', unit.cwd],
    ...(parent ? [['Session', unit.sessionFile]] : []),
    ...(!parent
      ? [
          ['Session', unit.sessionFile],
          ['Result', unit.resultFile],
        ]
      : []),
  ]);
}
function renderComposer(data, unit, parent) {
  const id = conversationId();
  const controllable = conversationControllable(data, unit);
  const promptable = conversationPromptable(data, unit);
  if (!promptable && expandedEditor?.textarea === $('parent-prompt'))
    collapseEditor(false);
  $('composer-slot').hidden = false;
  $('composer-slot').classList.remove('agent-selected');
  agentControls.render();
  $('agent-task-dock').hidden = parent || unit.agentMode !== 'subagent';
  text($('agent-task-text'), unit.task);
  $('parent-controls').hidden = !promptable;
  $('inspector').classList.toggle('has-composer', promptable);
  if (!promptable) $('command-suggestions').hidden = true;
  text($('prompt-recipient'), unit.name);
  $('attached-note').hidden = !parent || data.session.owned;
  text(
    $('attached-note'),
    canControl(data.session) ? 'Connected agent' : 'Disconnected agent',
  );
  if (pendingDraftPosition?.id === id && promptable) {
    restorePosition($('parent-prompt'), pendingDraftPosition.position);
    pendingDraftPosition = null;
  }
  const closing =
    closingSessions.has(id) || closingSessions.has(state.sessionId);
  $('abort-parent').disabled =
    !controllable ||
    !conversationHasWork(data, unit) ||
    stopping.has(id) ||
    closing;
  text($('abort-parent'), stopping.has(id) ? 'Stopping…' : 'Stop · Esc');
  $('send-prompt').disabled =
    !promptable || sending.has(id) || stopping.has(id) || closing;
  const steering = ['running', 'queued'].includes(unit.status);
  text($('prompt-action'), steering ? 'Steer' : 'Message');
  text(
    $('send-prompt'),
    sending.has(id) ? 'Sending…' : steering ? 'Steer' : 'Send',
  );
  $('send-prompt').title = steering
    ? 'Steer this agent at its next model turn'
    : 'Send a message';
  $('parent-prompt').placeholder = steering
    ? 'Guide the current task…'
    : parent
      ? 'Describe the next task, or @agent task…'
      : 'Describe the next task…';
}
function renderWorkspace() {
  const available = selectedUnit()?.cwd === snapshot()?.session.cwd;
  $('load-workspace').closest('.workspace-section').hidden = !available;
  if (!available) return;
  const cached = workspaceCache.get(state.sessionId);
  const pending = workspacePending.has(state.sessionId);
  $('load-workspace').disabled = pending;
  text(
    $('load-workspace'),
    pending ? 'Loading…' : cached ? 'Refresh folder diff' : 'View folder diff',
  );
  $('workspace-result').hidden = !cached;
  if (!cached) {
    workspaceRendered = '';
    return;
  }
  const {result, at} = cached;
  const key = `${state.sessionId}:${at}`;
  if (workspaceRendered === key) return;
  workspaceRendered = key;
  text(
    $('workspace-summary'),
    result.git
      ? `${result.files.length} changed files · read ${date(at)}\n${result.cwd}`
      : `No Git repository in ${result.cwd}. Agent edits are in Changes.`,
  );
  $('workspace-files').replaceChildren(
    ...result.files.map(file => {
      const item = node('li');
      item.append(
        node('span', '', file.status),
        document.createTextNode(file.path),
      );
      return item;
    }),
  );
  renderDiff($('workspace-diff'), result.diff);
  $('workspace-diff').hidden = !result.diff;
  $('workspace-truncated').hidden = !result.truncated;
}
function setTab(tab) {
  const previousTab = state.tab;
  state.tab = tab;
  for (const name of TABS) {
    const selected = name === tab;
    $(`tab-${name}`).setAttribute('aria-selected', String(selected));
    $(`tab-${name}`).tabIndex = selected ? 0 : -1;
    $(`panel-${name}`).hidden = !selected;
  }
  const data = snapshot();
  const unit = selectedUnit();
  if (data && unit) renderInspectorPanel(data, unit, state.unitId === 'parent');
  if (tab === 'context') refreshContext();
  if (tab === 'conversation' && previousTab !== 'conversation')
    followConversationBottom();
  if (tab === 'feed' && $('follow-feed').checked)
    $('panel-feed').scrollTop = $('panel-feed').scrollHeight;
}
let themeSessionId;
let themesDiscovered = false;
function render() {
  if (state.disposed) return;
  renderScheduler.rendered();
  const hasSession = Boolean(snapshot());
  liveView.setSession(hasSession ? state.sessionId : null);
  if (!hasSession && $('welcome').hidden) void recentProjects.refresh();
  $('welcome').hidden = hasSession;
  $('factory-workspace').hidden = !hasSession;
  factoryCane.setSession(hasSession ? state.sessionId : null);
  factoryGun.setSession(hasSession ? state.sessionId : null);
  factoryFlamethrower.setSession(hasSession ? state.sessionId : null);
  appMenu.place(hasSession);
  renderSessionActions();
  agentTemplates.render?.();
  if (!themesDiscovered || themeSessionId !== state.sessionId) {
    themesDiscovered = true;
    themeSessionId = state.sessionId;
    void cleanupThemes.refresh(state.sessionId ?? undefined);
  }
  renderOverview();
  if (hasSession) {
    renderFactory();
    renderWorkers();
    renderInspector();
  } else {
    clearStopEffect();
    cancelConversationBottom();
    conversationVisualizations.reset();
    conversationNodes.clear();
    $('conversation').replaceChildren();
    conversationKey = '';
    renderSessionFeatures(undefined, {parent: false});
    updateMarkdownFiles();
  }
}
function receive(hub) {
  if (state.disposed) return;
  snapshotVersion++;
  state.hub = agentControls.filterHub(hub);
  void receiveNavigation(hub);
  scene?.updateHub(state.hub);
  toolSettings.observe(hub);
  const next =
    state.desiredSessionId &&
    hub.sessions.some(item => item.session.id === state.desiredSessionId)
      ? state.desiredSessionId
      : hub.sessions.some(item => item.session.id === state.sessionId)
        ? state.sessionId
        : hub.sessions.some(item => item.session.id === hub.selectedSessionId)
          ? hub.selectedSessionId
          : hub.sessions[0]?.session.id || null;
  if (state.sessionId !== next) {
    if (expandedEditor) collapseEditor(false);
    saveDraft();
    saveConversationDisclosures();
    state.sessionId = next;
    state.unitId = 'parent';
    restoreDraft(next);
    setTab('conversation');
  }
  terminalTabs.retain(hub.sessions.map(item => item.session.id));
  if (next === state.desiredSessionId) state.desiredSessionId = null;
  if (
    state.unitId !== 'parent' &&
    !snapshot()?.agents.some(item => item.id === state.unitId)
  ) {
    saveDraft();
    state.unitId = 'parent';
    restoreDraft(conversationId());
  }
  renderScheduler.schedule();
}
function applyMotion() {
  const enabled = state.motion && !motionPreference.matches;
  document.body.classList.toggle('motion-off', !enabled);
  $('motion-toggle').setAttribute('aria-pressed', String(enabled));
  text($('motion-toggle'), enabled ? 'Motion on' : 'Motion off');
  $('motion-toggle').title = motionPreference.matches
    ? 'Reduced motion is enabled in system settings'
    : 'Toggle factory animation';
  setSceneMotion(enabled);
  if (!enabled && stopEffectSession) scene?.startle(false);
  const data = snapshot();
  if (data)
    processingEffects.update(data, {
      motion: enabled,
      stopping:
        stopping.has(data.session.id) || pausedActivity.has(data.session.id),
    });
}
async function selectOpenedSession(id) {
  terminalTabs.showPrompt();
  state.desiredSessionId = id;
  if (state.hub.sessions.some(item => item.session.id === id)) {
    selectSession(id);
    state.desiredSessionId = null;
  } else receive(await api.getState());
  $('parent-prompt').focus();
  void recentProjects.refresh();
}
function renderSessionActions() {
  $('open-workspace-config').disabled = !api?.openWorkspaceConfiguration;
  const session = snapshot()?.session;
  const unit = selectedUnit();
  const id = conversationId();
  const parent = state.unitId === 'parent';
  $('open-session-settings').disabled =
    !api?.promptSession ||
    !session ||
    !conversationControllable() ||
    stopping.has(id) ||
    closingSessions.has(id) ||
    closingSessions.has(session.id);
  recentProjects.setBusy(Boolean(creating));
  for (const id of ['new-session', 'welcome-create'])
    $(id).disabled = Boolean(creating);
  const replacementCwd = pendingReplacement?.cwd || session?.cwd;
  $('start-session').hidden = !parent || !replacementCwd;
  $('start-session').disabled =
    Boolean(creating) ||
    closingSessions.size > 0 ||
    !replacementCwd ||
    !api?.closeSession;
  $('start-session').title = replacementCwd
    ? `Reset the conversation in ${replacementCwd}`
    : '';
  text(
    $('start-session'),
    creating === 'session'
      ? 'Creating…'
      : pendingReplacement
        ? 'Retry reset conversation'
        : 'Reset conversation',
  );
  for (const id of ['close-session', 'close-parent-session']) {
    $(id).disabled =
      Boolean(creating) ||
      !session ||
      !(parent ? api?.closeSession : api?.agentSession) ||
      !unit ||
      closingSessions.has(conversationId()) ||
      closingSessions.has(session.id);
    $(id).title = unit
      ? parent
        ? session.owned
          ? `Close workspace ${session.name} and stop its agents`
          : `Close workspace ${session.name} in this window`
        : `Close ${unit.name}`
      : '';
    text(
      $(id),
      closingSessions.has(conversationId())
        ? 'Closing…'
        : parent
          ? 'Close workspace'
          : 'Close agent',
    );
  }
}
async function openFolder(folder) {
  if (creating || !api) return;
  creating = 'folder';
  $('app-error').hidden = true;
  renderSessionActions();
  try {
    const recent = typeof folder === 'string';
    const cwd = recent ? folder : await api.chooseFolder();
    if (!cwd) return;
    text($('new-session'), 'Opening…');
    const existing =
      recent &&
      state.hub.sessions.find(
        item => item.session.cwd === cwd && item.session.status !== 'closed',
      );
    const result = existing
      ? {id: existing.session.id}
      : await api.createSession({cwd});
    pendingReplacement = undefined;
    await selectOpenedSession(result.id);
  } catch (error) {
    showError(error);
  } finally {
    creating = false;
    renderSessionActions();
    text($('new-session'), 'Open folder');
  }
}
async function startSession(submission) {
  const session = submission
    ? state.hub.sessions.find(item => item.session.id === submission.id)
        ?.session
    : snapshot()?.session;
  if (creating || closingSessions.size || !api?.closeSession) return false;
  const retrying =
    pendingReplacement &&
    (!submission || submission.id === pendingReplacement.id);
  const replacement =
    (retrying && pendingReplacement) ||
    (session && {
      id: session.id,
      cwd: session.cwd,
      submission,
    });
  if (!replacement) return false;
  saveDraft();
  saveConversationDisclosures();
  creating = 'session';
  $('app-error').hidden = true;
  renderSessionActions();
  try {
    if (!retrying) {
      closingSessions.add(replacement.id);
      render();
      await api.closeSession(replacement.id);
      pendingReplacement = replacement;
      const version = snapshotVersion;
      const hub = await api.getState();
      if (version === snapshotVersion) receive(hub);
      workspaceCache.delete(replacement.id);
      pausedActivity.delete(replacement.id);
    }
    const result = await api.createSession({cwd: replacement.cwd});
    pendingReplacement = undefined;
    const submitted = replacement.submission;
    if (submitted) clearSubmittedDraft(submitted.id, submitted.draft);
    await selectOpenedSession(result.id);
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    closingSessions.delete(replacement.id);
    creating = false;
    render();
  }
}
async function closeSession() {
  if (state.unitId !== 'parent') {
    const ownerId = state.sessionId;
    const agentId = state.unitId;
    const id = conversationId();
    if (creating || !api?.agentSession || closingSessions.has(id)) return;
    saveDraft();
    saveConversationDisclosures();
    closingSessions.add(id);
    $('app-error').hidden = true;
    render();
    try {
      await api.agentSession(ownerId, {agentId, action: 'close'});
      const version = snapshotVersion;
      const hub = await api.getState();
      if (version === snapshotVersion) receive(hub);
      agentControls.dismiss(ownerId, agentId);
    } catch (error) {
      showError(error);
    } finally {
      closingSessions.delete(id);
      render();
    }
    return;
  }
  const id = state.sessionId;
  if (creating || !id || !api?.closeSession || closingSessions.has(id)) return;
  saveDraft();
  saveConversationDisclosures();
  closingSessions.add(id);
  $('app-error').hidden = true;
  render();
  try {
    await api.closeSession(id);
    const version = snapshotVersion;
    const hub = await api.getState();
    if (version === snapshotVersion) receive(hub);
    workspaceCache.delete(id);
    pausedActivity.delete(id);
    if (!snapshot()) $('app-menu-button').focus();
  } catch (error) {
    showError(error);
  } finally {
    closingSessions.delete(id);
    render();
  }
}
async function sendPrompt(event) {
  event.preventDefault();
  const ownerId = state.sessionId;
  const agentId = state.unitId === 'parent' ? undefined : state.unitId;
  const id = conversationId();
  const textarea = $('parent-prompt');
  const prompt = textarea.value.trim();
  const session = selectedUnit();
  if (
    !api ||
    !session ||
    !conversationPromptable() ||
    sending.has(id) ||
    stopping.has(id) ||
    closingSessions.has(id) ||
    closingSessions.has(ownerId) ||
    !prompt
  )
    return;
  saveDraft();
  const submitted = {...promptDrafts.get(id)};
  const command = parseSlashCommand(prompt);
  const native = command && nativeCommand(command.name);
  let animated = false;
  sending.add(id);
  promptErrors.delete(id);
  $('prompt-error').hidden = true;
  $('app-error').hidden = true;
  renderInspector();
  try {
    if (agentId && command && ['model', 'thinking'].includes(command.name)) {
      if (!command.args) await openAgentSettings(ownerId, agentId);
      else {
        const configuration = {};
        if (command.name === 'thinking')
          configuration.thinkingLevel = command.args;
        else {
          const separator = command.args.indexOf('/');
          if (separator < 1 || separator === command.args.length - 1)
            throw new Error('Usage: /model provider/model');
          configuration.provider = command.args.slice(0, separator);
          configuration.modelId = command.args.slice(separator + 1);
        }
        await api.agentSession(ownerId, {
          agentId,
          action: 'configure',
          configuration,
        });
      }
      clearSubmittedDraft(id, submitted);
      return;
    }
    if (
      agentId &&
      native &&
      !['compact', 'reload', 'approvals'].includes(command.name)
    )
      throw new Error(`/${command.name} is unavailable for this agent.`);
    const routing = !agentId
      ? routeNativeCommand({
          prompt,
          data: state.hub.sessions.find(item => item.session.id === id),
          submission: {id, draft: submitted},
        })
      : undefined;
    if (routing !== undefined) {
      if (await routing) clearSubmittedDraft(id, submitted);
      return;
    }
    if (!agentId && !native && session.status === 'idle') {
      if (stopEffectSession === id) clearStopEffect();
      scene?.prompt(id);
      animated = true;
    }
    if (agentId) {
      if (command?.name === 'compact')
        await api.agentSession(ownerId, {
          agentId,
          action: 'compact',
          instructions: command.args,
        });
      else if (command?.name === 'reload') {
        if (command.args) throw new Error('Usage: /reload');
        await api.agentSession(ownerId, {agentId, action: 'reload'});
      } else if (command?.name === 'approvals')
        await api.agentSession(ownerId, {
          agentId,
          action: 'command',
          command: prompt,
        });
      else await api.agentSession(ownerId, {agentId, action: 'prompt', prompt});
    } else await api.promptSession(id, {prompt});
    if (!native) {
      pausedActivity.delete(id);
      if (stopEffectSession === id) clearStopEffect();
    }
    clearSubmittedDraft(id, submitted);
  } catch (error) {
    if (animated) scene?.cancelPrompt(id);
    promptErrors.set(
      id,
      error instanceof Error ? error.message : String(error),
    );
    if (id === conversationId()) showError(error, $('prompt-error'));
  } finally {
    sending.delete(id);
    renderInspector();
  }
}
async function abortParent() {
  const ownerId = state.sessionId;
  const agentId = state.unitId === 'parent' ? undefined : state.unitId;
  const id = conversationId();
  const data = snapshot();
  const session = selectedUnit();
  if (
    !api ||
    !session ||
    !conversationControllable() ||
    !conversationHasWork(data, session) ||
    stopping.has(id) ||
    closingSessions.has(id) ||
    closingSessions.has(ownerId)
  )
    return;
  stopping.add(id);
  promptErrors.delete(id);
  $('prompt-error').hidden = true;
  if (!agentId) pausedActivity.add(id);
  $('app-error').hidden = true;
  renderFactory();
  renderInspector();
  if (!agentId) stopEffect();
  try {
    const queued = agentId
      ? await api.agentSession(ownerId, {agentId, action: 'abort'})
      : await api.abortSession(id);
    const recovered = [
      ...(queued?.steering || []),
      ...(queued?.followUp || []),
    ];
    if (recovered.length) {
      if (id === conversationId()) saveDraft();
      const draft = promptDrafts.get(id) || {value: '', revision: 0};
      // A submitted draft can still be awaiting its acknowledgement when Stop wins.
      const submitted =
        sending.has(id) && recovered.includes(draft.value.trim());
      const existing = submitted ? '' : draft.value;
      const prefix = recovered.join('\n\n') + (existing ? '\n\n' : '');
      const value = prefix + existing;
      promptDrafts.set(id, {
        ...draft,
        value,
        revision: draft.revision + 1,
        start: existing ? prefix.length + (draft.start || 0) : value.length,
        end: existing ? prefix.length + (draft.end || 0) : value.length,
        direction: draft.direction || 'none',
      });
      persistComposerDraft(id);
      if (id === conversationId()) {
        restoreDraft(id);
        $('parent-prompt').focus();
      }
    }
  } catch (error) {
    if (stopEffectSession === id) clearStopEffect();
    pausedActivity.delete(id);
    promptErrors.set(
      id,
      error instanceof Error ? error.message : String(error),
    );
    if (id === conversationId()) showError(error, $('prompt-error'));
  } finally {
    stopping.delete(id);
    renderFactory();
    renderInspector();
  }
}
async function loadWorkspace() {
  const id = state.sessionId;
  if (!api || !id || workspacePending.has(id)) return;
  workspacePending.add(id);
  $('app-error').hidden = true;
  renderWorkspace();
  try {
    workspaceCache.set(id, {
      result: await api.workspace(id),
      at: new Date().toISOString(),
    });
  } catch (error) {
    showError(error);
  } finally {
    workspacePending.delete(id);
    if (state.sessionId === id) renderWorkspace();
  }
}

$('new-session').addEventListener('click', openFolder);
$('welcome-create').addEventListener('click', openFolder);
$('open-workspace-config').addEventListener('click', async () => {
  const menu = $('app-menu-panel');
  if (menu.matches(':popover-open')) menu.hidePopover();
  try {
    await api.openWorkspaceConfiguration(
      snapshot()?.session.cwd || state.hub.launchCwd,
    );
  } catch (error) {
    showError(error);
  }
});
$('start-session').addEventListener('click', () => void startSession());
$('close-session').addEventListener('click', closeSession);
$('close-parent-session').addEventListener('click', closeSession);
$('inspect-parent').addEventListener('click', () => selectUnit('parent'));
$('back-to-parent').addEventListener('click', () => selectUnit('parent'));
$('prompt-form').addEventListener('submit', event => {
  if (terminalTabs.isSelected()) event.preventDefault();
  else void sendPrompt(event);
});
bindConversationLinks($('conversation'), {
  sessionId: () => state.sessionId,
  openFile: (id, path) => api.openFile(id, path),
  openMarkdown: openMarkdownFile,
  openExternal: url => api.openExternal(url),
  onError: showError,
});
initTextareaResize($('parent-prompt-resize'), $('parent-prompt'));
for (const event of ['input', 'select', 'keyup', 'pointerup', 'scroll', 'blur'])
  $('parent-prompt').addEventListener(event, saveDraft);
document.addEventListener('selectionchange', () => {
  if (document.activeElement === $('parent-prompt')) saveDraft();
});
for (const [id, formId] of [['parent-prompt', 'prompt-form']]) {
  const textarea = $(id);
  textarea.addEventListener('keydown', event =>
    submitFromEditor(event, $(formId)),
  );
  textarea.addEventListener('compositionstart', () =>
    composingEditors.add(textarea),
  );
  textarea.addEventListener('compositionend', () =>
    composingEditors.delete(textarea),
  );
}
$('expand-parent-editor').addEventListener('click', () =>
  expandEditor(
    $('parent-controls'),
    $('parent-prompt'),
    $('expand-parent-editor'),
  ),
);
document.addEventListener('keydown', event => {
  if (event.target.closest?.('#markdown-panel, #terminal-panel')) return;
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    event.isComposing ||
    composingEditors.has(event.target) ||
    event.repeat
  )
    return;
  if (document.querySelector('dialog[open]')) return;
  const data = snapshot();
  if (data && conversationControllable() && conversationHasWork(data)) {
    event.preventDefault();
    void abortParent();
  } else if (expandedEditor) {
    event.preventDefault();
    event.stopPropagation();
    collapseEditor();
  }
});
$('abort-parent').addEventListener('click', abortParent);
$('load-workspace').addEventListener('click', loadWorkspace);
$('history-search').addEventListener('input', event => {
  state.historyQuery = event.target.value.trim().toLocaleLowerCase();
  renderWorkers();
});
$('motion-toggle').addEventListener('click', () => {
  state.motion = !state.motion;
  try {
    localStorage.setItem('varisdev-factory-motion', String(state.motion));
  } catch {
    /* Storage may be disabled. */
  }
  applyMotion();
});
for (const tab of TABS) {
  $(`tab-${tab}`).addEventListener('click', () => setTab(tab));
  $(`tab-${tab}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = TABS.filter(name => !$(`tab-${name}`).hidden);
    const index = tabs.indexOf(tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) %
            tabs.length;
    setTab(tabs[next]);
    $(`tab-${tabs[next]}`).focus();
  });
}
$('panel-conversation').addEventListener(
  'wheel',
  event => {
    if (event.deltaY < 0) {
      cancelConversationBottom();
      conversationFollowing = false;
    }
  },
  {passive: true},
);
$('panel-conversation').addEventListener('pointerdown', () => {
  conversationPointerActive = true;
  cancelConversationBottom();
});
document.addEventListener('pointerup', () => {
  if (!conversationPointerActive) return;
  conversationPointerActive = false;
  scheduleConversationBottom();
});
document.addEventListener('pointercancel', () => {
  if (!conversationPointerActive) return;
  conversationPointerActive = false;
  conversationFollowing = false;
});
$('panel-conversation').addEventListener('keydown', event => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
    cancelConversationBottom();
    conversationFollowing = false;
  }
});
$('panel-conversation').addEventListener('scroll', () => {
  // Replacing a conversation can emit a scroll event before its scheduled paint.
  if (conversationScrollFrame !== undefined) return;
  const body = $('panel-conversation');
  conversationFollowing =
    body.scrollHeight - body.clientHeight - body.scrollTop < 70;
  if (!conversationFollowing) cancelConversationBottom();
});
$('follow-conversation').addEventListener('change', () => {
  conversationFollowing = $('follow-conversation').checked;
  if (conversationFollowing) scheduleConversationBottom();
});
const conversationResize = new window.ResizeObserver(() => {
  if (conversationFollowing) scheduleConversationBottom();
});
for (const id of [
  'conversation',
  'conversation-activity',
  'panel-conversation',
])
  conversationResize.observe($(id));
$('follow-feed').addEventListener('change', () => {
  if ($('follow-feed').checked)
    $('panel-feed').scrollTop = $('panel-feed').scrollHeight;
});
motionPreference.addEventListener('change', applyMotion);
window.addEventListener('resize', resizeFactory);
document.addEventListener(
  'visibilitychange',
  renderScheduler.visibilityChanged,
);
const workspaceResize = new window.ResizeObserver(sizeInspector);
workspaceResize.observe($('factory-workspace'));
const sceneResize = new window.ResizeObserver(sizeScene);
sceneResize.observe($('scene'));
try {
  state.motion = localStorage.getItem('varisdev-factory-motion') !== 'false';
} catch {
  /* Use the default motion setting. */
}
let initialSceneError = '';
let reportSceneError = message => {
  initialSceneError = message;
};
const scene = createThemeScene($('factory-canvas'), {
  fallbackContainer: $('fallback-units'),
  agentsForBuiltin: sceneAgents,
  onSelect: selectUnit,
  onLayout: layoutLabels,
  onAvailability(available) {
    $('fallback').hidden = available;
    $('scene-labels').hidden = !available;
    for (const entry of labelNodes.values()) entry.element.remove();
    labelNodes.clear();
    lastLayout = [];
    sizeScene();
    renderScheduler.schedule();
  },
  onError: message => reportSceneError(message),
});
const factoryToyOptions = {
  holsterContainer: $('application-controls'),
  getTargets: () => scene.caneTargets(),
  getEnvironmentTargets: () => scene.environmentTargets(),
  onEnvironmentHit: (id, weapon, amount) =>
    scene.hitEnvironment(id, weapon, amount),
  onHit: (id, direction, strength) =>
    scene.hitWithCane(id, direction, strength),
};
const factoryGun = createFactoryGun($('scene'), {
  ...factoryToyOptions,
  onEquip: () => {
    factoryCane.stow();
    factoryFlamethrower.stow();
  },
});
const factoryCane = createFactoryCane($('scene'), {
  ...factoryToyOptions,
  onEquip: () => {
    factoryGun.stow();
    factoryFlamethrower.stow();
  },
});
const factoryFlamethrower = createFactoryFlamethrower($('scene'), {
  ...factoryToyOptions,
  onBurn: (id, seconds) => scene.burnRobot(id, seconds),
  onEquip: () => {
    factoryGun.stow();
    factoryCane.stow();
  },
});
const cleanupThemes = initThemes(
  (palette, entry) => {
    factoryFlamethrower.stow();
    void scene.setTheme(entry, palette);
  },
  {deferDiscovery: true},
);
reportSceneError = cleanupThemes.reportSceneError;
if (initialSceneError) reportSceneError(initialSceneError);
const cleanupZoom = initZoom(api);
const cleanupAccounts = initAccounts(api);
const cleanupEnvironment = initEnvironment(api);
const routeNativeCommand = createNativeCommandRouter({
  api,
  newSession: startSession,
  hotkeys: () => {
    if (!$('hotkeys-dialog').open) $('hotkeys-dialog').showModal();
  },
});
$('hotkeys-close').addEventListener('click', () => $('hotkeys-dialog').close());
const receiveNavigation = createNavigationReceiver({
  api,
  async opened(id, draft) {
    // Save the currently displayed editor before selecting or seeding another one.
    saveDraft();
    if (draft) {
      const existing = promptDrafts.get(id);
      const value = existing?.value ? `${existing.value}\n\n${draft}` : draft;
      promptDrafts.set(id, {
        ...existing,
        value,
        revision: (existing?.revision || 0) + 1,
        start: value.length,
        end: value.length,
        direction: 'none',
        scrollTop: 0,
        scrollLeft: 0,
        height: existing?.height || '',
      });
      persistComposerDraft(id);
      if (state.sessionId === id && state.unitId === 'parent') restoreDraft(id);
    }
    await selectOpenedSession(id);
  },
  failed(cause, retry) {
    showError(cause);
    const button = node(
      'button',
      'quiet-button',
      'Retry opening prepared conversation',
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      button.remove();
      void retry();
    });
    $('native-navigation-actions').append(button);
  },
});
const toolSettings = initToolSettings({
  api,
  selectedSessionId: () => state.sessionId,
});
const cleanupUpdates = initUpdates(api, {
  beforeRestart() {
    saveDraft();
    flushDrafts();
  },
  selectedSessionId: () => state.sessionId,
});
const agentControls = initAgentControls({
  api,
  selected: snapshot,
  selectedAgent: () => state.unitId,
  removed: () => {
    receive(state.hub);
    render();
  },
  refresh: () => {
    renderFactory();
    renderInspector();
  },
});
async function openAgentSettings(ownerId, agentId) {
  const data = state.hub.sessions.find(item => item.session.id === ownerId);
  const agent = data?.agents.find(item => item.id === agentId);
  if (!agent || !agentResumable(agent)) return;
  await api.agentSession(ownerId, {
    agentId,
    action: 'command',
    command: '/model',
  });
}
$('open-session-settings').addEventListener('click', async () => {
  const unit = selectedUnit();
  const id = conversationId();
  if (
    !unit ||
    !conversationControllable() ||
    stopping.has(id) ||
    closingSessions.has(id) ||
    closingSessions.has(state.sessionId)
  )
    return;
  $('app-error').hidden = true;
  try {
    if (state.unitId !== 'parent')
      await openAgentSettings(state.sessionId, state.unitId);
    else await api.promptSession(state.sessionId, {prompt: '/model'});
  } catch (error) {
    showError(error);
  }
});
const appMenu = initAppMenu();
const liveView = initLiveView();
const cleanupPanelResize = initPanelResize();
const cleanupComposerResize = initComposerResize({resizeTextarea});
const recentProjects = initRecentProjects({api, open: openFolder});
const agentTemplates = initAgentTemplates({
  api,
  selected: () => snapshot(),
  launchCwd: () => state.hub.launchCwd,
  opened: selectOpenedSession,
});
const cleanupSessionHistory = initSessionHistory({
  api,
  currentFolder: () => snapshot()?.session.cwd || state.hub.launchCwd,
  opened: selectOpenedSession,
});
const cleanupSessionSelection = api?.onSelectSession?.(id => {
  state.desiredSessionId = id;
  api.getState().then(receive).catch(showError);
});
$('fallback').hidden = scene.hasCanvas();
$('factory-canvas').hidden = !scene.hasCanvas();
$('scene-labels').hidden = !scene.hasCanvas();
applyMotion();
initMarkdownFiles({api, selected: snapshot});
initSessionFeatures({
  api: conversationApi,
  selected: conversationSnapshot,
  draftChanged: saveDraft,
});
initUsage(call => {
  const unitId = $('usage-unit').value;
  const snapshotData = snapshot();
  const messages =
    unitId === 'parent'
      ? snapshotData?.conversation
      : snapshotData?.agents.find(item => item.id === unitId)?.conversation;
  const message =
    messages?.find(item => item.id === call.id) ||
    messages?.find(item => item.at === call.at && item.role !== 'user');
  if (message) selectUnit(unitId);
  const entry =
    message && conversationNodes.get(`${conversationScope()}:${message.id}`);
  if (!entry) {
    showError('No conversation message is available for this call.');
    return;
  }
  setTab('conversation');
  $('follow-conversation').checked = false;
  const body = $('panel-conversation');
  body.scrollTop +=
    entry.element.getBoundingClientRect().top -
    body.getBoundingClientRect().top -
    12;
  saveConversationDisclosures();
});
render();
window.addEventListener('unload', () => {
  saveDraft();
  promptDraftStore.flush();
  state.disposed = true;
  unsubscribe?.();
  renderScheduler.dispose();
  document.removeEventListener(
    'visibilitychange',
    renderScheduler.visibilityChanged,
  );
  clearInterval(clock);
  clearStopEffect();
  motionPreference.removeEventListener('change', applyMotion);
  window.removeEventListener('resize', resizeFactory);
  sceneResize.disconnect();
  workspaceResize.disconnect();
  conversationResize.disconnect();
  conversationVisualizations.dispose();
  terminalTabs.dispose();
  window.cancelAnimationFrame(conversationScrollFrame);
  cleanupThemes();
  cleanupZoom();
  cleanupUpdates();
  cleanupAccounts();
  cleanupEnvironment();
  toolSettings.dispose();
  appMenu.dispose();
  liveView.dispose();
  cleanupPanelResize();
  cleanupComposerResize();
  recentProjects.dispose();
  agentTemplates.dispose();
  cleanupSessionHistory();
  cleanupSessionSelection?.();
  factoryCane.dispose();
  factoryGun.dispose();
  factoryFlamethrower.dispose();
  scene?.dispose();
  processingEffects.dispose();
});
if (api) {
  unsubscribe = api.onSnapshot(receive);
  const initialVersion = snapshotVersion;
  api
    .getState()
    .then(hub => {
      if (snapshotVersion === initialVersion) receive(hub);
    })
    .catch(error => showError(error));
  clock = setInterval(() => {
    if (document.hidden || state.disposed) return;
    for (const [id, entry] of workerNodes) {
      const agent = snapshot()?.agents.find(item => item.id === id);
      if (agent) text(entry.time, duration(agent));
    }
    for (const message of conversationData()?.conversation || []) {
      if (message.role !== 'tool' || message.status !== 'running') continue;
      const entry = conversationNodes.get(
        `${conversationScope()}:${message.id}`,
      );
      if (entry) text(entry.time, duration({startedAt: message.at}));
    }
    const unit = selectedUnit();
    if (unit) {
      const facts = $('unit-facts');
      const elapsed = [...facts.children].find(
        item => item.tagName === 'DT' && item.textContent === 'Elapsed',
      );
      if (elapsed?.nextElementSibling)
        text(elapsed.nextElementSibling, duration(unit));
    }
  }, 1000);
} else {
  $('new-session').disabled = true;
  $('welcome-create').disabled = true;
  showError(
    'Open the VarisDev desktop app. The native desktop API is unavailable.',
  );
}
