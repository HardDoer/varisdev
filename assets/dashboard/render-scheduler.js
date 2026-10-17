/* global window, document */

// Collapse bursts into one paint, retaining a pending update while hidden.
export function createRenderScheduler(
  render,
  {
    requestFrame = callback => window.requestAnimationFrame(callback),
    cancelFrame = frame => window.cancelAnimationFrame(frame),
    isHidden = () => document.hidden,
  } = {},
) {
  let frame;
  let pending = false;
  let disposed = false;
  function cancel() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  }
  function flush() {
    cancel();
    if (disposed || !pending || isHidden()) return;
    pending = false;
    render();
  }
  function schedule() {
    if (disposed) return;
    pending = true;
    if (frame === undefined && !isHidden()) frame = requestFrame(flush);
  }
  return {
    schedule,
    rendered() {
      pending = false;
      cancel();
    },
    visibilityChanged() {
      if (isHidden()) cancel();
      else if (pending) schedule();
    },
    dispose() {
      disposed = true;
      pending = false;
      cancel();
    },
  };
}
