/* global document, window */

const TERMINAL_HEIGHT_KEY = 'varisdev.composer-terminal-height.v1';

export function initComposerResize({resizeTextarea, resetTextareaSizes}) {
  const inspector = document.getElementById('inspector');
  const handle = document.getElementById('composer-resize');
  const slot = document.getElementById('composer-slot');
  const controls = document.getElementById('parent-controls');
  const textarea = document.getElementById('parent-prompt');
  const terminal = document.getElementById('terminal-sessions');
  if (!inspector || !handle || !slot || !controls || !textarea || !terminal)
    return () => {};

  let frame;
  let drag;
  let disposed = false;
  let terminalHeight;
  try {
    const saved = window.localStorage.getItem(TERMINAL_HEIGHT_KEY);
    const height = Number(saved);
    if (
      saved !== null &&
      Number.isFinite(height) &&
      height >= 80 &&
      height <= 100_000
    )
      terminalHeight = height;
  } catch {
    // Resizing remains available when preference storage is unavailable.
  }
  function setTerminalHeight(height) {
    terminalHeight = height;
    if (height === undefined)
      terminal.style.removeProperty('--composer-terminal-height');
    else
      terminal.style.setProperty('--composer-terminal-height', `${height}px`);
  }
  function persistTerminalHeight() {
    try {
      if (terminalHeight === undefined)
        window.localStorage.removeItem(TERMINAL_HEIGHT_KEY);
      else
        window.localStorage.setItem(
          TERMINAL_HEIGHT_KEY,
          String(terminalHeight),
        );
    } catch {
      // Keep the current size when preference storage is unavailable.
    }
  }
  setTerminalHeight(terminalHeight);

  // Resolve CSS min()/max()/viewport lengths through layout, including zoom.
  const measure = document.createElement('div');
  measure.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;width:0;min-height:0;max-height:none;padding:0;border:0;box-sizing:border-box;';
  inspector.append(measure);
  function pixels(value, fallback = 0) {
    if (!value || value === 'none' || value === 'auto') return fallback;
    if (/^-?(?:\d+(?:\.\d*)?|\.\d+)px$/.test(value))
      return Number.parseFloat(value);
    measure.style.height = value;
    return measure.getBoundingClientRect().height;
  }
  function visible(element) {
    return !element.closest('[hidden]') && element.getClientRects().length > 0;
  }
  function target() {
    if (
      !visible(slot) ||
      !visible(controls) ||
      controls.classList.contains('editor-expanded') ||
      handle.closest('[inert]')
    )
      return null;
    if (visible(terminal)) return terminal;
    if (visible(textarea) && !textarea.disabled && !textarea.readOnly)
      return textarea;
    return null;
  }
  function limits(element) {
    const style = window.getComputedStyle(element);
    const min = pixels(style.minHeight);
    let spare =
      inspector.getBoundingClientRect().bottom -
      pixels(window.getComputedStyle(inspector).borderBottomWidth) -
      pixels(window.getComputedStyle(inspector).paddingBottom) -
      slot.getBoundingClientRect().bottom;
    for (const body of inspector.querySelectorAll(':scope > .inspector-body')) {
      if (!body.getClientRects().length) continue;
      const bodyStyle = window.getComputedStyle(body);
      const padding =
        pixels(bodyStyle.paddingTop) +
        pixels(bodyStyle.paddingBottom) +
        pixels(bodyStyle.borderTopWidth) +
        pixels(bodyStyle.borderBottomWidth);
      const minimum = Math.max(pixels(bodyStyle.minHeight), padding);
      spare += Math.max(0, body.getBoundingClientRect().height - minimum);
    }
    const available = Math.max(
      min,
      element.getBoundingClientRect().height + spare,
    );
    const max = Math.max(
      min,
      Math.min(available, pixels(style.maxHeight, available)),
    );
    return {min, max, available};
  }
  function apply(element, height) {
    const {min, max} = limits(element);
    const next = Math.round(Math.max(min, Math.min(max, height)));
    if (element === textarea) resizeTextarea(textarea, next);
    else setTerminalHeight(next);
    schedule();
  }
  function applyDrag(element) {
    if (!drag || element !== drag.element || drag.latestY === drag.appliedY)
      return;
    drag.appliedY = drag.latestY;
    apply(element, drag.height + drag.y - drag.latestY);
  }
  function sync() {
    if (disposed) return;
    const element = target();
    if (drag && element !== drag.element) finish(false);
    else applyDrag(element);
    handle.setAttribute('aria-disabled', String(!element));
    handle.tabIndex = element ? 0 : -1;
    if (!element) return;
    let bounds = limits(element);
    const property =
      element === terminal
        ? '--composer-terminal-max-height'
        : '--composer-prompt-max-height';
    const max = `${Math.floor(bounds.available)}px`;
    if (element.style.getPropertyValue(property) !== max)
      element.style.setProperty(property, max);
    bounds = limits(element);
    const height = element.getBoundingClientRect().height;
    handle.setAttribute('aria-controls', element.id);
    handle.setAttribute('aria-valuemin', String(Math.round(bounds.min)));
    handle.setAttribute('aria-valuemax', String(Math.round(bounds.max)));
    handle.setAttribute('aria-valuenow', String(Math.round(height)));
    handle.setAttribute(
      'aria-valuetext',
      `${element === terminal ? 'Terminal' : 'Message field'} height ${Math.round(height)} pixels`,
    );
  }
  function schedule() {
    if (!disposed && frame === undefined)
      frame = window.requestAnimationFrame(() => {
        // Keep schedule() calls during sync covered by the current frame.
        try {
          sync();
        } finally {
          frame = undefined;
        }
      });
  }
  function finish(restore) {
    if (!drag) return;
    const previous = drag;
    if (!restore && previous.latestY !== previous.appliedY) applyDrag(target());
    drag = undefined;
    handle.classList.remove('dragging');
    if (document.body.dataset.panelResizing === 'y')
      delete document.body.dataset.panelResizing;
    if (restore && target() === previous.element) {
      if (previous.element === textarea)
        resizeTextarea(textarea, previous.textareaHeight);
      else setTerminalHeight(previous.terminalHeight);
    } else if (previous.element === terminal) persistTerminalHeight();
    if (handle.hasPointerCapture(previous.pointerId))
      handle.releasePointerCapture(previous.pointerId);
    schedule();
  }
  function pointerdown(event) {
    if (
      drag ||
      event.button !== 0 ||
      event.isPrimary === false ||
      document.body.dataset.panelResizing
    )
      return;
    const element = target();
    if (!element) return;
    event.preventDefault();
    handle.focus({preventScroll: true});
    drag = {
      element,
      pointerId: event.pointerId,
      y: event.clientY,
      latestY: event.clientY,
      appliedY: event.clientY,
      height: element.getBoundingClientRect().height,
      textareaHeight: textarea.style.height,
      terminalHeight,
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.body.dataset.panelResizing = 'y';
  }
  function pointermove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.latestY = event.clientY;
    schedule();
  }
  function pointerup(event) {
    if (event.pointerId !== drag?.pointerId) return;
    drag.latestY = event.clientY;
    finish(false);
  }
  function cancelPointer(event) {
    if (event.pointerId === drag?.pointerId) finish(true);
  }
  function cancel() {
    finish(true);
  }
  function escape(event) {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(true);
  }
  function keydown(event) {
    if (event.key === 'Enter') {
      reset(event);
      return;
    }
    if (
      !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(
        event.key,
      )
    )
      return;
    const element = target();
    if (!element) return;
    event.preventDefault();
    if (drag) finish(false);
    const {min, max} = limits(element);
    const step = event.key.startsWith('Page') || event.shiftKey ? 48 : 16;
    let height = element.getBoundingClientRect().height;
    if (event.key === 'Home') height = min;
    else if (event.key === 'End') height = max;
    else height += ['ArrowUp', 'PageUp'].includes(event.key) ? step : -step;
    apply(element, height);
    if (element === terminal) persistTerminalHeight();
  }
  function reset(event) {
    const element = target();
    if (!element) return;
    event.preventDefault();
    if (drag) finish(false);
    if (element === terminal) {
      setTerminalHeight(undefined);
      persistTerminalHeight();
    } else resizeTextarea(textarea, undefined);
    schedule();
  }

  function resetAll() {
    finish(true);
    setTerminalHeight(undefined);
    persistTerminalHeight();
    terminal.style.removeProperty('--composer-terminal-max-height');
    textarea.style.removeProperty('--composer-prompt-max-height');
    resetTextareaSizes();
    schedule();
  }

  const listeners = [
    [document, 'varisdev:panel-layout-reset', resetAll],
    [handle, 'pointerdown', pointerdown],
    [handle, 'pointermove', pointermove],
    [handle, 'pointerup', pointerup],
    [handle, 'pointercancel', cancelPointer],
    [handle, 'lostpointercapture', cancelPointer],
    [handle, 'keydown', keydown],
    [handle, 'dblclick', reset],
    [window, 'blur', cancel],
    [window, 'resize', schedule],
    [window, 'keydown', escape, true],
  ];
  for (const [node, event, listener, capture] of listeners)
    node.addEventListener(event, listener, capture);
  const resize = new window.ResizeObserver(schedule);
  for (const element of new Set([
    inspector,
    slot,
    controls,
    textarea,
    terminal,
    ...inspector.children,
  ]))
    if (element !== measure) resize.observe(element);
  const mutations = new window.MutationObserver(schedule);
  for (const element of [
    slot,
    controls,
    textarea,
    terminal,
    document.getElementById('prompt-panel'),
    document.getElementById('terminal-panel'),
  ])
    if (element)
      mutations.observe(element, {
        attributes: true,
        attributeFilter: ['hidden', 'class', 'style', 'disabled', 'readonly'],
      });
  sync();
  return () => {
    finish(true);
    disposed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    resize.disconnect();
    mutations.disconnect();
    for (const [node, event, listener, capture] of listeners)
      node.removeEventListener(event, listener, capture);
    measure.remove();
    terminal.style.removeProperty('--composer-terminal-max-height');
    terminal.style.removeProperty('--composer-terminal-height');
    textarea.style.removeProperty('--composer-prompt-max-height');
  };
}
