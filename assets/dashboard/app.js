/* global document, window, localStorage, setInterval, clearInterval, setTimeout, clearTimeout */
import {createFactoryScene} from './factory-scene.js';
import {createParentFallback} from './parent-fallback.js';
import {initThemes} from './themes.js';
import {initZoom} from './zoom.js';
import {initUsage, renderUsage} from './usage.js';
import {
  initSessionFeatures,
  renderSessionFeatures,
} from './session-features.js';

const $ = id => document.getElementById(id);
const LIVE = new Set(['queued', 'running', 'cancelling']);
const WORKING = new Set(['running', 'cancelling']);
const TABS = ['conversation', 'details', 'feed', 'changes', 'tokens'];
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
  // Actions start expanded when no saved preference is available.
}
const conversationPositions = new Map();
const promptDrafts = new Map();
const workspaceCache = new Map();
const workspacePending = new Set();
const sending = new Set();
const stopping = new Set();
const pausedActivity = new Set();
let stopEffectTimer;
let stopEffectSession;
let scene;
let fallbackScene;
let sceneMotion;
let unsubscribe;
let clock;
let inspectorKey = '';
let feedKey = '';
let lastFeedId;
let changeKey = '';
let conversationKey = '';
let lastLayout = [];
let workspaceRendered = '';
let creating = false;
let expandedEditor = null;
let pendingDraftPosition = null;
const composingEditors = new Set();
let snapshotVersion = 0;
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

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
function robot(agent = false) {
  const item = node('span', `robot-glyph${agent ? ' agent' : ''}`);
  item.setAttribute('aria-hidden', 'true');
  item.append(node('i'));
  return item;
}
function statusName(status) {
  return STATUS[status] || 'Unknown';
}
function badge(item, status) {
  item.className = `status-badge ${Object.hasOwn(STATUS, status) ? status : ''}`;
  text(item, statusName(status));
}
function canControl(session) {
  return session.controllable ?? session.owned;
}
function parentHasWork(data) {
  return (
    ['running', 'compacting'].includes(data.session.status) ||
    data.agents.some(agent => LIVE.has(agent.status))
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
function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
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
function saveDraft() {
  if (!state.sessionId) return;
  const textarea = $('parent-prompt');
  const previous = promptDrafts.get(state.sessionId);
  const revision =
    (previous?.revision || 0) + Number(previous?.value !== textarea.value);
  promptDrafts.set(state.sessionId, {
    value: textarea.value,
    revision,
    ...editorPosition(textarea),
  });
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
  textarea.style.height = draft.height;
  $('prompt-error').hidden = true;
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
  if (id === state.sessionId && $('parent-prompt').value !== submitted.value)
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
  if (id === state.sessionId) restoreDraft(id);
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
  const style = window.getComputedStyle(textarea);
  const min = Number.parseFloat(style.minHeight) || 0;
  const max = Number.parseFloat(style.maxHeight) || window.innerHeight;
  const next = Math.min(Math.max(height, min), max);
  textarea.style.height = `${Math.round(next)}px`;
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

function selectSession(id) {
  if (
    state.sessionId === id ||
    !state.hub.sessions.some(item => item.session.id === id)
  )
    return;
  saveDraft();
  saveConversationPosition();
  state.sessionId = id;
  state.unitId = 'parent';
  state.historyQuery = '';
  $('history-search').value = '';
  restoreDraft(id);
  setTab('conversation');
  render();
}
function selectUnit(id) {
  if (id !== 'parent' && !snapshot()?.agents.some(item => item.id === id))
    return;
  if (state.unitId !== id) setTab(id === 'parent' ? 'conversation' : 'details');
  state.unitId = id;
  renderFactory();
  renderWorkers();
  renderInspector();
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
  const parents = [...state.hub.sessions].sort((a, b) => {
    const active = item =>
      ['running', 'compacting'].includes(item.session.status) ||
      item.agents.some(agent => LIVE.has(agent.status));
    return (
      Number(active(b)) - Number(active(a)) ||
      String(b.session.startedAt).localeCompare(String(a.session.startedAt))
    );
  });
  reconcile(
    $('parents'),
    parentNodes,
    parents,
    item => item.session.id,
    createParentCard,
    (entry, data) => {
      const session = data.session;
      const tally = counts(data);
      entry.element.classList.toggle(
        'selected',
        session.id === state.sessionId,
      );
      entry.element.setAttribute(
        'aria-pressed',
        String(session.id === state.sessionId),
      );
      text(entry.name, session.name);
      parentBadge(entry.status, session);
      const needsInput = !!data.ui?.dialogs?.length;
      entry.element.classList.toggle(
        'attention',
        parentHasError(session) || needsInput,
      );
      text(entry.path, session.cwd);
      text(
        entry.activity,
        needsInput
          ? `Needs input: ${data.ui.dialogs[0].title}`
          : parentHasError(session)
            ? session.error
            : session.activity || 'Waiting for a task',
      );
      entry.element.title = `${session.name}\n${session.cwd}\n${session.activity || ''}\n${tally.working} working · ${tally.queued} queued · ${data.totalAgents} agents${session.error ? `\n${session.error}` : ''}`;
    },
  );
  const workingParents = parents.filter(item =>
    ['running', 'compacting'].includes(item.session.status),
  ).length;
  const workingAgents = parents.reduce(
    (sum, item) => sum + counts(item).working,
    0,
  );
  text(
    $('hub-counts'),
    parents.length
      ? `${parents.length} parent sessions (${workingParents} working) · ${workingAgents} working agents`
      : 'No parent sessions yet',
  );
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
  const data = snapshot();
  if (!data || !scene) return;
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

    text(entry.name, unit.name);
    entry.element.classList.toggle('selected', state.unitId === anchor.id);
    entry.element.setAttribute(
      'aria-pressed',
      String(state.unitId === anchor.id),
    );
    entry.element.title = `${unit.name}\n${anchor.id === 'parent' ? unit.prompt || '' : unit.task}\n${unit.activity || ''}`;
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
      const status = node('span');
      const name = node('strong');
      const task = node('p');
      const activity = node('p', 'muted');
      element.append(robot(unit.id !== 'parent'), status, name, task, activity);
      element.addEventListener('click', () => selectUnit(unit.id));
      return {element, status, name, task, activity};
    },
    (entry, unit) => {
      const parent = unit.id === 'parent';
      const task = parent ? unit.prompt || 'Parent session prompt' : unit.task;
      const activity = unit.activity || statusName(unit.status);
      entry.element.className = `fallback-station ${parent ? 'parent-session' : 'agent'} ${Object.hasOwn(STATUS, unit.status) ? unit.status : ''}`;
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === unit.id),
      );
      entry.element.title = `${unit.name}\n${task}\n${activity}`;
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
  element.style.maxHeight = `${Math.round(available)}px`;
  element.style.setProperty('--inspector-space', `${Math.round(available)}px`);
}
function sizeScene() {
  const element = $('scene');
  element.classList.toggle('compact-scene', element.clientHeight < 360);
}
function resizeFactory() {
  sizeScene();
  sizeInspector();
  if (scene) layoutLabels(lastLayout);
}
function setSceneMotion(enabled) {
  const animation = scene || fallbackScene;
  if (!animation || sceneMotion === enabled) return;
  sceneMotion = enabled;
  animation.setMotion(enabled);
}
function activityPhase(data) {
  if (stopping.has(data.session.id) || pausedActivity.has(data.session.id))
    return 'Stopping';
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
  setSceneMotion(
    state.motion &&
      !motionPreference.matches &&
      phase !== 'Stopping' &&
      stopEffectSession !== data.session.id,
  );
}
function clearStopEffect() {
  clearTimeout(stopEffectTimer);
  const session = stopEffectSession;
  stopEffectSession = undefined;
  $('scene').classList.remove('is-startled');
  (scene || fallbackScene)?.clearStartle();
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
  (scene || fallbackScene)?.startle(state.motion && !motionPreference.matches);
  stopEffectTimer = setTimeout(clearStopEffect, 1100);
}
function renderFactory() {
  const data = snapshot();
  if (!data) return;
  const session = data.session;
  if (stopEffectSession && stopEffectSession !== session.id) clearStopEffect();
  const tally = counts(data);
  text($('factory-title'), session.name);
  $('factory-title').title = session.name;
  text($('factory-path'), session.cwd);
  $('factory-path').title = session.cwd;
  text($('factory-model'), session.model);
  $('factory-model').title = session.model;
  text($('factory-effort'), `Effort: ${session.thinkingLevel ?? ''}`);
  $('factory-effort').hidden = !session.thinkingLevel;
  parentBadge($('parent-status'), session);
  for (const [key, value] of Object.entries(tally)) {
    const item = $(
      `metric-${key === 'failed' ? 'attention' : key === 'working' ? 'running' : key}`,
    );
    if (item) text(item, value);
  }
  const context = session.context;
  text(
    $('context-meter'),
    context
      ? `Context ${context.percent === null ? '—' : `${Math.round(context.percent)}%`} · ${context.tokens === null ? '—' : context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens`
      : '',
  );
  $('context-meter').hidden = !context;
  text($('parent-activity'), session.activity || 'Waiting for a task');
  $('parent-activity').title = $('parent-activity').textContent;
  sizeScene();
  renderProcessing(data);
  if (scene) {
    scene.update({...data, agents: sceneAgents(data)}, state.unitId);
    layoutLabels(lastLayout);
  } else {
    renderFallback(data);
    fallbackScene?.update(data, state.unitId);
  }
}
function createWorkerCard(agent) {
  const element = node('button', 'worker-card');
  element.type = 'button';
  const header = node('span', 'worker-card-header');
  const name = node('span', 'worker-card-name');
  const status = node('span');
  header.append(robot(true), name, status);
  const task = node('span', 'worker-card-task');
  const activity = node('span', 'worker-card-activity');
  const meta = node('span', 'worker-card-meta');
  const model = node('span');
  const time = node('span');
  meta.append(model, time);
  element.append(header, task, activity, meta);
  element.addEventListener('click', () => selectUnit(agent.id));
  return {element, name, status, task, activity, model, time};
}
function createHistoryRow(agent) {
  const element = node('button', 'history-row');
  element.type = 'button';
  const info = node('span', 'history-row-info');
  const name = node('span', 'history-row-name');
  const task = node('span', 'history-row-task');
  const status = node('span');
  info.append(name, task);
  element.append(info, status);
  element.addEventListener('click', () => selectUnit(agent.id));
  return {element, name, task, status};
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
      entry.element.classList.toggle('selected', state.unitId === agent.id);
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === agent.id),
      );
      text(entry.name, agent.name);
      badge(entry.status, agent.status);
      text(entry.task, agent.task);
      text(entry.activity, agent.activity || 'Waiting for activity');
      text(entry.model, agent.model);
      text(entry.time, duration(agent));
      entry.element.title = `${agent.name}\n${agent.task}\n${agent.activity || ''}\n${agent.model}`;
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
      entry.element.classList.toggle('selected', state.unitId === agent.id);
      entry.element.setAttribute(
        'aria-pressed',
        String(state.unitId === agent.id),
      );
      text(entry.name, agent.name);
      text(entry.task, agent.task);
      badge(entry.status, agent.status);
      entry.element.title = `${agent.name}\n${agent.task}`;
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
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
}
function findEventTool(event, data) {
  if (event.conversationId)
    return data.conversation?.find(item => item.id === event.conversationId);
  return undefined;
}
function renderFeedDetails(entry, event, data) {
  const tool = findEventTool(event, data);
  const worker = data.agents.find(item => item.id === event.sourceId);
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
          Input: tool.input,
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
  const values = Object.entries(fields)
    .map(([label, value]) => [label, detailValue(value)])
    .filter(([, value]) => value !== undefined);
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
      if (label === 'Diff') {
        if (field.previous !== value) renderDiff(field.content, value);
        field.previous = value;
      } else updateStreamText(field.textNode, value, selection);
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
      const kind = node('span');
      const at = node('time');
      const message = node('span', 'feed-event-message');
      const content = node('dl', 'feed-details');
      meta.append(kind, at);
      summary.append(meta, message);
      details.append(summary, content);
      element.append(details);
      return {element, kind, at, message, content, fields: new Map()};
    },
    (entry, event) => {
      entry.element.classList.toggle('error', event.kind === 'error');
      const [kind, label] =
        event.kind === 'tool'
          ? toolAction(
              event.details?.Tool ||
                data.conversation?.find(
                  item => item.id === event.conversationId,
                )?.toolName,
            )
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
      renderFeedDetails(entry, event, data);
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
      summary.append(path, meta);
      element.append(summary, description, diff);
      return {element, path, meta, description, diff, previousDiff: null};
    },
    (entry, change) => {
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
function saveConversationPosition() {
  if (!state.sessionId || conversationKey !== state.sessionId) return;
  conversationPositions.set(state.sessionId, {
    top: $('panel-conversation').scrollTop,
    follow: $('follow-conversation').checked,
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
  details.open = disclosures.get(key) ?? true;
  details.addEventListener('toggle', () => {
    if (!details.isConnected || disclosures.get(key) === details.open) return;
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
  if (name === 'bash') return ['command', 'Command'];
  if (['write', 'edit'].includes(name)) return ['edit', 'File change'];
  if (name === 'read') return ['read', 'Read file'];
  if (name.startsWith('agent_')) return ['agent', 'Agent'];
  if (['browse', 'download'].includes(name)) return ['web', 'Web'];
  if (['openai_image', 'elevenlabs', 'image_preview'].includes(name))
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
  const truncated = node(
    'p',
    'muted conversation-preview',
    'Preview truncated; full text is in the session file.',
  );
  const error = node('p', 'conversation-error');
  let inputNode;
  let inputPreview;
  let outputLabel;
  if (tool) {
    const details = node('details');
    const key = `${state.sessionId}:${message.id}`;
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
      truncated,
      error,
    );
    details.append(summary, body);
    element.append(details);
  } else {
    element.append(header, content, truncated, error);
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
    truncated,
    error,
    status: undefined,
  };
}
function renderConversation(data) {
  const body = $('panel-conversation');
  const sessionChanged = conversationKey !== state.sessionId;
  if (sessionChanged) {
    conversationNodes.clear();
    $('conversation').replaceChildren();
    conversationKey = state.sessionId;
    const saved = conversationPositions.get(state.sessionId);
    $('follow-conversation').checked = saved?.follow ?? true;
    body.scrollTop = saved?.top || 0;
  }
  const nearBottom =
    body.scrollHeight - body.scrollTop - body.clientHeight < 70;
  const selection = window.getSelection();
  const selectedText =
    selection &&
    !selection.isCollapsed &&
    $('conversation').contains(selection.anchorNode);
  const messages = data.conversation || [];
  let changed = sessionChanged || messages.length !== conversationNodes.size;
  text($('conversation-recipient'), `Conversation with ${data.session.name}`);
  $('conversation-truncated').hidden = !data.conversationTruncated;
  $('conversation-session-file').hidden =
    !data.conversationTruncated || !data.session.sessionFile;
  text($('conversation-session-file'), data.session.sessionFile);
  reconcile(
    $('conversation'),
    conversationNodes,
    messages,
    item => item.id,
    conversationEntry,
    (entry, message) => {
      const tool = message.role === 'tool';
      entry.element.classList.toggle('user', message.role === 'user');
      text(
        entry.role,
        tool ? message.toolName : message.role === 'user' ? 'You' : 'Assistant',
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
        text(
          entry.inputPreview,
          (message.input || '').split('\n')[0] || 'No input',
        );
        changed =
          updateStreamText(entry.inputNode, message.input, selection) ||
          changed;
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
      const outputNearBottom =
        entry.content.scrollHeight -
          entry.content.scrollTop -
          entry.content.clientHeight <
        40;
      const outputChanged = updateStreamText(
        entry.textNode,
        message.text,
        selection,
      );
      changed = outputChanged || changed;
      if (tool && outputChanged && outputNearBottom && !selectedText)
        entry.content.scrollTop = entry.content.scrollHeight;
      entry.truncated.hidden = !message.truncated;
      entry.error.hidden =
        !message.error || (tool && message.error === message.text);
      text(entry.error, message.error);
    },
  );
  const active = ['running', 'compacting'].includes(data.session.status);
  const phase = activityPhase(data);
  const activity = $('conversation-activity');
  const activityText = $('conversation-activity-text');
  changed =
    changed ||
    activity.hidden === active ||
    activityText.textContent !== data.session.activity;
  activity.hidden = !active;
  activity.classList.toggle(
    'paused',
    phase === 'Stopping' || phase === 'Needs input',
  );
  text(
    activityText,
    phase === 'Stopping' ? 'Stopping…' : data.session.activity || 'Working',
  );
  $('conversation-empty').hidden = messages.length > 0 || active;
  if (
    state.tab === 'conversation' &&
    $('follow-conversation').checked &&
    !selectedText &&
    (nearBottom || sessionChanged) &&
    changed
  )
    body.scrollTop = body.scrollHeight;
  if (sessionChanged) {
    const saved = conversationPositions.get(state.sessionId);
    if (saved) body.scrollTop = saved.top;
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
  const data = snapshot();
  const unit = selectedUnit();
  if (!data || !unit) return;
  const parent = state.unitId === 'parent';
  const key = `${state.sessionId}:${state.unitId}`;
  if (inspectorKey !== key) {
    for (const tab of ['details', 'feed', 'changes', 'tokens'])
      $(`panel-${tab}`).scrollTop = 0;
    inspectorKey = key;
  }
  text($('inspector-title'), unit.name);
  if (parent) parentBadge($('inspector-status'), unit);
  else badge($('inspector-status'), unit.status);
  text($('inspector-activity'), unit.activity || 'No current activity');
  facts($('unit-facts'), [
    [
      'Status',
      parent && parentHasError(unit) ? 'Error' : statusName(unit.status),
    ],
    ['Model', unit.model],
    ...(parent ? [['Effort', unit.thinkingLevel]] : []),
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
                ? 'Desktop parent session'
                : 'Connected pidev'
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
  renderFeed(data);
  renderChanges(data);
  renderConversation(data);
  renderSteering(data);
  renderUsage(data);
  renderSessionFeatures(data);
  if (
    !canControl(data.session) &&
    expandedEditor?.textarea === $('parent-prompt')
  )
    collapseEditor(false);
  $('parent-controls').hidden = !canControl(data.session);
  $('inspector').classList.toggle('has-composer', canControl(data.session));
  text($('prompt-recipient'), data.session.name);
  $('attached-note').hidden = data.session.owned;
  text(
    $('attached-note'),
    canControl(data.session)
      ? 'Connected pidev · this conversation is controlled here.'
      : 'Disconnected pidev · controls are unavailable.',
  );
  if (
    pendingDraftPosition?.id === state.sessionId &&
    canControl(data.session)
  ) {
    restorePosition($('parent-prompt'), pendingDraftPosition.position);
    pendingDraftPosition = null;
  }
  $('abort-parent').disabled =
    !canControl(data.session) ||
    !parentHasWork(data) ||
    stopping.has(state.sessionId);
  text(
    $('abort-parent'),
    stopping.has(state.sessionId) ? 'Stopping…' : 'Stop · Esc',
  );
  $('send-prompt').disabled =
    sending.has(state.sessionId) ||
    stopping.has(state.sessionId) ||
    data.session.status === 'closed';
  const steering = data.session.status === 'running';
  text($('prompt-action'), steering ? 'Steer' : 'Message');
  text(
    $('send-prompt'),
    sending.has(state.sessionId) ? 'Sending…' : steering ? 'Steer' : 'Send',
  );
  $('send-prompt').title = steering
    ? 'Steer this session at its next model turn'
    : 'Send a message';
  $('parent-prompt').placeholder = steering
    ? 'Guide the current task…'
    : 'Describe the next task…';
  renderWorkspace();
  sizeInspector();
}
function renderWorkspace() {
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
      : `No Git repository in ${result.cwd}. Robot edits are in Changes.`,
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
  state.tab = tab;
  for (const name of TABS) {
    const selected = name === tab;
    $(`tab-${name}`).setAttribute('aria-selected', String(selected));
    $(`tab-${name}`).tabIndex = selected ? 0 : -1;
    $(`panel-${name}`).hidden = !selected;
  }
  if (tab === 'conversation' && $('follow-conversation').checked)
    $('panel-conversation').scrollTop = $('panel-conversation').scrollHeight;
  if (tab === 'feed' && $('follow-feed').checked)
    $('panel-feed').scrollTop = $('panel-feed').scrollHeight;
}
function render() {
  if (state.disposed) return;
  const hasSession = Boolean(snapshot());
  $('welcome').hidden = hasSession;
  $('factory-workspace').hidden = !hasSession;
  renderOverview();
  if (hasSession) {
    renderFactory();
    renderWorkers();
    renderInspector();
  }
}
function receive(hub) {
  if (state.disposed) return;
  snapshotVersion++;
  state.hub = hub;
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
    saveDraft();
    saveConversationPosition();
    state.sessionId = next;
    state.unitId = 'parent';
    restoreDraft(next);
    setTab('conversation');
  }
  if (next === state.desiredSessionId) state.desiredSessionId = null;
  if (
    state.unitId !== 'parent' &&
    !snapshot()?.agents.some(item => item.id === state.unitId)
  )
    state.unitId = 'parent';
  text($('connection'), 'Desktop connected');
  render();
}
function applyMotion() {
  const enabled = state.motion && !motionPreference.matches;
  document.body.classList.toggle('motion-off', !enabled);
  $('motion-toggle').setAttribute('aria-pressed', String(enabled));
  text($('motion-toggle'), enabled ? 'Motion on' : 'Motion off');
  $('motion-toggle').title = motionPreference.matches
    ? 'Reduced motion is enabled in system settings'
    : 'Toggle factory animation';
  setSceneMotion(
    enabled &&
      !pausedActivity.has(state.sessionId) &&
      stopEffectSession !== state.sessionId,
  );
  if (!enabled && stopEffectSession) (scene || fallbackScene)?.startle(false);
}
async function openFolder() {
  if (creating || !api) return;
  creating = true;
  $('app-error').hidden = true;
  for (const id of ['new-session', 'welcome-create']) $(id).disabled = true;
  try {
    const cwd = await api.chooseFolder();
    if (!cwd) return;
    text($('new-session'), 'Opening…');
    const result = await api.createSession({cwd});
    state.desiredSessionId = result.id;
    if (state.hub.sessions.some(item => item.session.id === result.id)) {
      selectSession(result.id);
      state.desiredSessionId = null;
    } else receive(await api.getState());
    $('parent-prompt').focus();
  } catch (error) {
    showError(error);
  } finally {
    creating = false;
    for (const id of ['new-session', 'welcome-create']) $(id).disabled = false;
    text($('new-session'), 'Open folder');
  }
}
async function sendPrompt(event) {
  event.preventDefault();
  const id = state.sessionId;
  const textarea = $('parent-prompt');
  const prompt = textarea.value.trim();
  const session = snapshot()?.session;
  if (
    !api ||
    !session ||
    !canControl(session) ||
    session.status === 'closed' ||
    sending.has(id) ||
    stopping.has(id) ||
    !prompt
  )
    return;
  saveDraft();
  const submitted = {...promptDrafts.get(id)};
  sending.add(id);
  $('prompt-error').hidden = true;
  $('app-error').hidden = true;
  renderInspector();
  if (session.status === 'idle') {
    if (stopEffectSession === id) clearStopEffect();
    (scene || fallbackScene)?.prompt(id);
  }
  try {
    await api.promptSession(id, {prompt});
    pausedActivity.delete(id);
    if (stopEffectSession === id) clearStopEffect();
    clearSubmittedDraft(id, submitted);
  } catch (error) {
    (scene || fallbackScene)?.cancelPrompt(id);
    if (id === state.sessionId) showError(error, $('prompt-error'));
    else showError(error);
  } finally {
    sending.delete(id);
    renderInspector();
  }
}
async function abortParent() {
  const id = state.sessionId;
  const data = snapshot();
  const session = data?.session;
  if (
    !api ||
    !session ||
    !canControl(session) ||
    !parentHasWork(data) ||
    stopping.has(id)
  )
    return;
  stopping.add(id);
  pausedActivity.add(id);
  $('app-error').hidden = true;
  renderFactory();
  renderInspector();
  stopEffect();
  try {
    await api.abortSession(id);
  } catch (error) {
    if (stopEffectSession === id) clearStopEffect();
    pausedActivity.delete(id);
    showError(error);
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
$('inspect-parent').addEventListener('click', () => selectUnit('parent'));
$('prompt-form').addEventListener('submit', sendPrompt);
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
  if (data && canControl(data.session) && parentHasWork(data)) {
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
for (const [index, tab] of TABS.entries()) {
  $(`tab-${tab}`).addEventListener('click', () => setTab(tab));
  $(`tab-${tab}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = TABS;
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
$('panel-conversation').addEventListener('scroll', saveConversationPosition);
$('follow-conversation').addEventListener('change', () => {
  if ($('follow-conversation').checked)
    $('panel-conversation').scrollTop = $('panel-conversation').scrollHeight;
  saveConversationPosition();
});
$('follow-feed').addEventListener('change', () => {
  if ($('follow-feed').checked)
    $('panel-feed').scrollTop = $('panel-feed').scrollHeight;
});
motionPreference.addEventListener('change', applyMotion);
window.addEventListener('resize', resizeFactory);
const sceneResize = new window.ResizeObserver(sizeScene);
sceneResize.observe($('scene'));
try {
  state.motion = localStorage.getItem('varisdev-factory-motion') !== 'false';
} catch {
  /* Use the default motion setting. */
}
try {
  scene = createFactoryScene($('factory-canvas'), {
    onSelect: selectUnit,
    onLayout: layoutLabels,
  });
} catch {
  scene = null;
}
if (!scene) fallbackScene = createParentFallback($('fallback-units'));
const cleanupThemes = initThemes(palette => scene?.setPalette(palette));
const cleanupZoom = initZoom(api);
$('fallback').hidden = Boolean(scene);
$('factory-canvas').hidden = !scene;
$('scene-labels').hidden = !scene;
applyMotion();
initSessionFeatures({api, selected: snapshot, draftChanged: saveDraft});
initUsage(call => {
  const data = snapshot();
  const message =
    data?.conversation.find(item => item.id === call.id) ||
    data?.conversation.find(
      item => item.at === call.at && item.role !== 'user',
    );
  const entry = message && conversationNodes.get(message.id);
  if (!entry) {
    showError(
      'This call is outside the recent conversation preview. Its token counts remain in this view.',
    );
    return;
  }
  setTab('conversation');
  $('follow-conversation').checked = false;
  const body = $('panel-conversation');
  body.scrollTop +=
    entry.element.getBoundingClientRect().top -
    body.getBoundingClientRect().top -
    12;
  saveConversationPosition();
});
render();
window.addEventListener('unload', () => {
  state.disposed = true;
  unsubscribe?.();
  clearInterval(clock);
  clearStopEffect();
  motionPreference.removeEventListener('change', applyMotion);
  window.removeEventListener('resize', resizeFactory);
  sceneResize.disconnect();
  cleanupThemes();
  cleanupZoom();
  scene?.dispose();
  fallbackScene?.dispose();
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
    for (const message of snapshot()?.conversation || []) {
      if (message.role !== 'tool' || message.status !== 'running') continue;
      const entry = conversationNodes.get(message.id);
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
  text($('connection'), 'Desktop API unavailable');
  $('connection').classList.add('error');
  $('new-session').disabled = true;
  $('welcome-create').disabled = true;
  showError(
    'Open the VarisDev desktop app. The native desktop API is unavailable.',
  );
}
