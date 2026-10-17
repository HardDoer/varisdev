/* global document, window, ResizeObserver */
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
  const listeners = [];
  let activeId;
  let selected = false;
  let disposed = false;
  let fitFrame;

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
      .catch(error => failure(error, activeId, entry));
  }
  function requestFit() {
    if (disposed || fitFrame !== undefined) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = undefined;
      fit();
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
  }
  function receive(event) {
    const entry = sessions.get(event.sessionId);
    if (!entry) return;
    if (!entry.ready) {
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
    const entry = {
      id,
      element,
      terminal,
      fit: addon,
      pending: [],
      pendingLength: 0,
      ready: false,
      output: [],
      outputIndex: 0,
      outputOffset: 0,
      outputLength: 0,
      writing: false,
    };
    sessions.set(id, entry);
    entry.inputSubscription = terminal.onData(data => {
      for (let offset = 0; offset < data.length; offset += 64 * 1024)
        void api
          .writeTerminal(id, data.slice(offset, offset + 64 * 1024))
          .catch(error => failure(error, id, entry));
    });
    try {
      const initial = await api.openTerminal(id);
      if (disposed || sessions.get(id) !== entry) return;
      entry.generation = initial.generation;
      entry.sequence = initial.sequence;
      entry.ready = true;
      if (id === activeId) $('terminal-close').disabled = false;
      const pending = entry.pending;
      entry.pending = [];
      entry.pendingLength = 0;
      if (entry.pendingTruncated) {
        entry.resetOutput = true;
        appendOutput(entry, OUTPUT_TRUNCATED);
      }
      appendOutput(entry, initial.data);
      for (const event of pending) receive(event);
      if (initial.exitCode !== undefined) markExited(entry, initial.exitCode);
      if (activeId === id && selected) {
        requestFit();
        terminal.focus();
      }
    } catch (error) {
      if (disposed || sessions.get(id) !== entry) return;
      removeEntry(id, entry);
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
      requestFit();
      const entry = sessions.get(activeId);
      if (entry) requestOutput(entry);
      entry?.terminal.focus();
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
      if (selected) {
        requestFit();
        const entry = sessions.get(activeId);
        if (entry) requestOutput(entry);
      }
    }
    const active = sessions.get(activeId);
    $('terminal-close').disabled = Boolean(active && !active.ready);
  }
  async function close() {
    const id = activeId;
    if (!id) return;
    const entry = sessions.get(id);
    try {
      await api.closeTerminal(id);
      if (entry) removeEntry(id, entry);
      if (id === activeId) show(false);
    } catch (error) {
      failure(error, id, entry);
    }
  }
  const unsubscribe = api?.onTerminal?.(receive);
  const showPrompt = () => show(false);
  const showTerminal = () => show(true);
  listen($('prompt-tab'), 'click', showPrompt);
  listen($('terminal-tab'), 'click', showTerminal);
  listen($('terminal-close'), 'click', close);
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
  const observer = new ResizeObserver(requestFit);
  observer.observe($('terminal-sessions'));
  return {
    update,
    showPrompt,
    retain(ids) {
      const opened = new Set(ids);
      for (const [id, entry] of sessions) {
        if (opened.has(id)) continue;
        removeEntry(id, entry);
      }
      if (activeId && !opened.has(activeId)) show(false);
    },
    isSelected: () => selected,
    dispose() {
      disposed = true;
      observer.disconnect();
      unsubscribe?.();
      if (fitFrame !== undefined) window.cancelAnimationFrame(fitFrame);
      for (const remove of listeners) remove();
      for (const [id, entry] of sessions) removeEntry(id, entry);
    },
  };
}
