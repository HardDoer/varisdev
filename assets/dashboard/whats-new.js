/* global document, MutationObserver */

export function initWhatsNew(api) {
  const $ = id => document.getElementById(id);
  const dialog = $('whats-new-dialog');
  const button = $('open-whats-new');
  const close = $('whats-new-close');
  const retry = $('whats-new-retry');
  const supported = Boolean(api?.getWhatsNew && api?.markWhatsNewSeen);
  let disposed = false;
  let ready = false;
  let state;
  let pending = true;
  let loading;
  let saving = false;
  let failure = '';
  let previousFocus;

  function render() {
    $('whats-new-version').textContent = state?.release
      ? `VarisDev ${state.release.version}`
      : '';
    $('whats-new-changes').replaceChildren(
      ...(state?.release?.changes || []).map(change => {
        const item = document.createElement('li');
        item.textContent = change;
        return item;
      }),
    );
    $('whats-new-status').textContent = loading
      ? 'Loading release notes…'
      : state && !state.release
        ? 'No release notes are available for this version.'
        : '';
    $('whats-new-status').hidden = !$('whats-new-status').textContent;
    $('whats-new-error').textContent = failure;
    $('whats-new-error').hidden = !failure;
    retry.hidden = !failure;
    retry.disabled = Boolean(loading || saving);
  }

  async function markSeen() {
    if (
      disposed ||
      saving ||
      !dialog.open ||
      document.hidden ||
      !state?.release ||
      state.seen
    )
      return;
    saving = true;
    failure = '';
    render();
    try {
      await api.markWhatsNewSeen(state.release.version);
      state.seen = true;
    } catch {
      failure =
        'Could not save your preference. These notes may appear again next time.';
    } finally {
      saving = false;
      if (!disposed) render();
    }
  }

  function show() {
    if (disposed || dialog.open) return;
    pending = false;
    previousFocus = document.activeElement;
    dialog.showModal();
    close.focus();
    void markSeen();
  }

  function maybeShow() {
    if (
      disposed ||
      !ready ||
      !pending ||
      !state?.release ||
      state.seen ||
      document.hidden ||
      document.querySelector('dialog[open], [popover]:popover-open')
    )
      return;
    show();
  }

  async function load() {
    if (disposed || loading) return loading;
    failure = '';
    loading = api.getWhatsNew();
    render();
    try {
      state = await loading;
    } catch {
      failure = 'Could not load release notes.';
    } finally {
      loading = undefined;
      if (!disposed) {
        render();
        if (dialog.open) void markSeen();
        else maybeShow();
      }
    }
  }

  function open() {
    const menu = $('app-menu-panel');
    if (menu.matches(':popover-open')) menu.hidePopover();
    $('app-menu-button').focus();
    show();
    if (!state) void load();
  }
  function dismiss() {
    dialog.close();
  }
  function restoreFocus() {
    if (disposed || document.querySelector('dialog[open]')) return;
    if (
      previousFocus !== document.body &&
      previousFocus?.isConnected &&
      previousFocus.checkVisibility()
    )
      previousFocus.focus({preventScroll: true});
    else $('app-menu-button').focus({preventScroll: true});
  }
  function retryFailed() {
    if (state?.release) void markSeen();
    else void load();
  }
  function visibilityChanged() {
    if (dialog.open) void markSeen();
    else maybeShow();
  }

  button.disabled = !supported;
  button.addEventListener('click', open);
  close.addEventListener('click', dismiss);
  dialog.addEventListener('close', restoreFocus);
  retry.addEventListener('click', retryFailed);
  document.addEventListener('visibilitychange', visibilityChanged);
  document.addEventListener('toggle', maybeShow, true);
  const observer = new MutationObserver(maybeShow);
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  if (supported) void load();

  return {
    ready(value) {
      ready = value;
      maybeShow();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      button.removeEventListener('click', open);
      close.removeEventListener('click', dismiss);
      dialog.removeEventListener('close', restoreFocus);
      retry.removeEventListener('click', retryFailed);
      document.removeEventListener('visibilitychange', visibilityChanged);
      document.removeEventListener('toggle', maybeShow, true);
      dialog.close();
    },
  };
}
