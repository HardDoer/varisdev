/* global document, window, localStorage, setInterval, clearInterval */
import {createFactoryScene} from './factory-scene.js';
import {initThemes} from './themes.js';

const $ = id => document.getElementById(id);
const LIVE = new Set(['queued', 'running', 'cancelling']);
const WORKING = new Set(['running', 'cancelling']);
const TABS = ['conversation', 'details', 'feed', 'changes'];
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
const feedNodes = new Map();
const changeNodes = new Map();
const conversationNodes = new Map();
const conversationPositions = new Map();
const promptDrafts = new Map();
const workspaceCache = new Map();
const workspacePending = new Set();
const sending = new Set();
const stopping = new Set();
let scene;
let unsubscribe;
let clock;
let inspectorKey = '';
let feedKey = '';
let lastFeedId;
let changeKey = '';
let conversationKey = '';
let conversationSignature = '';
let lastLayout = [];
let workspaceRendered = '';
let creating = false;
let createRevision = 0;
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
function robot(drone = false) {
  const item = node('span', `robot-glyph${drone ? ' drone' : ''}`);
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
    data.agents.some(agent => LIVE.has(agent.status)) ||
    data.session.pendingPrompts > 0
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
  element.setAttribute(
    'aria-labelledby',
    textarea.id === 'parent-prompt'
      ? 'parent-editor-label'
      : 'create-editor-label',
  );
  button.setAttribute('aria-expanded', 'true');
  text(button, 'Close editor · Esc');
  $('expanded-editor-error').hidden = true;
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
function editorFailure(error, textarea, target) {
  showError(error, target);
  if (
    expandedEditor?.textarea === textarea &&
    !expandedEditor.element.contains(target)
  )
    showError(error, $('expanded-editor-error'));
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
  const footer = node('span', 'parent-card-footer');
  element.append(header, path, activity, footer);
  element.addEventListener('click', () => selectSession(data.session.id));
  return {element, name, status, path, activity, footer};
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
      entry.element.classList.toggle('attention', parentHasError(session));
      text(entry.path, session.cwd);
      text(
        entry.activity,
        parentHasError(session)
          ? session.error
          : session.activity || 'Standing by for a mission',
      );
      entry.footer.replaceChildren(
        node('span', '', `${tally.working} working · ${tally.queued} queued`),
        node('span', '', `${data.totalAgents} drones`),
        node(
          'span',
          '',
          session.owned
            ? 'Desktop parent'
            : canControl(session)
              ? 'Connected pidev'
              : 'Disconnected pidev',
        ),
      );
      entry.element.title = `${session.name}\n${session.cwd}\n${session.activity || ''}${session.error ? `\n${session.error}` : ''}`;
    },
  );
  const workingParents = parents.filter(item =>
    ['running', 'compacting'].includes(item.session.status),
  ).length;
  const workingDrones = parents.reduce(
    (sum, item) => sum + counts(item).working,
    0,
  );
  text(
    $('hub-counts'),
    parents.length
      ? `${parents.length} parents · ${workingParents} working masters · ${workingDrones} working drones`
      : 'No parents yet',
  );
}
function createSceneLabel(id) {
  const element = node(
    'button',
    `scene-label${id === 'parent' ? ' parent-label' : ''}`,
  );
  element.type = 'button';
  const kind = node('span', 'scene-label-kind');
  const role = node('span', '', id === 'parent' ? 'MASTER ROBOT' : 'DRONE');
  const status = node('span');
  kind.append(role, status);
  const name = node('span', 'scene-label-name');
  const task = node('span', 'scene-label-task');
  const activity = node('span', 'scene-label-activity');
  const stem = node('span', 'label-stem');
  element.append(kind, name, task, activity);
  element.addEventListener('click', () => selectUnit(id));
  $('scene-labels').append(stem, element);
  return {element, name, task, activity, status, stem};
}
function layoutLabels(layout) {
  lastLayout = layout;
  const data = snapshot();
  if (!data || !scene) return;
  const ids = new Set(layout.map(item => item.id));
  for (const [id, entry] of labelNodes) {
    if (!ids.has(id)) {
      entry.element.remove();
      entry.stem.remove();
      labelNodes.delete(id);
    }
  }
  const rect = $('scene').getBoundingClientRect();
  const canvas = $('factory-canvas').getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const drones = layout
    .filter(item => item.id !== 'parent' && item.visible)
    .sort((a, b) => a.y - b.y);
  const back = drones
    .slice(0, Math.ceil(drones.length / 2))
    .sort((a, b) => a.x - b.x);
  const front = drones.slice(back.length).sort((a, b) => a.x - b.x);
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
    entry.element.hidden = !anchor.visible;
    entry.stem.hidden = !anchor.visible;
    if (!anchor.visible) continue;
    text(entry.name, unit.name);
    text(
      entry.task,
      anchor.id === 'parent' ? unit.prompt || 'Parent session' : unit.task,
    );
    text(entry.activity, unit.activity || statusName(unit.status));
    text(entry.status, statusName(unit.status));
    entry.element.classList.toggle('selected', state.unitId === anchor.id);
    entry.element.setAttribute(
      'aria-pressed',
      String(state.unitId === anchor.id),
    );
    entry.element.title = `${unit.name}\n${anchor.id === 'parent' ? unit.prompt || '' : unit.task}\n${unit.activity || ''}`;
    if (entry.sceneWidth !== width) {
      entry.element.style.width = '';
      entry.baseWidth = entry.element.offsetWidth;
      entry.sceneWidth = width;
    }
    const parent = anchor.id === 'parent';
    const rear = back.some(item => item.id === anchor.id);
    const band = rear ? back : front;
    const left = rear ? (width > 800 ? 225 : 185) : 18;
    const w =
      !parent && band.length
        ? Math.min(entry.baseWidth, (width - left - 18) / band.length - 8)
        : entry.baseWidth;
    if (entry.element.style.width !== `${w}px`)
      entry.element.style.width = `${w}px`;
    const h = entry.element.offsetHeight;
    const index = band.findIndex(item => item.id === anchor.id);
    const x = parent
      ? 18
      : band.length === 1
        ? Math.max(left, Math.min(width - w - 18, anchor.x * width - w / 2))
        : left + (index * (width - left - w - 18)) / (band.length - 1);
    const y = parent || rear ? 46 : height - h - 38;
    entry.element.style.left = `${Math.round(x)}px`;
    entry.element.style.top = `${Math.round(y)}px`;
    const targetX = canvas.left - rect.left + anchor.x * canvas.width;
    const targetY = canvas.top - rect.top + anchor.y * canvas.height;
    const startX = x + w / 2;
    const startY = targetY > y + h / 2 ? y + h : y;
    const dx = targetX - startX;
    const dy = targetY - startY;
    entry.stem.style.left = `${startX}px`;
    entry.stem.style.top = `${startY}px`;
    entry.stem.style.height = `${Math.hypot(dx, dy)}px`;
    entry.stem.style.transform = `rotate(${Math.atan2(-dx, dy)}rad)`;
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
  $('fallback-units').replaceChildren(
    ...units.map(unit => {
      const parent = unit.id === 'parent';
      const element = node(
        'button',
        `fallback-station ${parent ? 'master' : 'drone'} ${Object.hasOwn(STATUS, unit.status) ? unit.status : ''}`,
      );
      element.type = 'button';
      element.setAttribute('aria-pressed', String(state.unitId === unit.id));
      element.title = `${unit.name}\n${parent ? unit.prompt || 'Master command' : unit.task}\n${unit.activity || statusName(unit.status)}`;
      element.append(
        robot(!parent),
        node('strong', '', unit.name),
        node('p', '', parent ? unit.prompt || 'Master command' : unit.task),
        node('p', 'muted', unit.activity || statusName(unit.status)),
      );
      element.addEventListener('click', () => selectUnit(unit.id));
      return element;
    }),
  );
}
function sizeInspector() {
  if (!snapshot() || $('factory-workspace').hidden) return;
  const element = $('inspector');
  const top = Math.max(18, element.getBoundingClientRect().top);
  const available = Math.max(300, window.innerHeight - top - 18);
  element.style.maxHeight = `${Math.round(available)}px`;
  element.style.setProperty('--inspector-space', `${Math.round(available)}px`);
}
function sizeScene() {
  if (!snapshot()) return;
  const element = $('scene');
  const top = element.getBoundingClientRect().top + window.scrollY;
  const height = Math.max(280, Math.min(430, window.innerHeight - top - 18));
  const value = `${Math.round(height)}px`;
  if (element.style.height !== value) element.style.height = value;
  element.classList.toggle('compact-scene', height < 360);
}
function resizeFactory() {
  sizeScene();
  sizeInspector();
  if (scene) layoutLabels(lastLayout);
}
function renderFactory() {
  const data = snapshot();
  if (!data) return;
  const session = data.session;
  const tally = counts(data);
  text($('factory-title'), session.name);
  text($('factory-path'), session.cwd);
  text($('factory-model'), session.model);
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
  text($('master-activity'), session.activity || 'Standing by for a mission');
  text(
    $('scene-caption'),
    `${tally.working} working drones · ${tally.queued} queued`,
  );
  sizeScene();
  if (scene) {
    scene.update({...data, agents: sceneAgents(data)}, state.unitId);
    layoutLabels(lastLayout);
  } else renderFallback(data);
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
  const pending = node('span');
  meta.append(model, time, pending);
  element.append(header, task, activity, meta);
  element.addEventListener('click', () => selectUnit(agent.id));
  return {element, name, status, task, activity, model, time, pending};
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
      text(entry.pending, `${agent.pendingMessages} pending`);
    },
  );
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
    },
  );
  text($('active-count'), active.length);
  text($('history-count'), history.length);
  $('no-workers').hidden = active.length > 0;
  $('no-history').hidden = filtered.length > 0;
  text(
    $('no-history'),
    history.length
      ? 'No drones match this history search.'
      : 'Completed drones appear here.',
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
    () => {
      const element = node('li', 'feed-event');
      const meta = node('span', 'feed-event-meta');
      const kind = node('span');
      const at = node('time');
      const message = node('p');
      meta.append(kind, at);
      element.append(meta, message);
      return {element, kind, at, message};
    },
    (entry, event) => {
      entry.element.classList.toggle('error', event.kind === 'error');
      text(entry.kind, `${event.sourceName} · ${event.kind}`);
      text(entry.at, date(event.at));
      entry.at.dateTime = event.at;
      text(entry.message, event.message);
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
    () => {
      const element = node('details', 'change-entry');
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
function renderConversation(data) {
  const body = $('panel-conversation');
  const sessionChanged = conversationKey !== state.sessionId;
  if (sessionChanged) {
    conversationNodes.clear();
    $('conversation').replaceChildren();
    conversationKey = state.sessionId;
    conversationSignature = '';
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
    () => {
      const element = node('li', 'conversation-message');
      const header = node('div', 'conversation-message-header');
      const role = node('strong');
      const time = node('time');
      const streaming = node('span', 'conversation-streaming', 'Streaming');
      header.append(role, time, streaming);
      const content = node('pre', 'prose conversation-text');
      const textNode = document.createTextNode('');
      content.append(textNode);
      const truncated = node(
        'p',
        'muted conversation-preview',
        'Message preview truncated; full text is in the session file.',
      );
      const error = node('p', 'conversation-error');
      element.append(header, content, truncated, error);
      return {element, role, time, streaming, textNode, truncated, error};
    },
    (entry, message) => {
      entry.element.classList.toggle('user', message.role === 'user');
      text(entry.role, message.role === 'user' ? 'User' : 'Assistant');
      text(entry.time, date(message.at));
      entry.time.dateTime = message.at;
      entry.streaming.hidden = !message.streaming;
      const next = String(message.text || '');
      const previous = entry.textNode.data;
      // Appending stream text keeps native selection endpoints in existing text.
      if (next.startsWith(previous)) {
        if (next.length > previous.length)
          entry.textNode.appendData(next.slice(previous.length));
      } else if (next !== previous) {
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const startsHere = range?.startContainer === entry.textNode;
        const endsHere = range?.endContainer === entry.textNode;
        const start = range?.startOffset;
        const end = range?.endOffset;
        entry.textNode.replaceData(0, previous.length, next);
        if (startsHere)
          range.setStart(entry.textNode, Math.min(start, next.length));
        if (endsHere) range.setEnd(entry.textNode, Math.min(end, next.length));
      }
      entry.truncated.hidden = !message.truncated;
      entry.error.hidden = !message.error;
      text(entry.error, message.error);
    },
  );
  $('conversation-empty').hidden = messages.length > 0;
  const latest = messages.at(-1);
  const signature = latest
    ? `${latest.id}:${latest.text.length}:${latest.streaming}`
    : '';
  if (
    state.tab === 'conversation' &&
    $('follow-conversation').checked &&
    !selectedText &&
    nearBottom &&
    signature !== conversationSignature
  )
    body.scrollTop = body.scrollHeight;
  if (sessionChanged) {
    const saved = conversationPositions.get(state.sessionId);
    if (saved) body.scrollTop = saved.top;
  }
  conversationSignature = signature;
}
function renderInspector() {
  const data = snapshot();
  const unit = selectedUnit();
  if (!data || !unit) return;
  const parent = state.unitId === 'parent';
  const key = `${state.sessionId}:${state.unitId}`;
  if (inspectorKey !== key) {
    for (const tab of ['details', 'feed', 'changes'])
      $(`panel-${tab}`).scrollTop = 0;
    inspectorKey = key;
  }
  text($('inspector-role'), parent ? 'MASTER ROBOT / PARENT' : 'WORKER DRONE');
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
    ['Elapsed', duration(unit)],
    ['Started', date(unit.startedAt)],
    ['Created', date(parent ? unit.startedAt : unit.createdAt)],
    [
      parent ? 'Updated' : 'Finished',
      date(parent ? unit.updatedAt : unit.finishedAt),
    ],
    [
      'Pending',
      parent
        ? `${unit.pendingPrompts} prompts`
        : `${unit.pendingMessages} messages`,
    ],
    ['ID', unit.id],
    ...(parent
      ? [
          [
            'Control',
            canControl(unit)
              ? unit.owned
                ? 'Desktop parent'
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
  const running = ['running', 'compacting'].includes(data.session.status);
  $('abort-parent').disabled =
    !canControl(data.session) ||
    !parentHasWork(data) ||
    stopping.has(state.sessionId);
  text(
    $('abort-parent'),
    stopping.has(state.sessionId) ? 'Stopping…' : 'Stop parent',
  );
  $('send-prompt').disabled =
    sending.has(state.sessionId) || data.session.status === 'closed';
  text(
    $('send-prompt'),
    sending.has(state.sessionId) ? 'Sending…' : running ? 'Queue' : 'Send',
  );
  text(
    $('prompt-hint'),
    data.session.status === 'closed'
      ? 'Parent closed'
      : data.session.pendingPrompts
        ? `${data.session.pendingPrompts} queued prompts`
        : running
          ? 'Sent as a follow-up'
          : 'Ready for a mission',
  );
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
  if (tab === 'feed' && $('follow-feed').checked)
    $('panel-feed').scrollTop = $('panel-feed').scrollHeight;
}
function render() {
  if (state.disposed) return;
  const hasSession = Boolean(snapshot());
  $('welcome').hidden = hasSession;
  $('factory-workspace').hidden = !hasSession;
  text(
    $('launch-path'),
    state.hub.launchCwd ? `Launch folder: ${state.hub.launchCwd}` : '',
  );
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
  scene?.setMotion(enabled);
}
function openCreate() {
  if (!$('create-cwd').value) $('create-cwd').value = state.hub.launchCwd || '';
  $('create-error').hidden = true;
  $('create-dialog').showModal();
  $('create-prompt').focus();
}
async function createParent(event) {
  event.preventDefault();
  if (creating || !api) return;
  const textarea = $('create-prompt');
  const rawPrompt = textarea.value;
  const revision = createRevision;
  const cwd = $('create-cwd').value.trim();
  const prompt = rawPrompt.trim();
  const rawName = $('create-name').value;
  const name = rawName.trim();
  if (!cwd || !prompt) {
    editorFailure(
      'Choose a folder and enter a mission.',
      textarea,
      $('create-error'),
    );
    return;
  }
  creating = true;
  $('create-error').hidden = true;
  $('expanded-editor-error').hidden = true;
  for (const id of ['create-submit', 'create-expanded-submit']) {
    $(id).disabled = true;
    text($(id), 'Launching…');
  }
  try {
    const result = await api.createSession({
      cwd,
      prompt,
      ...(name ? {name} : {}),
    });
    state.desiredSessionId = result.id;
    if (state.hub.sessions.some(item => item.session.id === result.id)) {
      selectSession(result.id);
      state.desiredSessionId = null;
    } else receive(await api.getState());
    if (createRevision === revision && textarea.value === rawPrompt) {
      if (expandedEditor?.textarea === textarea) collapseEditor(false);
      textarea.value = '';
      createRevision++;
      $('create-dialog').close();
    }
    if ($('create-name').value === rawName) $('create-name').value = '';
  } catch (error) {
    editorFailure(error, textarea, $('create-error'));
  } finally {
    creating = false;
    for (const id of ['create-submit', 'create-expanded-submit']) {
      $(id).disabled = false;
      text($(id), 'Launch parent ↗');
    }
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
    !prompt
  )
    return;
  saveDraft();
  const submitted = {...promptDrafts.get(id)};
  sending.add(id);
  $('prompt-error').hidden = true;
  $('app-error').hidden = true;
  $('expanded-editor-error').hidden = true;
  renderInspector();
  try {
    await api.promptSession(id, {prompt});
    clearSubmittedDraft(id, submitted);
  } catch (error) {
    if (id === state.sessionId)
      editorFailure(error, textarea, $('prompt-error'));
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
  $('app-error').hidden = true;
  renderInspector();
  try {
    await api.abortSession(id);
  } catch (error) {
    showError(error);
  } finally {
    stopping.delete(id);
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

$('new-session').addEventListener('click', openCreate);
$('welcome-create').addEventListener('click', openCreate);
$('close-create').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', createParent);
$('choose-folder').addEventListener('click', async () => {
  if (!api) return;
  $('choose-folder').disabled = true;
  try {
    const folder = await api.chooseFolder();
    if (folder) $('create-cwd').value = folder;
  } catch (error) {
    showError(error, $('create-error'));
  } finally {
    $('choose-folder').disabled = false;
  }
});
$('inspect-parent').addEventListener('click', () => selectUnit('parent'));
$('prompt-form').addEventListener('submit', sendPrompt);
for (const event of ['input', 'select', 'keyup', 'pointerup', 'scroll', 'blur'])
  $('parent-prompt').addEventListener(event, saveDraft);
document.addEventListener('selectionchange', () => {
  if (document.activeElement === $('parent-prompt')) saveDraft();
});
$('create-prompt').addEventListener('input', () => {
  createRevision++;
});
for (const [id, formId] of [
  ['parent-prompt', 'prompt-form'],
  ['create-prompt', 'create-form'],
]) {
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
$('expand-create-editor').addEventListener('click', () =>
  expandEditor(
    $('create-mission-editor'),
    $('create-prompt'),
    $('expand-create-editor'),
  ),
);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && expandedEditor) {
    event.preventDefault();
    event.stopPropagation();
    collapseEditor();
  }
});
$('create-dialog').addEventListener('cancel', event => {
  if (expandedEditor) {
    event.preventDefault();
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
window.addEventListener('scroll', sizeInspector, {passive: true});
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
const cleanupThemes = initThemes(palette => scene?.setPalette(palette));
$('fallback').hidden = Boolean(scene);
$('factory-canvas').hidden = !scene;
text(
  $('visual-mode'),
  scene ? 'WEBGL · 3D' : 'GRAPHICAL VIEW · WEBGL UNAVAILABLE',
);
applyMotion();
render();
window.addEventListener('unload', () => {
  state.disposed = true;
  unsubscribe?.();
  clearInterval(clock);
  motionPreference.removeEventListener('change', applyMotion);
  window.removeEventListener('resize', resizeFactory);
  window.removeEventListener('scroll', sizeInspector);
  cleanupThemes();
  scene?.dispose();
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
    'Open this factory in the VarisDev desktop app. The native desktop API is unavailable.',
  );
}
