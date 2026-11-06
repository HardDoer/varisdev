/* global document */

export function initTerminalSettings(api, onChange) {
  const $ = id => document.getElementById(id);
  const dialog = $('terminal-settings-dialog');
  if (!dialog) return {open() {}, dispose() {}};
  const selector = $('terminal-settings-profile');
  const name = $('terminal-settings-name');
  const path = $('terminal-settings-path');
  const listeners = [];
  let state;
  let busy = '';
  let failure = '';
  let status = '';
  let request = 0;
  let disposed = false;
  let opener;

  function listen(element, type, callback) {
    element.addEventListener(type, callback);
    listeners.push(() => element.removeEventListener(type, callback));
  }
  function render() {
    const disabled = Boolean(busy) || !state;
    for (const element of [
      selector,
      name,
      path,
      $('terminal-settings-add'),
      $('terminal-settings-browse'),
    ])
      element.disabled = disabled;
    $('terminal-settings-save').disabled =
      disabled || !name.value.trim() || !path.value.trim();
    $('terminal-settings-remove').hidden = !selector.value;
    $('terminal-settings-remove').disabled = disabled;
    $('terminal-settings-close').disabled =
      busy === 'save' || busy === 'remove';
    $('terminal-settings-retry').hidden = Boolean(state) || !failure;
    $('terminal-settings-retry').disabled = Boolean(busy);
    $('terminal-settings-error').textContent = failure;
    $('terminal-settings-error').hidden = !failure;
    const unavailable =
      selector.value &&
      !state?.profiles.some(profile => profile.id === selector.value);
    $('terminal-settings-unavailable').hidden = !unavailable;
    $('terminal-settings-status').textContent =
      busy === 'load'
        ? 'Loading…'
        : busy === 'save'
          ? 'Saving…'
          : busy === 'remove'
            ? 'Removing…'
            : busy === 'browse'
              ? 'Choosing a file…'
              : status;
  }
  function options(selectedId) {
    const add = document.createElement('option');
    add.value = '';
    add.textContent = 'New terminal profile';
    selector.replaceChildren(add);
    for (const profile of state.customProfiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent =
        profile.label +
        (state.profiles.some(entry => entry.id === profile.id)
          ? ''
          : ' (unavailable)');
      selector.append(option);
    }
    selector.value = selectedId ?? state.customProfiles[0]?.id ?? '';
  }
  function select() {
    const profile = state.customProfiles.find(
      entry => entry.id === selector.value,
    );
    name.value = profile?.label || '';
    path.value = profile?.path || '';
    failure = status = '';
    render();
  }
  async function load() {
    if (busy || disposed) return;
    const version = ++request;
    busy = 'load';
    failure = '';
    render();
    try {
      const next = await api.getTerminalProfiles();
      if (disposed || version !== request) return;
      state = next;
      onChange(next);
      options();
      select();
    } catch (error) {
      if (disposed || version !== request) return;
      failure = error.message || String(error);
    } finally {
      if (!disposed && version === request) {
        busy = '';
        render();
        if (dialog.open && state) (selector.value ? selector : name).focus();
      }
    }
  }
  function open(source = $('app-menu-button')) {
    if (disposed || dialog.open) return;
    opener = source;
    const menu = $('app-menu-panel');
    if (menu.matches(':popover-open')) menu.hidePopover();
    state = undefined;
    busy = failure = status = '';
    selector.replaceChildren();
    name.value = path.value = '';
    render();
    dialog.showModal();
    void load();
  }
  function close() {
    if (busy === 'save' || busy === 'remove') return;
    ++request;
    busy = '';
    dialog.close();
    opener?.focus();
  }
  async function save(remove = false) {
    if (disposed || busy || !state) return;
    if (remove ? !selector.value : $('terminal-settings-save').disabled) return;
    const selectedId = selector.value;
    const previousIds = new Set(
      state.customProfiles.map(profile => profile.id),
    );
    const version = ++request;
    busy = remove ? 'remove' : 'save';
    failure = status = '';
    render();
    try {
      const next = remove
        ? await api.removeTerminalProfile(selectedId)
        : await api.saveTerminalProfile({
            id: selectedId || undefined,
            label: name.value,
            path: path.value,
          });
      if (disposed || version !== request) return;
      state = next;
      onChange(next);
      const savedId = remove
        ? undefined
        : selectedId ||
          next.customProfiles.find(profile => !previousIds.has(profile.id))?.id;
      options(savedId);
      select();
      status = remove ? 'Removed.' : 'Saved.';
    } catch (error) {
      if (disposed || version !== request) return;
      failure = error.message || String(error);
    } finally {
      if (!disposed && version === request) {
        busy = '';
        render();
      }
    }
  }
  async function browse() {
    if (disposed || busy || !state) return;
    const version = ++request;
    busy = 'browse';
    failure = status = '';
    render();
    try {
      const chosen = await api.chooseTerminalExecutable();
      if (disposed || version !== request) return;
      if (chosen !== undefined) path.value = chosen;
    } catch (error) {
      if (disposed || version !== request) return;
      failure = error.message || String(error);
    } finally {
      if (!disposed && version === request) {
        busy = '';
        render();
        if (dialog.open) path.focus();
      }
    }
  }
  $('open-terminal-settings').disabled =
    !api?.saveTerminalProfile ||
    !api?.removeTerminalProfile ||
    !api?.chooseTerminalExecutable;
  listen($('open-terminal-settings'), 'click', () => open());
  listen(selector, 'change', select);
  listen($('terminal-settings-add'), 'click', () => {
    selector.value = '';
    select();
    name.focus();
  });
  for (const element of [name, path])
    listen(element, 'input', () => {
      failure = status = '';
      render();
    });
  listen($('terminal-settings-form'), 'submit', event => {
    event.preventDefault();
    void save();
  });
  listen($('terminal-settings-remove'), 'click', () => {
    void save(true);
  });
  listen($('terminal-settings-browse'), 'click', () => {
    void browse();
  });
  listen($('terminal-settings-retry'), 'click', () => {
    void load();
  });
  listen($('terminal-settings-close'), 'click', close);
  listen(dialog, 'cancel', event => {
    event.preventDefault();
    close();
  });
  return {
    open,
    dispose() {
      disposed = true;
      ++request;
      for (const remove of listeners) remove();
      if (dialog.open) dialog.close();
    },
  };
}
