/* global document, CustomEvent */

export function initAppMenu() {
  const controls = document.getElementById('application-controls');
  const button = document.getElementById('app-menu-button');
  const panel = document.getElementById('app-menu-panel');
  const openFolder = document.getElementById('new-session');
  const settings = document.getElementById('open-session-settings');
  const approvals = document.getElementById('open-approvals');
  const resume = document.getElementById('resume-session');
  const start = document.getElementById('start-session');
  const appearance = document.getElementById('app-menu-appearance-controls');
  const zoomControl = document.getElementById('app-zoom').closest('label');
  const themeControl = panel.querySelector('.theme-control');
  const themeErrors = document.getElementById('plugin-theme-errors');
  const motion = document.getElementById('motion-toggle');
  const about = document.getElementById('about-dialog');
  const aboutButton = document.getElementById('open-about');
  const aboutClose = document.getElementById('about-close');

  // The theme picker is installed before this module initializes. Move the
  // generated controls together so Appearance remains one semantic group.
  appearance.append(
    ...[zoomControl, themeControl, themeErrors, motion].filter(Boolean),
  );

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
  function showAbout() {
    close();
    button.focus();
    about.showModal();
  }
  function closeAbout() {
    about.close();
  }
  const weapons = document.getElementById('app-menu-weapon-controls');
  function equipWeapon(event) {
    if (event.target.closest('button')) {
      close();
      button.focus({preventScroll: true});
    }
  }
  weapons.addEventListener('click', equipWeapon);
  aboutButton.addEventListener('click', showAbout);
  aboutClose.addEventListener('click', closeAbout);
  button.addEventListener('click', toggle);
  panel.addEventListener('toggle', sync);
  openFolder.addEventListener('click', close);
  settings.addEventListener('click', close);
  approvals.addEventListener('click', close);
  resume.addEventListener('click', close);
  start.addEventListener('click', close);
  document.addEventListener('keydown', escape, true);
  return {
    place(hasSession) {
      document.querySelector('.skip-link').href = hasSession
        ? '#inspector'
        : '#welcome-title';
      document.getElementById('app-menu-weapons').hidden =
        !hasSession ||
        document.getElementById('factory-workspace').dataset
          .visualizationHidden === 'true';
      const slot = document.getElementById(
        hasSession ? 'inspector-actions' : 'welcome-actions',
      );
      if (controls.parentElement === slot) return;
      close();
      slot.append(controls);
    },
    dispose() {
      weapons.removeEventListener('click', equipWeapon);
      aboutButton.removeEventListener('click', showAbout);
      aboutClose.removeEventListener('click', closeAbout);
      button.removeEventListener('click', toggle);
      panel.removeEventListener('toggle', sync);
      openFolder.removeEventListener('click', close);
      settings.removeEventListener('click', close);
      approvals.removeEventListener('click', close);
      resume.removeEventListener('click', close);
      start.removeEventListener('click', close);
      document.removeEventListener('keydown', escape, true);
    },
  };
}
