/* global document, window, CustomEvent */

const STORAGE_KEY = 'varisdev.panel-layout.v1';

export function initPanelLayout({onChange = () => {}} = {}) {
  const workspace = document.getElementById('factory-workspace');
  const column = document.getElementById('factory-column');
  const panels = {
    visualization: document.getElementById('factory-panel'),
    workspaces: document.getElementById('workspaces-panel'),
    agents: document.getElementById('worker-panels'),
  };
  const visible = {visualization: true, workspaces: true, agents: true};
  const listeners = [];
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    for (const key of Object.keys(visible))
      if (typeof saved?.[key] === 'boolean') visible[key] = saved[key];
  } catch {
    // Use the default layout when storage is unavailable.
  }

  function apply() {
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = !visible[key];
      workspace.dataset[`${key}Hidden`] = String(!visible[key]);
      document.getElementById(`layout-${key}`).checked = visible[key];
    }
    column.hidden = !Object.values(visible).some(Boolean);
    document.getElementById('conversation-resize').hidden = column.hidden;
    document.getElementById('workspaces-resize').hidden =
      !visible.workspaces || (!visible.visualization && !visible.agents);
    document.getElementById('agents-resize').hidden =
      !visible.visualization || !visible.agents;
    document.getElementById('app-menu-weapons').hidden =
      workspace.hidden || !visible.visualization;
    document.dispatchEvent(new CustomEvent('varisdev:panel-layout'));
    onChange(visible);
  }
  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visible));
    } catch {
      // Keep the chosen layout for this window.
    }
    apply();
  }
  for (const key of Object.keys(visible)) {
    const input = document.getElementById(`layout-${key}`);
    const change = () => {
      visible[key] = input.checked;
      save();
    };
    input.addEventListener('change', change);
    listeners.push(() => input.removeEventListener('change', change));
  }
  const reset = document.getElementById('layout-reset');
  const restore = () => {
    for (const key of Object.keys(visible)) visible[key] = true;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Keep the default layout for this window.
    }
    apply();
    document.dispatchEvent(new CustomEvent('varisdev:panel-layout-reset'));
  };
  reset.addEventListener('click', restore);
  apply();
  return () => {
    for (const remove of listeners) remove();
    reset.removeEventListener('click', restore);
  };
}
