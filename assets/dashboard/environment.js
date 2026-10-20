/* global document */

export function initEnvironment(api) {
  const $ = id => document.getElementById(id);
  const dialog = $('environment-dialog');
  const selector = $('environment-variable');
  const name = $('environment-name');
  const value = $('environment-value');
  const listeners = [];
  let state;
  let busy = '';
  let failure = '';
  let status = '';
  let revealed = false;
  let edited = false;
  let request = 0;
  let disposed = false;

  function listen(element, event, callback) {
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  }
  function variableName() {
    return selector.value || name.value.trim();
  }
  function render() {
    value.type = revealed ? 'text' : 'password';
    $('environment-show').hidden = false;
    $('environment-show').textContent = revealed ? 'Hide' : 'Show';
    $('environment-show').setAttribute('aria-pressed', String(revealed));
    $('environment-show').setAttribute(
      'aria-label',
      revealed ? 'Hide value' : 'Show value',
    );
    $('environment-name-field').hidden = Boolean(selector.value);
    const saved = state?.savedNames.includes(variableName());
    const fromEnvironment =
      state && !saved && Object.hasOwn(state.values, variableName()) && !edited;
    value.classList.toggle('environment-read-value', fromEnvironment);
    $('environment-value-note').hidden = !fromEnvironment;
    selector.disabled =
      name.disabled =
      value.disabled =
      $('environment-show').disabled =
        Boolean(busy) || !state;
    $('environment-save').disabled = Boolean(busy) || !state || !variableName();
    $('environment-remove').hidden = !saved;
    $('environment-remove').disabled = Boolean(busy);
    $('environment-close').disabled = busy === 'save';
    $('environment-retry').hidden = Boolean(state) || !failure;
    $('environment-retry').disabled = Boolean(busy);
    $('environment-status').textContent =
      busy === 'load' ? 'Loading…' : busy === 'save' ? 'Saving…' : status;
    $('environment-error').textContent = failure;
    $('environment-error').hidden = !failure;
  }
  function options(selected) {
    const configured = Object.keys(state.values).sort();
    const suggestions = [...new Set(state.names)]
      .filter(entry => !Object.hasOwn(state.values, entry))
      .sort();
    const custom = document.createElement('option');
    custom.value = '';
    custom.textContent = 'Enter a variable name…';
    selector.replaceChildren(custom);
    for (const [label, names] of [
      ['Configured', configured],
      ['Suggested', suggestions],
    ]) {
      if (!names.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const entry of names) {
        const option = document.createElement('option');
        option.value = entry;
        option.textContent = entry;
        group.append(option);
      }
      selector.append(group);
    }
    selector.value = selected ?? configured[0] ?? '';
  }
  function select() {
    name.value = selector.value;
    value.value = state.values[variableName()] ?? '';
    revealed = false;
    edited = false;
    failure = '';
    status = '';
    render();
  }
  async function load() {
    if (busy || disposed) return;
    const version = ++request;
    busy = 'load';
    failure = '';
    render();
    try {
      const next = await api.getEnvironment();
      if (disposed || version !== request) return;
      state = next;
      options();
      select();
      failure = next.error || '';
    } catch (error) {
      if (disposed || version !== request) return;
      failure = error?.message || String(error);
    } finally {
      if (!disposed && version === request) {
        busy = '';
        render();
        if (dialog.open && state) {
          (selector.value ? selector : name).focus();
        }
      }
    }
  }
  function open() {
    if (disposed || dialog.open) return;
    const menu = $('app-menu-panel');
    if (menu.matches(':popover-open')) menu.hidePopover();
    $('app-menu-button').focus();
    clear();
    dialog.showModal();
    void load();
  }
  async function save(remove = false) {
    if ($('environment-save').disabled || disposed) return;
    const selected = variableName();
    const version = ++request;
    busy = 'save';
    failure = '';
    status = '';
    render();
    try {
      const next = await api.saveEnvironment(
        selected,
        remove ? null : value.value,
      );
      if (disposed || version !== request) return;
      if (next.error) throw new Error(next.error);
      state = next;
      options(selected);
      name.value = selected;
      value.value = next.values[selected] ?? '';
      revealed = false;
      edited = false;
      status = remove ? 'Saved value removed.' : 'Saved.';
    } catch (error) {
      if (disposed || version !== request) return;
      failure = error?.message || String(error);
    } finally {
      if (!disposed && version === request) {
        busy = '';
        render();
      }
    }
  }
  function clear() {
    ++request;
    state = undefined;
    busy = '';
    failure = status = '';
    revealed = false;
    edited = false;
    selector.replaceChildren();
    name.value = value.value = '';
    render();
  }

  function close() {
    if (busy === 'save') return;
    clear();
    dialog.close();
    $('app-menu-button').focus();
  }

  $('open-environment').disabled =
    !api?.getEnvironment || !api?.saveEnvironment;
  listen($('open-environment'), 'click', open);
  listen($('environment-form'), 'submit', event => {
    event.preventDefault();
    void save();
  });
  listen($('environment-remove'), 'click', () => void save(true));
  listen(selector, 'change', () => {
    select();
    if (!selector.value) name.focus();
  });
  listen(name, 'input', () => {
    value.value = state?.values[variableName()] ?? '';
    revealed = false;
    edited = false;
    failure = status = '';
    render();
  });
  listen(value, 'input', () => {
    edited = true;
    failure = status = '';
    render();
  });
  listen($('environment-show'), 'click', () => {
    revealed = !revealed;
    render();
  });
  listen($('environment-retry'), 'click', () => void load());
  listen($('environment-close'), 'click', close);
  listen(dialog, 'keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  listen(dialog, 'cancel', event => {
    event.preventDefault();
    close();
  });
  listen(dialog, 'close', () => {
    if (!dialog.open) {
      clear();
      $('app-menu-button').focus();
    }
  });
  clear();
  return () => {
    disposed = true;
    for (const remove of listeners) remove();
    if (dialog.open) dialog.close();
    clear();
  };
}
