/* global document, window */

const STORAGE_KEY = 'varisdev.panel-sizes.v1';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function initPanelResize() {
  const workspace = document.getElementById('factory-workspace');
  const column = document.querySelector('.factory-column');
  const overview = document.querySelector('.overview');
  const workers = document.querySelector('.worker-panels');
  const inspector = document.getElementById('inspector');
  const factory = document.getElementById('factory-panel');
  const scene = document.getElementById('scene');
  const sizes = {};
  const listeners = [];
  let frame;
  let drag;
  let disposed = false;

  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    for (const key of [
      'conversation',
      'workspaces',
      'agents',
      'history',
      'detached',
    ])
      if (typeof saved?.[key] === 'number' && saved[key] > 0 && saved[key] < 1)
        sizes[key] = saved[key];
  } catch {
    // Resizing remains available when preference storage is unavailable.
  }

  function listen(target, type, callback, options) {
    target.addEventListener(type, callback, options);
    listeners.push(() => target.removeEventListener(type, callback, options));
  }
  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // Keep the chosen sizes for this window.
    }
  }
  function setSize(element, property, value) {
    const next = value === undefined ? '' : `${value.toFixed(2)}px`;
    if (element.style.getPropertyValue(property) !== next)
      element.style.setProperty(property, next);
  }

  function visible(element) {
    return element.getClientRects().length > 0;
  }
  function factoryMinimum() {
    if (!visible(factory)) return 0;
    const heading = factory.querySelector('.factory-heading');
    const info = document.getElementById('factory-info');
    let chrome = factory.offsetHeight - scene.offsetHeight;
    if (heading.contains(info) && !info.hasAttribute('popover')) {
      chrome -=
        info.offsetHeight +
        Number.parseFloat(window.getComputedStyle(heading).rowGap);
      chrome += Math.max(
        0,
        32 - heading.querySelector('.factory-title-group').offsetHeight,
      );
    }
    return Math.ceil(chrome + 120);
  }
  function overviewMinimum() {
    return Math.min(
      100,
      overview.querySelector('.section-heading').offsetHeight + 42,
    );
  }
  function dividerHeight(id) {
    const handle = document.getElementById(id);
    return visible(handle) ? handle.offsetHeight : 0;
  }

  const splits = [
    {
      key: 'detached',
      axis: 'x',
      direction: -1,
      measure() {
        const total = workspace.clientWidth;
        return {
          total,
          min: 240,
          max: Math.max(240, total - (visible(column) ? 240 : 0) - 344),
          value: document
            .getElementById('inspector-panel-rack')
            .getBoundingClientRect().width,
        };
      },
      apply(value) {
        setSize(workspace, '--detached-width', value);
      },
    },
    {
      key: 'conversation',
      axis: 'x',
      measure() {
        const rack = document.getElementById('inspector-panel-rack');
        const divider = document.getElementById('detached-resize');
        const total =
          workspace.clientWidth -
          this.handle.offsetWidth -
          (visible(rack) ? rack.offsetWidth + divider.offsetWidth : 0);
        return {
          total,
          min: Math.min(240, total * 0.4),
          max: total - Math.min(320, total * 0.5),
          value: column.getBoundingClientRect().width,
        };
      },
      apply(value) {
        setSize(workspace, '--factory-width', value);
      },
    },
    {
      key: 'workspaces',
      axis: 'y',
      measure() {
        const total = column.clientHeight;
        const button = document.getElementById('factory-agents-button');
        const others = visible(button)
          ? button.offsetHeight + 6
          : visible(workers) && workers.parentElement === column
            ? 148
            : 0;
        const dividers =
          dividerHeight('workspaces-resize') + dividerHeight('agents-resize');
        const min = overviewMinimum();
        return {
          total,
          min,
          max: Math.max(min, total - others - dividers - factoryMinimum()),
          value: overview.getBoundingClientRect().height,
        };
      },
      apply(value) {
        setSize(column, '--workspaces-height', value);
        overview.classList.toggle('resized', value !== undefined);
      },
    },
    {
      key: 'agents',
      axis: 'y',
      direction: -1,
      measure() {
        const total = column.clientHeight;
        return {
          total,
          min: 148,
          max: Math.max(
            148,
            total -
              (visible(overview) ? overviewMinimum() : 0) -
              dividerHeight('workspaces-resize') -
              dividerHeight('agents-resize') -
              factoryMinimum(),
          ),
          value: workers.getBoundingClientRect().height,
        };
      },
      apply(value) {
        setSize(column, '--agents-height', value);
      },
    },
    {
      key: 'history',
      axis: 'x',
      measure() {
        const total = workers.clientWidth - this.handle.offsetWidth;
        const min = Math.min(140, total * 0.4);
        return {
          total,
          min,
          max: total - min,
          value: workers.firstElementChild.getBoundingClientRect().width,
        };
      },
      apply(value) {
        setSize(workers, '--active-agents-width', value);
      },
    },
  ];

  function sizeRows(priority) {
    const rows = splits.filter(split => split.axis === 'y');
    if (!rows.every(split => visible(split.handle))) return false;
    // A sibling can recover space if the pointer reverses within one drag.
    const preferred = rows.map(row =>
      drag && drag.split === priority && row !== priority
        ? drag.previous[row.key]
        : sizes[row.key],
    );
    // Measure automatic rows without a temporary clamp from a smaller window.
    for (const [index, row] of rows.entries())
      if (preferred[index] === undefined) row.apply(undefined);
    const bounds = rows.map(row => row.measure());
    const values = rows.map((_row, index) => {
      const {total, min, max, value} = bounds[index];
      return clamp(
        preferred[index] === undefined ? value : preferred[index] * total,
        min,
        max,
      );
    });
    const first = priority === rows[1] ? 1 : 0;
    const second = 1 - first;
    const budget = bounds[0].max + bounds[1].min;
    values[second] = Math.max(
      bounds[second].min,
      Math.min(values[second], budget - values[first]),
    );
    for (const [index, row] of rows.entries()) {
      if (priority?.axis === 'y') {
        if (
          preferred[index] === undefined &&
          values[index] === bounds[index].value
        )
          delete sizes[row.key];
        else sizes[row.key] = values[index] / bounds[index].total;
      }
      row.apply(
        sizes[row.key] === undefined && values[index] === bounds[index].value
          ? undefined
          : values[index],
      );
    }
    return true;
  }

  function refresh(priority) {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    if (disposed || !workspace.getClientRects().length) return;
    if (drag?.pending !== undefined) {
      const {split, pending} = drag;
      drag.pending = undefined;
      const bounds = split.measure();
      if (bounds.total > 0)
        sizes[split.key] =
          clamp(pending, bounds.min, bounds.max) / bounds.total;
      priority = split;
    }
    let rowsSized = false;
    for (const split of splits) {
      if (!split.handle.getClientRects().length) {
        if (drag?.split === split) finish(false);
        continue;
      }
      if (split.key === 'workspaces') rowsSized = sizeRows(priority);
      let bounds = split.measure();
      if (bounds.total <= 0) continue;
      if (split.axis !== 'y' || !rowsSized) {
        const saved = sizes[split.key];
        split.apply(
          saved === undefined
            ? undefined
            : clamp(saved * bounds.total, bounds.min, bounds.max),
        );
      }
      bounds = split.measure();
      const percent = value => String(Math.round((100 * value) / bounds.total));
      split.handle.setAttribute('aria-valuemin', percent(bounds.min));
      split.handle.setAttribute('aria-valuemax', percent(bounds.max));
      split.handle.setAttribute('aria-valuenow', percent(bounds.value));
      split.handle.setAttribute(
        'aria-valuetext',
        `${Math.round(bounds.value)} pixels`,
      );
    }
  }
  function schedule() {
    if (!disposed && frame === undefined)
      frame = window.requestAnimationFrame(() => refresh());
  }
  function change(split, value) {
    const bounds = split.measure();
    if (bounds.total <= 0) return;
    sizes[split.key] = clamp(value, bounds.min, bounds.max) / bounds.total;
    refresh(split);
  }
  function finish(commit) {
    if (!drag) return;
    // A release may arrive before the frame that applies the final movement.
    if (commit && drag.pending !== undefined) refresh();
    if (!drag) return;
    const {split, previous, pointerId} = drag;
    drag = undefined;
    if (commit) save();
    else {
      for (const key of Object.keys(sizes)) delete sizes[key];
      Object.assign(sizes, previous);
      refresh();
    }
    delete document.body.dataset.panelResizing;
    if (split.handle.hasPointerCapture(pointerId))
      split.handle.releasePointerCapture(pointerId);
  }

  for (const split of splits) {
    const handle = document.getElementById(`${split.key}-resize`);
    split.handle = handle;
    const reset = () => {
      finish(false);
      delete sizes[split.key];
      refresh();
      save();
    };
    listen(handle, 'pointerdown', event => {
      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        drag ||
        document.body.dataset.panelResizing
      )
        return;
      event.preventDefault();
      handle.focus({preventScroll: true});
      drag = {
        split,
        previous: {...sizes},
        pointerId: event.pointerId,
        start: split.axis === 'x' ? event.clientX : event.clientY,
        moved: false,
        value: split.measure().value,
      };
      handle.setPointerCapture(event.pointerId);
      document.body.dataset.panelResizing = split.axis;
    });
    listen(handle, 'pointermove', event => {
      if (drag?.split !== split || event.pointerId !== drag.pointerId) return;
      const position = split.axis === 'x' ? event.clientX : event.clientY;
      drag.moved = true;
      drag.pending =
        drag.value + (position - drag.start) * (split.direction || 1);
      schedule();
    });
    listen(handle, 'pointerup', event => {
      if (event.pointerId !== drag?.pointerId) return;
      const position = split.axis === 'x' ? event.clientX : event.clientY;
      if (drag.moved || position !== drag.start)
        drag.pending =
          drag.value + (position - drag.start) * (split.direction || 1);
      finish(true);
    });
    listen(handle, 'pointercancel', () => finish(false));
    listen(handle, 'lostpointercapture', () => finish(false));
    listen(handle, 'dblclick', reset);
    listen(handle, 'keydown', event => {
      const backward = split.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const forward = split.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (![backward, forward, 'Home', 'End', 'Enter'].includes(event.key))
        return;
      event.preventDefault();
      if (event.key === 'Enter') return reset();
      const bounds = split.measure();
      const step = (event.shiftKey ? 48 : 16) * (split.direction || 1);
      change(
        split,
        event.key === 'Home'
          ? bounds.min
          : event.key === 'End'
            ? bounds.max
            : bounds.value + (event.key === forward ? step : -step),
      );
      save();
    });
  }
  listen(
    window,
    'keydown',
    event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      }
    },
    true,
  );
  listen(window, 'blur', () => finish(false));
  listen(document, 'varisdev:panel-layout', schedule);
  listen(document, 'varisdev:panel-layout-reset', () => {
    finish(false);
    for (const split of splits) {
      delete sizes[split.key];
      split.apply(undefined);
    }
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Keep the default sizes for this window.
    }
    schedule();
  });
  const observer = new window.ResizeObserver(schedule);
  for (const element of [
    workspace,
    column,
    overview,
    workers,
    inspector,
    factory,
    scene,
  ])
    observer.observe(element);
  schedule();

  return () => {
    disposed = true;
    finish(false);
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    for (const remove of listeners) remove();
  };
}
