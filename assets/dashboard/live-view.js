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
  const compact = window.matchMedia('(max-width: 950px), (max-height: 700px)');
  const home = panel.parentElement;
  let inertNodes = [];
  let expanded = false;
  let sessionId;

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
    closeDrawer();
    drawerButton.hidden = !compact.matches;
    if (compact.matches) drawer.append(workers);
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
  compact.addEventListener('change', placeWorkers);
  placeWorkers();
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
      expand.removeEventListener('click', toggle);
      info.removeEventListener('toggle', syncInfo);
      drawer.removeEventListener('toggle', syncDrawer);
      compact.removeEventListener('change', placeWorkers);
      actions.removeEventListener('click', openAction, true);
      document.removeEventListener('keydown', escapeInfo, true);
    },
  };
}
