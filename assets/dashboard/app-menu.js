/* global document, CustomEvent */

export function initAppMenu() {
  const controls = document.getElementById('application-controls');
  const button = document.getElementById('app-menu-button');
  const panel = document.getElementById('app-menu-panel');
  const openFolder = document.getElementById('new-session');
  const settings = document.getElementById('open-session-settings');
  const resume = document.getElementById('resume-session');
  const start = document.getElementById('start-session');
  const closeSession = document.getElementById('close-session');

  function sync() {
    button.setAttribute(
      'aria-expanded',
      String(panel.matches(':popover-open')),
    );
  }
  function close() {
    if (panel.matches(':popover-open')) panel.hidePopover();
    sync();
  }
  function toggle() {
    if (panel.matches(':popover-open')) close();
    else {
      panel.showPopover({source: button});
      panel.dispatchEvent(new CustomEvent('varisdev:app-menu-open'));
      sync();
    }
  }
  function escape(event) {
    if (event.key !== 'Escape' || !panel.matches(':popover-open')) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    button.focus();
  }
  button.addEventListener('click', toggle);
  panel.addEventListener('toggle', sync);
  openFolder.addEventListener('click', close);
  settings.addEventListener('click', close);
  resume.addEventListener('click', close);
  start.addEventListener('click', close);
  closeSession.addEventListener('click', close);
  document.addEventListener('keydown', escape, true);
  return {
    place(hasSession) {
      if (!hasSession) settings.hidden = true;
      start.hidden = closeSession.hidden = !hasSession;
      const slot = document.getElementById(
        hasSession ? 'inspector-actions' : 'welcome-actions',
      );
      if (controls.parentElement === slot) return;
      close();
      slot.append(controls);
    },
    dispose() {
      button.removeEventListener('click', toggle);
      panel.removeEventListener('toggle', sync);
      openFolder.removeEventListener('click', close);
      settings.removeEventListener('click', close);
      resume.removeEventListener('click', close);
      start.removeEventListener('click', close);
      closeSession.removeEventListener('click', close);
      document.removeEventListener('keydown', escape, true);
    },
  };
}
