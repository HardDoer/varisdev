/* global document, window, ResizeObserver, MutationObserver */
import {initTerminalSettings} from './terminal-settings.js';
const OUTPUT_BACKLOG_LIMIT = 512 * 1024;
const OUTPUT_RETAIN_LIMIT = 256 * 1024;
const OUTPUT_WRITE_SIZE = 32 * 1024;
const PENDING_EVENT_LIMIT = 1024;
const OUTPUT_TRUNCATED = '\r\n[Earlier terminal output omitted]\r\n';

function startsInsideSurrogatePair(value, index) {
  if (index <= 0 || index >= value.length) return false;
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return (
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
  );
}

export function createTerminalTabs(api, selectedSession) {
  const $ = id => document.getElementById(id);
  const sessions = new Map();
  const workspaces = new Map();
  const pendingSessions = new Map();
  const listeners = [];
  let workspaceId;
  let activeId;
  let profiles;
  let loadingProfiles;
  let defaultMenu = false;
  let renderedTabs;
  let selected = false;
  let disposed = false;
  let fitFrame;
  const settings = initTerminalSettings(api, next => {
    profiles = next;
  });

  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  }
  function failure(error, id = activeId, entry) {
    if (id !== activeId || disposed || (entry && sessions.get(id) !== entry))
      return;
    $('terminal-error').textContent = error.message || String(error);
    $('terminal-error').hidden = false;
  }
  function workspaceFailure(error, id = workspaceId) {
    if (id !== workspaceId || disposed) return;
    $('terminal-error').textContent = error.message || String(error);
    $('terminal-error').hidden = false;
  }
  function fit() {
    const id = activeId;
    const entry = sessions.get(id);
    if (
      !selected ||
      !entry?.ready ||
      !$('terminal-panel').getClientRects().length
    )
      return;
    entry.fit.fit();
    const size = `${entry.terminal.cols}:${entry.terminal.rows}`;
    if (entry.size === size) return;
    entry.size = size;
    void api
      .resizeTerminal(id, entry.terminal.cols, entry.terminal.rows)
      .catch(error => failure(error, id, entry));
  }
  function requestFit() {
    if (disposed || fitFrame !== undefined) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = undefined;
      fit();
      if ($('terminal-profile-menu').matches(':popover-open'))
        positionProfiles();
    });
  }

  function truncateOutput(entry) {
    const tail = [];
    let remaining = OUTPUT_RETAIN_LIMIT;
    for (
      let index = entry.output.length - 1;
      index >= entry.outputIndex && remaining;
      index--
    ) {
      const start = index === entry.outputIndex ? entry.outputOffset : 0;
      const value = entry.output[index].slice(start);
      let kept = value;
      if (value.length > remaining) {
        let start = value.length - remaining;
        if (startsInsideSurrogatePair(value, start)) start++;
        kept = value.slice(start);
      }
      tail.push(kept);
      remaining -= kept.length;
    }
    tail.reverse();
    entry.output = [OUTPUT_TRUNCATED, ...tail];
    entry.outputIndex = 0;
    entry.outputOffset = 0;
    entry.outputLength =
      OUTPUT_TRUNCATED.length + (OUTPUT_RETAIN_LIMIT - remaining);
    entry.resetOutput = true;
  }
  function takeOutput(entry) {
    const values = [];
    let remaining = OUTPUT_WRITE_SIZE;
    while (entry.outputIndex < entry.output.length && remaining) {
      const value = entry.output[entry.outputIndex];
      const available = value.length - entry.outputOffset;
      let length = Math.min(available, remaining);
      if (
        length < available &&
        startsInsideSurrogatePair(value, entry.outputOffset + length)
      )
        length--;
      if (!length) break;
      values.push(value.slice(entry.outputOffset, entry.outputOffset + length));
      entry.outputLength -= length;
      remaining -= length;
      entry.outputOffset += length;
      if (entry.outputOffset === value.length) {
        entry.outputIndex++;
        entry.outputOffset = 0;
      }
    }
    if (entry.outputIndex === entry.output.length) {
      entry.output = [];
      entry.outputIndex = 0;
    } else if (
      entry.outputIndex > 128 &&
      entry.outputIndex * 2 > entry.output.length
    ) {
      entry.output = entry.output.slice(entry.outputIndex);
      entry.outputIndex = 0;
    }
    return values.join('');
  }
  function requestOutput(entry) {
    if (
      disposed ||
      !selected ||
      activeId !== entry.id ||
      entry.writing ||
      entry.outputFrame !== undefined ||
      sessions.get(entry.id) !== entry ||
      !entry.outputLength
    )
      return;
    entry.outputFrame = window.requestAnimationFrame(() => {
      entry.outputFrame = undefined;
      if (
        disposed ||
        !selected ||
        activeId !== entry.id ||
        sessions.get(entry.id) !== entry
      )
        return;
      if (entry.resetOutput) {
        entry.resetOutput = false;
        entry.terminal.reset();
      }
      const data = takeOutput(entry);
      if (!data) return;
      entry.writing = true;
      entry.terminal.write(data, () => {
        entry.writing = false;
        requestOutput(entry);
      });
    });
  }
  function appendOutput(entry, data) {
    if (!data || disposed || sessions.get(entry.id) !== entry) return;
    entry.output.push(data);
    entry.outputLength += data.length;
    if (entry.outputLength > OUTPUT_BACKLOG_LIMIT) truncateOutput(entry);
    requestOutput(entry);
  }
  function markExited(entry, exitCode) {
    if (entry.exitCode !== undefined) return;
    entry.exitCode = exitCode;
    appendOutput(entry, `\r\n[Shell exited with code ${exitCode}]\r\n`);
    entry.terminal.options.disableStdin = true;
    renderTabs();
  }
  function queuePending(entry, event) {
    let pendingEvent = event;
    if (event.data?.length > OUTPUT_RETAIN_LIMIT) {
      let start = event.data.length - OUTPUT_RETAIN_LIMIT;
      if (startsInsideSurrogatePair(event.data, start)) start++;
      pendingEvent = {...event, data: event.data.slice(start)};
      entry.pendingTruncated = true;
    }
    entry.pending.push(pendingEvent);
    entry.pendingLength += pendingEvent.data?.length || 0;
    while (
      (entry.pendingLength > OUTPUT_BACKLOG_LIMIT ||
        entry.pending.length > PENDING_EVENT_LIMIT) &&
      entry.pending.length > 1
    ) {
      const removed = entry.pending.shift();
      entry.pendingLength -= removed.data?.length || 0;
      entry.pendingTruncated = true;
    }
  }
  function receive(event) {
    const entry = sessions.get(event.sessionId);
    if (!entry) {
      const id = event.workspaceId || event.sessionId;
      if (!workspaces.get(id)?.busy) return;
      let pending = pendingSessions.get(event.sessionId);
      if (!pending) {
        pending = {workspaceId: id, pending: [], pendingLength: 0};
        pendingSessions.set(event.sessionId, pending);
      }
      queuePending(pending, event);
      return;
    }
    if (!entry.ready) {
      queuePending(entry, event);
      return;
    }
    if (
      event.generation !== entry.generation ||
      event.sequence <= entry.sequence
    )
      return;
    entry.sequence = event.sequence;
    appendOutput(entry, event.data);
    if (event.exitCode !== undefined) markExited(entry, event.exitCode);
  }
  function removeEntry(id, entry) {
    if (sessions.get(id) !== entry) return;
    sessions.delete(id);
    if (entry.outputFrame !== undefined)
      window.cancelAnimationFrame(entry.outputFrame);
    entry.inputSubscription?.dispose();
    entry.terminal.dispose();
    entry.element.remove();
  }
  function terminalTheme() {
    const styles = window.getComputedStyle($('terminal-sessions'));
    const color = name => styles.getPropertyValue(name).trim();
    return {
      background: styles.backgroundColor,
      foreground: color('--terminal-foreground') || color('--text'),
      cursor: color('--terminal-cursor') || color('--accent'),
      selectionBackground: color('--selected'),
    };
  }
  function adopt(initial, workspace) {
    const id = initial.sessionId;
    if (sessions.has(id)) return sessions.get(id);
    const element = document.createElement('div');
    element.className = 'project-terminal';
    element.id = `terminal-view-${id}`;
    element.setAttribute('role', 'tabpanel');
    element.setAttribute('aria-labelledby', `terminal-label-${id}`);
    element.hidden = true;
    $('terminal-sessions').append(element);
    const terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 2000,
      minimumContrastRatio: 4.5,
      theme: terminalTheme(),
    });
    const addon = new window.FitAddon.FitAddon();
    terminal.loadAddon(addon);
    terminal.open(element);
    const pending = pendingSessions.get(id);
    pendingSessions.delete(id);
    const entry = {
      id,
      workspaceId: initial.workspaceId || workspace.id,
      title: initial.title || 'Terminal',
      profileId: initial.profileId,
      element,
      terminal,
      fit: addon,
      pending: pending?.pending || [],
      pendingLength: 0,
      ready: true,
      generation: initial.generation,
      sequence: initial.sequence,
      output: [],
      outputIndex: 0,
      outputOffset: 0,
      outputLength: 0,
      writing: false,
    };
    sessions.set(id, entry);
    workspace.ids.push(id);
    entry.inputSubscription = terminal.onData(data => {
      for (let offset = 0; offset < data.length; offset += 64 * 1024)
        void api
          .writeTerminal(id, data.slice(offset, offset + 64 * 1024))
          .catch(error => failure(error, id, entry));
    });
    if (pending?.pendingTruncated) {
      entry.resetOutput = true;
      appendOutput(entry, OUTPUT_TRUNCATED);
    }
    appendOutput(entry, initial.data);
    for (const event of entry.pending) receive(event);
    entry.pending = [];
    if (initial.exitCode !== undefined) markExited(entry, initial.exitCode);
    return entry;
  }
  function renderTabs() {
    if (disposed) return;
    const workspace = workspaces.get(workspaceId);
    $('terminal-new').disabled = !workspace || Boolean(workspace.busy);
    $('terminal-profiles').disabled = !workspace;
    const key = JSON.stringify([
      workspaceId,
      activeId,
      ...(workspace?.ids || []).map(id => {
        const entry = sessions.get(id);
        return [id, entry?.title, entry?.exitCode, entry?.closing];
      }),
    ]);
    if (key === renderedTabs) return;
    renderedTabs = key;
    const strip = $('terminal-tabs');
    const scrollLeft = strip.scrollLeft;
    const focused = document.activeElement;
    const focusId = focused?.getAttribute('data-terminal-id');
    const focusClose = focused?.hasAttribute('data-close-terminal');
    strip.replaceChildren();
    for (const id of workspace?.ids || []) {
      const entry = sessions.get(id);
      if (!entry) continue;
      const item = document.createElement('div');
      item.className = 'terminal-tab-item';
      item.classList.toggle('selected', id === activeId);
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `terminal-label-${id}`;
      tab.className = 'terminal-session-tab';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === activeId));
      tab.setAttribute('aria-controls', entry.element.id);
      tab.setAttribute('data-terminal-id', id);
      tab.tabIndex = id === activeId ? 0 : -1;
      tab.textContent =
        entry.title + (entry.exitCode === undefined ? '' : ' (exited)');
      tab.title = tab.textContent;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'terminal-tab-close';
      if (id === activeId) close.id = 'terminal-close';
      close.setAttribute('data-terminal-id', id);
      close.setAttribute('data-close-terminal', '');
      close.setAttribute('aria-label', `Close ${entry.title}`);
      close.title = `Close ${entry.title}`;
      close.textContent = '×';
      close.disabled = Boolean(entry.closing);
      item.append(tab, close);
      strip.append(item);
      if (focusId === id) (focusClose ? close : tab).focus();
    }
    strip.scrollLeft = scrollLeft;
  }
  function refreshActive(focus = false) {
    const workspace = workspaces.get(workspaceId);
    activeId = workspace?.activeId;
    for (const [id, entry] of sessions) entry.element.hidden = id !== activeId;
    renderTabs();
    if (!selected) return;
    requestFit();
    const entry = sessions.get(activeId);
    if (entry) requestOutput(entry);
    if (focus) entry?.terminal.focus();
  }
  async function ensureWorkspace(workspace) {
    if (workspace.busy || (workspace.loaded && workspace.ids.length)) return;
    workspace.busy = true;
    renderTabs();
    try {
      const snapshots = workspace.loaded
        ? []
        : await api.listTerminals(workspace.id);
      if (disposed || workspaces.get(workspace.id) !== workspace) return;
      for (const snapshot of snapshots) adopt(snapshot, workspace);
      if (!workspace.ids.length) {
        const snapshot = await api.openTerminal(workspace.id);
        if (disposed || workspaces.get(workspace.id) !== workspace) return;
        adopt(snapshot, workspace);
      }
      workspace.loaded = true;
      workspace.activeId ||= workspace.ids[0];
      refreshActive(selected && workspace.id === workspaceId);
    } catch (error) {
      workspaceFailure(error, workspace.id);
    } finally {
      workspace.busy = false;
      renderTabs();
    }
  }
  function selectTerminal(id, focus = true) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace?.ids.includes(id)) return;
    workspace.activeId = id;
    $('terminal-error').hidden = true;
    refreshActive(focus);
    $(`terminal-label-${id}`)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  }
  async function create(profileId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace || workspace.busy) return;
    workspace.busy = true;
    $('terminal-error').hidden = true;
    renderTabs();
    try {
      const snapshot = await api.createTerminal(workspace.id, profileId);
      if (disposed || workspaces.get(workspace.id) !== workspace) return;
      adopt(snapshot, workspace);
      workspace.activeId = snapshot.sessionId;
      workspace.loaded = true;
      refreshActive(workspace.id === workspaceId);
      if (workspace.id === workspaceId)
        $(`terminal-label-${snapshot.sessionId}`)?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
        });
    } catch (error) {
      workspaceFailure(error, workspace.id);
    } finally {
      workspace.busy = false;
      renderTabs();
    }
  }
  function show(terminalSelected) {
    selected = terminalSelected;
    $('prompt-panel').hidden = selected;
    $('terminal-panel').hidden = !selected;
    $('parent-prompt').required = !selected;
    for (const [id, enabled] of [
      ['prompt-tab', !selected],
      ['terminal-tab', selected],
    ]) {
      $(id).classList.toggle('selected', enabled);
      $(id).setAttribute('aria-selected', String(enabled));
      $(id).tabIndex = enabled ? 0 : -1;
    }
    $('terminal-error').hidden = true;
    hideProfiles();
    update();
    if (selected) {
      void loadProfiles().catch(error => workspaceFailure(error));
      refreshActive(true);
    } else $('parent-prompt').focus();
  }
  function update() {
    const nextId = selectedSession();
    if (nextId !== workspaceId) {
      workspaceId = nextId;
      $('terminal-error').hidden = true;
      hideProfiles();
      if (workspaceId && !workspaces.has(workspaceId))
        workspaces.set(workspaceId, {id: workspaceId, ids: []});
      refreshActive();
    }
    const workspace = workspaces.get(workspaceId);
    if (selected && workspace) void ensureWorkspace(workspace);
    renderTabs();
  }
  async function close(id) {
    const entry = sessions.get(id);
    const workspace = workspaces.get(entry?.workspaceId);
    if (!entry || !workspace || entry.closing) return;
    entry.closing = true;
    renderTabs();
    try {
      await api.closeTerminal(id);
      if (disposed || sessions.get(id) !== entry) return;
      const index = workspace.ids.indexOf(id);
      workspace.ids.splice(index, 1);
      pendingSessions.delete(id);
      removeEntry(id, entry);
      if (workspace.activeId === id)
        workspace.activeId =
          workspace.ids[Math.min(index, workspace.ids.length - 1)];
      refreshActive(workspace.id === workspaceId);
      if (workspace.id === workspaceId && !workspace.ids.length) show(false);
    } catch (error) {
      workspaceFailure(error, workspace.id);
    } finally {
      entry.closing = false;
      renderTabs();
    }
  }
  async function loadProfiles() {
    if (profiles) return profiles;
    loadingProfiles ||= api
      .getTerminalProfiles()
      .then(value => {
        profiles = value;
        return value;
      })
      .finally(() => {
        loadingProfiles = undefined;
      });
    return loadingProfiles;
  }
  function hideProfiles() {
    $('terminal-profile-menu').hidePopover();
    $('terminal-profiles').setAttribute('aria-expanded', 'false');
  }
  function positionProfiles() {
    const menu = $('terminal-profile-menu');
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    menu.style.maxWidth = `${Math.max(0, width - 16)}px`;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const anchor = $('terminal-profiles').getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(left + 8, Math.min(anchor.right - bounds.width, left + width - bounds.width - 8))}px`;
    const preferredTop =
      anchor.bottom + bounds.height + 8 <= top + height
        ? anchor.bottom + 4
        : anchor.top - bounds.height - 4;
    menu.style.top = `${Math.max(top + 8, Math.min(preferredTop, top + height - bounds.height - 8))}px`;
  }
  function renderProfiles() {
    const menu = $('terminal-profile-menu');
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'terminal-menu-heading';
    heading.textContent = defaultMenu
      ? 'Default shell for new terminals'
      : 'New terminal';
    menu.append(heading);
    for (const profile of profiles.profiles) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', defaultMenu ? 'menuitemradio' : 'menuitem');
      button.setAttribute('data-profile-id', profile.id);
      button.title = profile.path;
      button.tabIndex = -1;
      button.textContent = profile.label;
      if (defaultMenu)
        button.setAttribute(
          'aria-checked',
          String(profile.id === profiles.defaultProfileId),
        );
      if (profile.id === profiles.defaultProfileId) {
        const badge = document.createElement('span');
        badge.className = 'terminal-profile-default';
        badge.textContent = 'Default';
        button.append(badge);
      }
      menu.append(button);
    }
    if (!defaultMenu) {
      const separator = document.createElement('hr');
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('data-select-default', '');
      button.textContent = 'Select Default Profile…';
      button.tabIndex = -1;
      const settingsButton = document.createElement('button');
      settingsButton.type = 'button';
      settingsButton.setAttribute('role', 'menuitem');
      settingsButton.setAttribute('data-terminal-settings', '');
      settingsButton.setAttribute('aria-haspopup', 'dialog');
      settingsButton.setAttribute('aria-controls', 'terminal-settings-dialog');
      settingsButton.textContent = 'Terminal settings…';
      settingsButton.tabIndex = -1;
      menu.append(separator, button, settingsButton);
    }
  }
  async function showProfiles() {
    const id = workspaceId;
    try {
      await loadProfiles();
      if (disposed || workspaceId !== id || !selected) return;
      defaultMenu = false;
      renderProfiles();
      $('terminal-profile-menu').showPopover();
      $('terminal-profiles').setAttribute('aria-expanded', 'true');
      positionProfiles();
      $('terminal-profile-menu').querySelector('button')?.focus();
    } catch (error) {
      workspaceFailure(error, id);
    }
  }
  const unsubscribe = api?.onTerminal?.(receive);
  const showPrompt = () => show(false);
  const showTerminal = () => show(true);
  listen($('prompt-tab'), 'click', showPrompt);
  listen($('terminal-tab'), 'click', showTerminal);
  listen($('terminal-new'), 'click', () => {
    void create();
  });
  listen($('terminal-tabs'), 'click', event => {
    const target = event.target.closest('button[data-terminal-id]');
    if (!target) return;
    const id = target.getAttribute('data-terminal-id');
    if (target.hasAttribute('data-close-terminal')) void close(id);
    else selectTerminal(id);
  });
  listen($('terminal-tabs'), 'keydown', event => {
    const target = event.target.closest('[role="tab"]');
    if (!target) return;
    const ids = workspaces.get(workspaceId)?.ids || [];
    let index = ids.indexOf(target.getAttribute('data-terminal-id'));
    if (event.key === 'Delete') {
      event.preventDefault();
      void close(ids[index]);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) %
            ids.length;
    selectTerminal(ids[index], false);
    $(`terminal-label-${ids[index]}`)?.focus();
  });
  listen($('terminal-profiles'), 'click', () => {
    if ($('terminal-profiles').getAttribute('aria-expanded') === 'true')
      hideProfiles();
    else void showProfiles();
  });
  listen($('terminal-profiles'), 'keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    void showProfiles();
  });
  listen($('terminal-profile-menu'), 'toggle', () => {
    $('terminal-profiles').setAttribute(
      'aria-expanded',
      String($('terminal-profile-menu').matches(':popover-open')),
    );
  });
  listen($('terminal-profile-menu'), 'click', async event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.hasAttribute('data-terminal-settings')) {
      hideProfiles();
      settings.open($('terminal-profiles'));
      return;
    }
    if (target.hasAttribute('data-select-default')) {
      defaultMenu = true;
      renderProfiles();
      positionProfiles();
      $('terminal-profile-menu')
        .querySelector('[aria-checked="true"]')
        ?.focus();
      return;
    }
    const id = target.getAttribute('data-profile-id');
    if (!id) return;
    if (!defaultMenu) {
      hideProfiles();
      void create(id);
      return;
    }
    const ownerId = workspaceId;
    for (const button of $('terminal-profile-menu').querySelectorAll('button'))
      button.disabled = true;
    try {
      profiles = await api.setDefaultTerminalProfile(id);
      if (disposed) return;
      if (workspaceId === ownerId) {
        hideProfiles();
        $('terminal-profiles').focus();
      }
    } catch (error) {
      workspaceFailure(error, ownerId);
      if (!disposed)
        for (const button of $('terminal-profile-menu').querySelectorAll(
          'button',
        ))
          button.disabled = false;
    }
  });
  listen($('terminal-profile-menu'), 'keydown', event => {
    const menu = $('terminal-profile-menu');
    if (event.key === 'Escape' || event.key === 'Tab') {
      hideProfiles();
      if (event.key === 'Escape') {
        event.preventDefault();
        $('terminal-profiles').focus();
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    let index = buttons.indexOf(document.activeElement);
    index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[index]?.focus();
  });
  for (const id of ['prompt-tab', 'terminal-tab'])
    listen($(id), 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      show(
        event.key === 'Home' ? false : event.key === 'End' ? true : !selected,
      );
      $(selected ? 'terminal-tab' : 'prompt-tab').focus();
    });
  listen(window, 'resize', requestFit);
  if (window.visualViewport)
    listen(window.visualViewport, 'resize', requestFit);
  const observer = new ResizeObserver(requestFit);
  for (const id of ['terminal-sessions', 'terminal-panel', 'terminal-tabs'])
    observer.observe($(id));
  const themeObserver = new MutationObserver(() => {
    for (const entry of sessions.values())
      entry.terminal.options.theme = terminalTheme();
    requestFit();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-appearance'],
  });
  return {
    update,
    showPrompt,
    retain(ids) {
      const opened = new Set(ids);
      for (const [id, entry] of sessions) {
        if (!opened.has(entry.workspaceId)) removeEntry(id, entry);
      }
      for (const id of workspaces.keys())
        if (!opened.has(id)) workspaces.delete(id);
      for (const [id, pending] of pendingSessions)
        if (!opened.has(pending.workspaceId)) pendingSessions.delete(id);
      if (workspaceId && !opened.has(workspaceId)) show(false);
    },
    isSelected: () => selected,
    dispose() {
      disposed = true;
      observer.disconnect();
      themeObserver.disconnect();
      settings.dispose();
      hideProfiles();
      unsubscribe?.();
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      for (const remove of listeners) remove();
      for (const [id, entry] of sessions) removeEntry(id, entry);
      workspaces.clear();
      pendingSessions.clear();
    },
  };
}
