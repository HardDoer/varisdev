/* global document, window */

export function initLiveView() {
  const panel = document.getElementById('factory-panel');
  const expand = document.getElementById('expand-live-view');
  const info = document.getElementById('factory-info');
  const infoButton = document.getElementById('factory-info-button');
  const actions = panel.querySelector('.factory-file-actions');
  const drawer = document.getElementById('factory-agents-drawer');
  const drawerButton = document.getElementById('factory-agents-button');
  const workers = document.querySelector('.worker-panels');
  const home = panel.parentElement;
  let inertNodes = [];
  let expanded = false;
  let sessionId;

  function placeInfo() {
    const {width, height} = panel.getBoundingClientRect();
    if (!width || !height) return;
    // Reserve room for the scene after the header and its wrapping controls.
    const collapsed = height < (width > 540 ? 440 : 420);
    if (info.hasAttribute('popover') === collapsed) return;
    const focused = document.activeElement;
    closeInfo();
    infoButton.hidden = !collapsed;
    if (collapsed) {
      info.setAttribute('popover', 'auto');
      info.setAttribute('role', 'dialog');
      if (info.contains(focused)) infoButton.focus({preventScroll: true});
    } else {
      info.removeAttribute('popover');
      info.removeAttribute('role');
      if (focused === infoButton) expand.focus({preventScroll: true});
      else if (info.contains(focused)) focused.focus({preventScroll: true});
    }
  }
  const resize = new window.ResizeObserver(() => {
    placeWorkers();
    placeInfo();
  });
  resize.observe(home);
  resize.observe(panel);

  function syncInfo() {
    infoButton.setAttribute(
      'aria-expanded',
      String(info.matches(':popover-open')),
    );
  }
  function closeInfo() {
    if (info.matches(':popover-open')) info.hidePopover();
    syncInfo();
  }
  function syncDrawer() {
    drawerButton.setAttribute(
      'aria-expanded',
      String(drawer.matches(':popover-open')),
    );
  }
  function closeDrawer() {
    if (drawer.matches(':popover-open')) drawer.hidePopover();
    syncDrawer();
  }
  function placeWorkers() {
    const {width, height} = home.getBoundingClientRect();
    if (!width || !height) return;
    const collapsed = height < 600;
    if (home.classList.contains('compact-workers') === collapsed) return;
    closeDrawer();
    home.classList.toggle('compact-workers', collapsed);
    drawerButton.hidden = !collapsed;
    if (collapsed) drawer.append(workers);
    else home.insertBefore(workers, drawerButton);
  }
  function syncExpanded() {
    const label = expanded ? 'Restore live view' : 'Expand live view';
    expand.setAttribute('aria-expanded', String(expanded));
    expand.setAttribute('aria-label', label);
    expand.title = label;
  }
  function restore() {
    if (!expanded) return;
    closeInfo();
    expanded = false;
    panel.hidePopover();
    panel.removeAttribute('popover');
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.classList.remove('live-view-expanded');
    for (const entry of inertNodes) entry.element.inert = entry.inert;
    inertNodes = [];
    syncExpanded();
    if (expand.checkVisibility()) expand.focus({preventScroll: true});
  }
  function close() {
    closeDrawer();
    closeInfo();
    restore();
  }
  function toggle() {
    if (expanded) {
      close();
      return;
    }
    closeInfo();
    expanded = true;
    let current = panel;
    while (current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current) continue;
        inertNodes.push({element: sibling, inert: sibling.inert});
        sibling.inert = true;
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    panel.classList.add('live-view-expanded');
    panel.setAttribute('popover', 'manual');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.showPopover();
    syncExpanded();
    expand.focus({preventScroll: true});
  }
  function escapeInfo(event) {
    if (event.key !== 'Escape') return;
    const infoOpen = info.matches(':popover-open');
    const drawerOpen = drawer.matches(':popover-open');
    if (!infoOpen && !drawerOpen && !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    if (infoOpen) {
      closeInfo();
      infoButton.focus({preventScroll: true});
    } else if (drawerOpen) {
      closeDrawer();
      drawerButton.focus({preventScroll: true});
    } else close();
  }
  function openAction(event) {
    if (!event.target.closest('button')) return;
    // File panels and session errors belong to the main workspace.
    close();
  }
  expand.addEventListener('click', toggle);
  info.addEventListener('toggle', syncInfo);
  drawer.addEventListener('toggle', syncDrawer);
  actions.addEventListener('click', openAction, true);
  document.addEventListener('keydown', escapeInfo, true);

  return {
    close,
    setSession(id) {
      if (sessionId === id) return;
      close();
      sessionId = id;
    },
    dispose() {
      close();
      resize.disconnect();
      expand.removeEventListener('click', toggle);
      info.removeEventListener('toggle', syncInfo);
      drawer.removeEventListener('toggle', syncDrawer);
      actions.removeEventListener('click', openAction, true);
      document.removeEventListener('keydown', escapeInfo, true);
    },
  };
}
