/* global document, window */

export function initLiveView() {
  const panel = document.getElementById('factory-panel');
  const info = document.getElementById('factory-info');
  const infoButton = document.getElementById('factory-info-button');
  const actions = panel.querySelector('.factory-file-actions');
  const drawer = document.getElementById('factory-agents-drawer');
  const drawerButton = document.getElementById('factory-agents-button');
  const workers = document.querySelector('.worker-panels');
  const home = panel.parentElement;
  const heading = panel.querySelector('.factory-heading');
  const viewActions = panel.querySelector('.factory-view-actions');
  const inspectorHeading = document.querySelector('.inspector-heading');
  const inspectorControls = document.querySelector('.inspector-unit-controls');
  let sessionId;

  function placeInfo() {
    const {width, height} = panel.getBoundingClientRect();
    if (!panel.hidden && (!width || !height)) return;
    const nextInfoHome = panel.hidden ? inspectorHeading : heading;
    const nextButtonHome = panel.hidden ? inspectorControls : viewActions;
    const moved = info.parentElement !== nextInfoHome;
    if (moved) {
      closeInfo();
      nextInfoHome.append(info);
      nextButtonHome.append(infoButton);
    }
    // Reserve room for the scene after the header and its wrapping controls.
    const collapsed = panel.hidden || height < (width > 540 ? 440 : 420);
    if (!moved && info.hasAttribute('popover') === collapsed) return;
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
      if (focused === infoButton)
        actions.querySelector('button')?.focus({preventScroll: true});
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
    const collapsed =
      !panel.hidden && !workers.hidden && (height < 600 || width < 300);
    if (home.classList.contains('compact-workers') === collapsed) return;
    closeDrawer();
    home.classList.toggle('compact-workers', collapsed);
    drawerButton.hidden = !collapsed;
    if (collapsed) drawer.append(workers);
    else home.insertBefore(workers, drawerButton);
  }
  function layoutChanged() {
    closeDrawer();
    placeWorkers();
    placeInfo();
  }
  document.addEventListener('varisdev:panel-layout', layoutChanged);
  function close() {
    closeDrawer();
    closeInfo();
  }
  function escapeInfo(event) {
    if (event.key !== 'Escape') return;
    const infoOpen = info.matches(':popover-open');
    const drawerOpen = drawer.matches(':popover-open');
    if (!infoOpen && !drawerOpen) return;
    event.preventDefault();
    event.stopPropagation();
    if (infoOpen) {
      closeInfo();
      infoButton.focus({preventScroll: true});
    } else {
      closeDrawer();
      drawerButton.focus({preventScroll: true});
    }
  }
  function openAction(event) {
    if (!event.target.closest('button')) return;
    // File panels and session errors belong to the main workspace.
    close();
  }
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
      document.removeEventListener('varisdev:panel-layout', layoutChanged);
      info.removeEventListener('toggle', syncInfo);
      drawer.removeEventListener('toggle', syncDrawer);
      actions.removeEventListener('click', openAction, true);
      document.removeEventListener('keydown', escapeInfo, true);
    },
  };
}
