/* global document, window */

const STORAGE_KEY = 'varisdev.factory.zoom';

/** Native page zoom scales the workspace, dialogs and editor together. */
export function initZoom(api) {
  const select = document.getElementById('app-zoom');
  if (!api) {
    select.disabled = true;
    return () => {};
  }
  let saved;
  try {
    saved = Number(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Zoom still works when preference storage is unavailable.
  }
  if (
    Number.isFinite(saved) &&
    saved >= 0.25 &&
    saved <= 5 &&
    Math.abs(api.getZoom() - saved) > 0.001
  )
    api.setZoom(saved);

  function sync() {
    const factor = api.getZoom();
    const value = String(factor);
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${Math.round(factor * 100)}%`;
      option.dataset.custom = 'true';
      select.append(option);
    }
    select.value = value;
    for (const option of select.querySelectorAll('[data-custom]'))
      if (option.value !== value) option.remove();
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Keep the current zoom even when it cannot be saved.
    }
  }
  function change() {
    api.setZoom(Number(select.value));
    sync();
  }
  sync();
  select.addEventListener('change', change);
  // Electron's View menu and zoom shortcuts also resize the page viewport.
  window.addEventListener('resize', sync);
  return () => {
    select.removeEventListener('change', change);
    window.removeEventListener('resize', sync);
  };
}
