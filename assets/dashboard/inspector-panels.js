/* global document, window, CustomEvent */

const STORAGE_KEY = 'varisdev.inspector-panels.v1';
const LABELS = {
  conversation: 'Conversation',
  details: 'Details',
  feed: 'Live feed',
  changes: 'Changes',
  tokens: 'Tokens',
  context: 'Context',
  speed: 'Speed',
};
const DEFAULT_ORDER = Object.keys(LABELS);
const element = (tag, className, text) => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
};

export function initInspectorPanels({selected, select, changed}) {
  const workspace = document.getElementById('factory-workspace');
  const inspector = document.getElementById('inspector');
  const tabs = inspector.querySelector('.inspector-tabs');
  const bodyAnchor = document.getElementById('cancel-all-agents-error');
  const options = document.querySelector('.app-menu-layout-controls');
  const listeners = [];
  let order = [...DEFAULT_ORDER];
  let detached = [];
  let drag;
  let suppressClick = false;
  let contextTarget;
  let drawerPanel;
  const entries = new Map();
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.order))
      order = [...new Set([...saved.order, ...order])].filter(
        key => LABELS[key],
      );
    if (Array.isArray(saved?.detached))
      detached = [...new Set(saved.detached)].filter(key =>
        DEFAULT_ORDER.includes(key),
      );
  } catch {
    // Keep panel controls available when preference storage is unavailable.
  }
  const rack = element('section', 'inspector-panel-rack');
  rack.id = 'inspector-panel-rack';
  rack.setAttribute('aria-label', 'Inspector panels');
  const resize = element('div', 'panel-resize-handle');
  resize.id = 'detached-resize';
  resize.tabIndex = 0;
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-label', 'Resize inspector panels');
  resize.setAttribute('aria-orientation', 'vertical');
  resize.setAttribute('aria-controls', rack.id);
  workspace.append(resize, rack);
  const buttons = element('div', 'inspector-panel-buttons');
  buttons.setAttribute('aria-label', 'Panels');
  tabs.before(buttons);
  const empty = element('div', 'inspector-panels-empty');
  empty.setAttribute('aria-hidden', 'true');
  bodyAnchor.before(empty);
  const drawer = element('section', 'inspector-panel-drawer');
  drawer.id = 'inspector-panel-drawer';
  drawer.setAttribute('popover', 'auto');
  drawer.setAttribute('aria-label', 'Inspector panel');
  document.body.append(drawer);
  const menu = element('div', 'panel-context-menu');
  menu.id = 'panel-context-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Panel actions');
  const minify = element('button', 'quiet-button', 'Minify');
  minify.type = 'button';
  minify.setAttribute('role', 'menuitem');
  menu.append(minify);
  document.body.append(menu);

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  }
  function save() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({order, detached}),
      );
    } catch {
      // The arrangement still applies to this window.
    }
  }
  function closeDrawer() {
    const entry = entries.get(drawerPanel);
    if (entry?.body.checkVisibility()) entry.scrollTop = entry.body.scrollTop;
    if (drawer.matches(':popover-open')) drawer.hidePopover();
    if (entry) {
      const following = detached[detached.indexOf(drawerPanel) + 1];
      rack.insertBefore(
        entry.panel,
        following ? entries.get(following).panel : null,
      );
      entry.button.setAttribute('aria-expanded', 'false');
      drawerPanel = undefined;
    }
  }
  function openDrawer(key) {
    closeDrawer();
    const entry = entries.get(key);
    drawerPanel = key;
    drawer.append(entry.panel);
    drawer.showPopover({source: entry.button});
    if (entry.scrollTop !== undefined) entry.body.scrollTop = entry.scrollTop;
    entry.button.setAttribute('aria-expanded', 'true');
    entry.close.focus({preventScroll: true});
    changed();
  }
  function restoreScrollPositions() {
    for (const entry of entries.values())
      if (entry.scrollTop !== undefined && entry.body.checkVisibility())
        entry.body.scrollTop = entry.scrollTop;
  }
  function selectLayoutTab(key) {
    select(key, {preserveScroll: true});
    restoreScrollPositions();
    changed();
  }
  function apply() {
    for (const entry of entries.values())
      if (entry.body.checkVisibility()) entry.scrollTop = entry.body.scrollTop;
    closeDrawer();
    for (const key of order) {
      const entry = entries.get(key);
      const separate = detached.includes(key);
      tabs.append(entry.tab);
      entry.tab.toggleAttribute('data-detached', separate);
      entry.input.checked = separate;
      entry.button.hidden = !separate;
      if (separate) {
        if (entry.body.parentElement !== entry.panel)
          entry.panel.append(entry.body);
        entry.body.setAttribute('role', 'region');
        entry.body.setAttribute('aria-labelledby', entry.heading.id);
      } else {
        if (entry.body.parentElement !== inspector)
          bodyAnchor.before(entry.body);
        entry.body.setAttribute('role', 'tabpanel');
        entry.body.setAttribute('aria-labelledby', entry.tab.id);
      }
      entry.panel.hidden = !separate;
    }
    for (const key of detached) rack.append(entries.get(key).panel);
    workspace.classList.toggle('has-inspector-panels', detached.length > 0);
    rack.hidden = resize.hidden = buttons.hidden = detached.length === 0;
    empty.hidden = order.some(key => !detached.includes(key));
    // The selected view can remain open in a separate panel; keep a docked tab active too.
    if (detached.includes(selected())) {
      const next = order.find(
        key => !detached.includes(key) && !entries.get(key).tab.hidden,
      );
      if (next) select(next, {preserveScroll: true});
    }
    sync();
    restoreScrollPositions();
    document.dispatchEvent(new CustomEvent('varisdev:panel-layout'));
    changed();
  }
  function sync() {
    for (const [key, entry] of entries) {
      const separate = detached.includes(key);
      entry.body.hidden = separate ? false : selected() !== key;
      entry.tab.setAttribute(
        'aria-selected',
        String(!separate && selected() === key),
      );
      entry.tab.tabIndex = !separate && selected() === key ? 0 : -1;
    }
  }
  function detach(key) {
    if (!detached.includes(key)) detached.push(key);
    save();
    apply();
  }
  function dock(key) {
    detached = detached.filter(value => value !== key);
    save();
    apply();
    selectLayoutTab(key);
    entries.get(key).tab.focus({preventScroll: true});
  }
  for (const key of DEFAULT_ORDER) {
    const tab = document.getElementById(`tab-${key}`);
    const body = document.getElementById(`panel-${key}`);
    tab.dataset.inspectorTab = key;
    tab.title = 'Drag to reorder or move into the workspace';
    const panel = element('section', 'detached-inspector-panel');
    panel.dataset.inspectorPanel = key;
    panel.setAttribute('aria-label', LABELS[key]);
    const header = element('div', 'detached-panel-heading');
    header.tabIndex = 0;
    header.dataset.inspectorDrag = key;
    header.title = 'Drag to arrange panels or return to the tab bar';
    const heading = element('h2', '', LABELS[key]);
    heading.id = `detached-title-${key}`;
    const close = element(
      'button',
      'quiet-button detached-panel-close',
      'Close',
    );
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${LABELS[key]} drawer`);
    header.append(heading, close);
    panel.append(header);
    rack.append(panel);
    const button = element('button', 'quiet-button', LABELS[key]);
    button.id = `open-panel-${key}`;
    button.type = 'button';
    button.setAttribute('aria-controls', drawer.id);
    button.setAttribute('aria-expanded', 'false');
    buttons.append(button);
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.id = `layout-${key}`;
    label.append(input, document.createTextNode(`${LABELS[key]} panel`));
    options.append(label);
    entries.set(key, {
      tab,
      body,
      panel,
      header,
      heading,
      close,
      button,
      input,
      label,
    });
    listen(input, 'change', () => (input.checked ? detach(key) : dock(key)));
    listen(body, 'scroll', () => {
      if (body.checkVisibility()) entries.get(key).scrollTop = body.scrollTop;
    });
    listen(button, 'click', () => openDrawer(key));
    listen(close, 'click', () => {
      closeDrawer();
      button.focus({preventScroll: true});
    });
  }
  function finish(event, cancel = false) {
    if (!drag || (event.pointerId && event.pointerId !== drag.pointerId))
      return;
    const previous = drag;
    drag = undefined;
    delete document.body.dataset.inspectorDragging;
    workspace.classList.remove('inspector-drop-target');
    tabs.classList.remove('inspector-drop-target');
    if (previous.source.hasPointerCapture(previous.pointerId))
      previous.source.releasePointerCapture(previous.pointerId);
    if (!previous.moved) return;
    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);
    if (cancel) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target?.closest('.inspector-tabs')) {
      const next = target.closest('[data-inspector-tab]');
      if (next && next.dataset.inspectorTab !== previous.key) {
        order = order.filter(key => key !== previous.key);
        const bounds = next.getBoundingClientRect();
        order.splice(
          order.indexOf(next.dataset.inspectorTab) +
            (event.clientX > bounds.left + bounds.width / 2 ? 1 : 0),
          0,
          previous.key,
        );
      }
      detached = detached.filter(key => key !== previous.key);
      save();
      apply();
      selectLayoutTab(previous.key);
    } else if (target?.closest('#factory-workspace, #inspector-panel-drawer')) {
      const next = target.closest('[data-inspector-panel]')?.dataset
        .inspectorPanel;
      if (next === previous.key) return;
      detached = detached.filter(key => key !== previous.key);
      const index = next ? detached.indexOf(next) : -1;
      if (index < 0) detached.push(previous.key);
      else detached.splice(index, 0, previous.key);
      save();
      apply();
    }
  }
  listen(document, 'pointerdown', event => {
    const source = event.target.closest(
      '[data-inspector-tab], [data-inspector-drag]',
    );
    if (
      !source ||
      event.button !== 0 ||
      event.isPrimary === false ||
      event.target.closest('.detached-panel-close')
    )
      return;
    drag = {
      key: source.dataset.inspectorTab || source.dataset.inspectorDrag,
      source,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    source.setPointerCapture(event.pointerId);
  });
  listen(document, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6
    )
      return;
    drag.moved = true;
    document.body.dataset.inspectorDragging = 'true';
    const overTabs = Boolean(
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('.inspector-tabs'),
    );
    tabs.classList.toggle('inspector-drop-target', overTabs);
    workspace.classList.toggle('inspector-drop-target', !overTabs);
  });
  listen(document, 'pointerup', event => finish(event));
  listen(document, 'pointercancel', event => finish(event, true));
  listen(document, 'lostpointercapture', event => finish(event, true));
  listen(window, 'blur', () => finish({}, true));
  listen(
    document,
    'click',
    event => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  function closeMenu(focus = false) {
    if (menu.matches(':popover-open')) menu.hidePopover();
    if (focus) contextTarget?.focus({preventScroll: true});
  }
  function openMenu(source, point) {
    contextTarget = source;
    menu.showPopover({source});
    const bounds = source.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(point?.x ?? bounds.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point?.y ?? bounds.bottom, window.innerHeight - menu.offsetHeight - 8))}px`;
    minify.focus({preventScroll: true});
  }
  const panelSelector =
    '.detached-inspector-panel, #factory-panel, #workspaces-panel, #worker-panels';
  listen(document, 'contextmenu', event => {
    if (event.defaultPrevented) return;
    const panel = event.target.closest(panelSelector);
    if (!panel) return;
    event.preventDefault();
    openMenu(
      panel.querySelector(
        '.detached-panel-heading, .factory-title-group, .section-heading',
      ) || panel,
      {x: event.clientX, y: event.clientY},
    );
  });
  listen(minify, 'click', () => {
    const panel = contextTarget.closest(panelSelector);
    closeMenu();
    if (panel.dataset.inspectorPanel) dock(panel.dataset.inspectorPanel);
    else {
      const key = {
        'factory-panel': 'visualization',
        'workspaces-panel': 'workspaces',
        'worker-panels': 'agents',
      }[panel.id];
      const input = document.getElementById(`layout-${key}`);
      input.checked = false;
      input.dispatchEvent(new CustomEvent('change', {bubbles: true}));
      document.getElementById('app-menu-button').focus({preventScroll: true});
    }
  });
  listen(
    document,
    'keydown',
    event => {
      if (event.key === 'Escape' && drag) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(event, true);
        return;
      }
      if (
        menu.matches(':popover-open') &&
        ['Escape', 'Tab'].includes(event.key)
      ) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        closeMenu(true);
      } else if (event.key === 'Escape' && drawer.matches(':popover-open')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const opener = entries.get(drawerPanel)?.button;
        closeDrawer();
        opener?.focus({preventScroll: true});
      } else if (
        event.key === 'ContextMenu' ||
        (event.shiftKey && event.key === 'F10')
      ) {
        const source = event.target.closest('.detached-panel-heading');
        if (source) {
          event.preventDefault();
          openMenu(source);
        }
      }
    },
    true,
  );
  listen(drawer, 'beforetoggle', event => {
    const entry = entries.get(drawerPanel);
    if (event.newState === 'closed' && entry?.body.checkVisibility())
      entry.scrollTop = entry.body.scrollTop;
  });
  listen(drawer, 'toggle', () => {
    if (!drawer.matches(':popover-open')) closeDrawer();
  });
  listen(window, 'resize', () => {
    closeMenu();
    closeDrawer();
    restoreScrollPositions();
    changed();
  });
  listen(document, 'varisdev:panel-layout-reset', () => {
    order = [...DEFAULT_ORDER];
    detached = [];
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* Storage may be unavailable. */
    }
    apply();
    selectLayoutTab('conversation');
  });
  apply();
  return {
    sync,
    resetScroll() {
      for (const entry of entries.values()) {
        entry.scrollTop = 0;
        entry.body.scrollTop = 0;
      }
    },
    close() {
      closeMenu();
      closeDrawer();
    },
    isDetached: key => detached.includes(key),
    tabs: () =>
      order.filter(
        key => !detached.includes(key) && !entries.get(key).tab.hidden,
      ),
    reveal(key) {
      if (
        detached.includes(key) &&
        window.getComputedStyle(buttons).display !== 'none'
      )
        openDrawer(key);
    },
    dispose() {
      closeDrawer();
      closeMenu();
      for (const remove of listeners) remove();
      for (const entry of entries.values()) {
        bodyAnchor.before(entry.body);
        entry.tab.removeAttribute('data-detached');
        entry.label.remove();
      }
      rack.remove();
      resize.remove();
      buttons.remove();
      empty.remove();
      drawer.remove();
      menu.remove();
    },
  };
}
