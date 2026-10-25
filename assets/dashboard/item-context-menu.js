/* global document, window */

export function initItemContextMenu({selected, select}) {
  const menu = document.getElementById('item-context-menu');
  const button = document.getElementById('item-actions-button');
  const title = document.getElementById('item-context-menu-title');
  const targetSelector =
    '[data-context-session], [data-context-unit], #inspector-title, #item-actions-button';
  let target;
  let origin;
  const key = item => item && `${item.sessionId}:${item.unitId}`;
  const isOpen = () => menu.matches(':popover-open');
  const items = () =>
    [...menu.querySelectorAll('[role="menuitem"]')].filter(
      item => !item.hidden && !item.disabled,
    );

  function focusOrigin() {
    const next =
      origin?.isConnected && origin.tabIndex >= 0 && origin.checkVisibility()
        ? origin
        : button.checkVisibility()
          ? button
          : document.getElementById('app-menu-button');
    next.focus({preventScroll: true});
  }
  function close(focus = false) {
    if (!isOpen()) return;
    menu.hidePopover();
    button.setAttribute('aria-expanded', 'false');
    if (focus) focusOrigin();
    target = undefined;
  }
  function sync() {
    const current = selected();
    if (isOpen() && key(target) !== key(current))
      close(menu.contains(document.activeElement));
    if (!current) return;
    title.textContent = current.name;
    button.setAttribute(
      'aria-label',
      `${current.unitId === 'parent' ? 'Workspace' : 'Agent'} actions for ${current.name}`,
    );
    document.getElementById('reset-item-session').hidden =
      current.unitId !== 'parent';
    document.getElementById('cancel-all-agents').hidden =
      current.unitId !== 'parent';
    if (isOpen() && !items().includes(document.activeElement))
      items()[0]?.focus();
  }
  function open(source, point) {
    close();
    origin = source;
    target = selected();
    if (!target) return;
    sync();
    menu.showPopover({source});
    const anchor = source.getBoundingClientRect();
    const x = point?.x ?? anchor.left;
    const y = point?.y ?? anchor.bottom;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus({preventScroll: true});
  }
  function openTarget(source, point) {
    if (
      select(source.dataset.contextSession, source.dataset.contextUnit) ===
      false
    ) {
      close(true);
      return;
    }
    open(source, point);
  }
  function context(event) {
    const source = event.target.closest(targetSelector);
    if (!source || source.closest('[inert]')) return;
    event.preventDefault();
    openTarget(
      source,
      event.clientX || event.clientY
        ? {x: event.clientX, y: event.clientY}
        : undefined,
    );
  }
  function toggle() {
    if (isOpen()) close(true);
    else openTarget(button);
  }
  function keydown(event) {
    if (!isOpen()) {
      if (
        event.key !== 'ContextMenu' &&
        !(event.shiftKey && event.key === 'F10')
      )
        return;
      const source = event.target.closest(targetSelector);
      if (!source) return;
      event.preventDefault();
      event.stopPropagation();
      openTarget(source);
      return;
    }
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const enabled = items();
    const index = enabled.indexOf(document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabled.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) %
            enabled.length;
    enabled[next]?.focus();
  }
  function activate(event) {
    if (!event.target.closest('[role="menuitem"]:not(:disabled)')) return;
    // A snapshot can change the selection before the next paint updates the menu.
    if (isOpen() && key(target) !== key(selected())) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    close(true);
  }
  function toggled() {
    button.setAttribute('aria-expanded', String(isOpen()));
  }
  function dismiss() {
    close();
  }
  document.addEventListener('contextmenu', context);
  document.addEventListener('keydown', keydown, true);
  button.addEventListener('click', toggle);
  menu.addEventListener('click', activate, true);
  menu.addEventListener('toggle', toggled);
  window.addEventListener('resize', dismiss);
  document.addEventListener('varisdev:panel-layout', dismiss);
  return {
    sync,
    dispose() {
      close();
      document.removeEventListener('contextmenu', context);
      document.removeEventListener('keydown', keydown, true);
      button.removeEventListener('click', toggle);
      menu.removeEventListener('click', activate, true);
      menu.removeEventListener('toggle', toggled);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('varisdev:panel-layout', dismiss);
    },
  };
}
