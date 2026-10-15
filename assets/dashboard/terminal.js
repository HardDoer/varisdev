/* global document, window, ResizeObserver */
export function createTerminalTabs(api, selectedSession) {
  const $ = id => document.getElementById(id);
  const sessions = new Map();
  let activeId;
  let selected = false;
  let disposed = false;
  function failure(error, id = activeId) {
    if (id !== activeId || disposed) return;
    $('terminal-error').textContent = error.message || String(error);
    $('terminal-error').hidden = false;
  }
  function fit() {
    const entry = sessions.get(activeId);
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
      .resizeTerminal(activeId, entry.terminal.cols, entry.terminal.rows)
      .catch(error => failure(error));
  }
  function receive(event) {
    const entry = sessions.get(event.sessionId);
    if (!entry) return;
    if (!entry.ready) {
      entry.pending.push(event);
      return;
    }
    if (
      event.generation !== entry.generation ||
      event.sequence <= entry.sequence
    )
      return;
    entry.sequence = event.sequence;
    if (event.data) entry.terminal.write(event.data);
    if (event.exitCode !== undefined) {
      entry.terminal.write(
        `\r\n[Shell exited with code ${event.exitCode}]\r\n`,
      );
      entry.terminal.options.disableStdin = true;
    }
  }
  async function open(id) {
    if (sessions.has(id)) return;
    if (id === activeId) $('terminal-close').disabled = true;
    const element = document.createElement('div');
    element.className = 'project-terminal';
    element.hidden = activeId !== id;
    $('terminal-sessions').append(element);
    const terminal = new window.Terminal({
      cursorBlink: true,
      fontSize: 13,
      scrollback: 2000,
      theme: {background: '#10171d', foreground: '#e2edf3'},
    });
    const addon = new window.FitAddon.FitAddon();
    terminal.loadAddon(addon);
    terminal.open(element);
    const entry = {element, terminal, fit: addon, pending: [], ready: false};
    sessions.set(id, entry);
    terminal.onData(data => {
      for (let offset = 0; offset < data.length; offset += 64 * 1024)
        void api
          .writeTerminal(id, data.slice(offset, offset + 64 * 1024))
          .catch(error => failure(error, id));
    });
    try {
      const initial = await api.openTerminal(id);
      if (disposed || sessions.get(id) !== entry) return;
      entry.generation = initial.generation;
      entry.sequence = initial.sequence;
      entry.ready = true;
      if (id === activeId) $('terminal-close').disabled = false;
      terminal.write(initial.data);
      if (initial.exitCode !== undefined) {
        terminal.write(`\r\n[Shell exited with code ${initial.exitCode}]\r\n`);
        terminal.options.disableStdin = true;
      }
      for (const event of entry.pending) receive(event);
      entry.pending = [];
      if (activeId === id && selected) {
        fit();
        terminal.focus();
      }
    } catch (error) {
      if (disposed || sessions.get(id) !== entry) return;
      sessions.delete(id);
      terminal.dispose();
      element.remove();
      failure(error, id);
      if (id === activeId) $('terminal-close').disabled = false;
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
    update();
    if (selected) {
      if (activeId) void open(activeId);
      fit();
      sessions.get(activeId)?.terminal.focus();
    } else $('parent-prompt').focus();
  }
  function update() {
    const nextId = selectedSession();
    if (nextId !== activeId) {
      activeId = nextId;
      $('terminal-error').hidden = true;
      for (const [id, entry] of sessions)
        entry.element.hidden = id !== activeId;
      if (selected && activeId) void open(activeId);
    }
    $('terminal-close').disabled = Boolean(
      sessions.get(activeId) && !sessions.get(activeId).ready,
    );
    if (selected) fit();
  }
  async function close() {
    const id = activeId;
    if (!id) return;
    try {
      await api.closeTerminal(id);
      const entry = sessions.get(id);
      sessions.delete(id);
      entry?.terminal.dispose();
      entry?.element.remove();
      if (id === activeId) show(false);
    } catch (error) {
      failure(error, id);
    }
  }
  const unsubscribe = api?.onTerminal?.(receive);
  $('prompt-tab').addEventListener('click', () => show(false));
  $('terminal-tab').addEventListener('click', () => show(true));
  $('terminal-close').addEventListener('click', close);
  for (const id of ['prompt-tab', 'terminal-tab'])
    $(id).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      show(
        event.key === 'Home' ? false : event.key === 'End' ? true : !selected,
      );
      $(selected ? 'terminal-tab' : 'prompt-tab').focus();
    });
  const observer = new ResizeObserver(fit);
  observer.observe($('terminal-sessions'));
  return {
    update,
    showPrompt: () => show(false),
    retain(ids) {
      const opened = new Set(ids);
      for (const [id, entry] of sessions) {
        if (opened.has(id)) continue;
        sessions.delete(id);
        entry.terminal.dispose();
        entry.element.remove();
      }
      if (activeId && !opened.has(activeId)) show(false);
    },
    isSelected: () => selected,
    dispose() {
      disposed = true;
      observer.disconnect();
      unsubscribe?.();
      for (const entry of sessions.values()) entry.terminal.dispose();
      sessions.clear();
    },
  };
}
