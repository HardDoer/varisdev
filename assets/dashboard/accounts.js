/* global document */

export function initAccounts(api) {
  if (!api?.getAccounts || !api.onAccounts) {
    const cleanup = () => {};
    cleanup.open = async () => {
      throw new Error('Accounts are unavailable.');
    };
    return cleanup;
  }
  const $ = id => document.getElementById(id);
  const dialog = $('accounts-dialog');
  const provider = $('accounts-provider');
  const form = $('accounts-form');
  const input = $('accounts-input');
  const choice = $('accounts-choice');
  let state = {revision: -1, providers: [], links: [], message: ''};
  let busy = false;
  let failure = '';
  let promptId;
  let providerSignature;
  let linksSignature;
  let disposed = false;
  let logoutProvider;

  function render() {
    const signature = JSON.stringify(state.providers);
    if (providerSignature !== signature) {
      providerSignature = signature;
      const selected = provider.value;
      provider.replaceChildren(
        ...state.providers.map(item => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = `${item.name} · ${item.status}`;
          return option;
        }),
      );
      if (state.providers.some(item => item.id === selected))
        provider.value = selected;
    }
    if (state.attempt) provider.value = state.attempt.provider;
    const selected = state.providers.find(item => item.id === provider.value);
    const working = busy || Boolean(state.attempt);
    provider.disabled = working || !state.providers.length;
    $('accounts-status').textContent =
      selected?.status ||
      (busy ? 'Loading providers…' : 'No providers available.');
    for (const [id, available] of [
      ['accounts-oauth', selected?.oauth],
      ['accounts-key', selected?.apiKey],
      ['accounts-logout', selected?.stored],
    ]) {
      $(id).hidden = !available;
      $(id).disabled = working;
    }
    const confirmingLogout =
      logoutProvider === selected?.id && selected?.stored;
    $('accounts-logout-confirmation').hidden = !confirmingLogout;
    $('accounts-logout-confirm').disabled = working;
    $('accounts-logout-cancel').disabled = working;
    $('accounts-logout-question').textContent = confirmingLogout
      ? `Sign out of ${selected.name}? This removes its saved credentials.`
      : '';
    $('accounts-key').textContent =
      selected?.id === 'llama.cpp'
        ? 'Connect server'
        : selected?.stored
          ? 'Replace with API key'
          : 'Enter API key';
    $('accounts-message').textContent = state.message;
    $('accounts-error').textContent = [
      failure || state.error,
      ...(state.diagnostics || []),
    ]
      .filter(Boolean)
      .join('\n');
    $('accounts-error').hidden = !$('accounts-error').textContent;
    $('accounts-device').hidden = !state.deviceCode;
    $('accounts-device-code').value = state.deviceCode || '';
    const linkKey = JSON.stringify([state.attempt?.id, state.links]);
    if (linksSignature !== linkKey) {
      linksSignature = linkKey;
      $('accounts-links').replaceChildren(
        ...state.links.map((link, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'quiet-button';
          button.textContent = link.label;
          const attempt = state.attempt?.id;
          button.addEventListener(
            'click',
            () => void run(() => api.openAccountLink(attempt, index)),
          );
          return button;
        }),
      );
    }
    $('accounts-cancel').hidden = !state.attempt;
    $('accounts-cancel').disabled = busy;
    const request = state.prompt;
    form.hidden = !request;
    if (promptId !== request?.id) {
      promptId = request?.id;
      input.value = '';
      choice.replaceChildren();
      if (request) {
        const selecting = request.type === 'select';
        $('accounts-prompt-label').textContent = request.message;
        $('accounts-prompt-label').htmlFor = selecting
          ? 'accounts-choice'
          : 'accounts-input';
        input.hidden = selecting;
        choice.hidden = !selecting;
        input.required = !selecting && !request.allowEmpty;
        input.type = ['secret', 'manual_code'].includes(request.type)
          ? 'password'
          : 'text';
        input.placeholder = request.placeholder || '';
        for (const item of request.options || []) {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.label;
          choice.append(option);
        }
        if (dialog.open) (selecting ? choice : input).focus();
      }
    }
    $('accounts-submit').disabled = busy;
  }

  function receive(next) {
    if (disposed || next.revision < state.revision) return;
    state = next;
    failure = '';
    render();
  }
  async function run(operation) {
    if (busy || disposed) return;
    busy = true;
    failure = '';
    render();
    try {
      const next = await operation();
      if (next) receive(next);
    } catch (error) {
      failure = error.message || String(error);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  async function open(options = {}) {
    const menu = $('app-menu-panel');
    if (menu.matches(':popover-open')) menu.hidePopover();
    logoutProvider = undefined;
    if (!dialog.open) dialog.showModal();
    await run(() => api.getAccounts());
    if (options.provider) {
      const match = state.providers.find(
        item =>
          item.id.toLocaleLowerCase() ===
            options.provider.toLocaleLowerCase() ||
          item.name.toLocaleLowerCase() ===
            options.provider.toLocaleLowerCase(),
      );
      if (!match || (state.attempt && state.attempt.provider !== match.id)) {
        failure = !match
          ? `Unknown account provider: ${options.provider}`
          : 'Finish or cancel the current sign-in before choosing another provider.';
        render();
        throw new Error(failure);
      }
      provider.value = match.id;
    }
    if (options.logout) logoutProvider = provider.value;
    render();
    if (options.logout && !$('accounts-logout-confirmation').hidden)
      $('accounts-logout-confirm').focus();
    else provider.focus();
  }
  async function close() {
    if (busy) return;
    logoutProvider = undefined;
    input.value = '';
    if (state.attempt) {
      await run(() => api.cancelAccount(state.attempt.id));
      if (failure) return;
    }
    dialog.close();
  }
  function cancel(event) {
    event.preventDefault();
    void close();
  }
  function submit(event) {
    event.preventDefault();
    if (!state.attempt || !state.prompt || busy) return;
    const value = state.prompt.type === 'select' ? choice.value : input.value;
    const attempt = state.attempt.id;
    const prompt = state.prompt.id;
    input.value = '';
    void run(() => api.respondAccount(attempt, prompt, value));
  }
  const listeners = [];
  function listen(id, event, callback) {
    const element = $(id);
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  }
  for (const id of ['open-accounts', 'welcome-accounts'])
    listen(id, 'click', () => void open());
  listen('accounts-provider', 'change', () => {
    logoutProvider = undefined;
    render();
  });
  listen('accounts-logout', 'click', () => {
    logoutProvider = provider.value;
    render();
    $('accounts-logout-confirm').focus();
  });
  listen('accounts-logout-cancel', 'click', () => {
    logoutProvider = undefined;
    render();
    $('accounts-logout').focus();
  });
  listen('accounts-logout-confirm', 'click', () => {
    if (logoutProvider !== provider.value) return;
    const selectedProvider = logoutProvider;
    logoutProvider = undefined;
    void run(() => api.startAccount(selectedProvider, 'logout'));
  });
  listen('accounts-close', 'click', () => void close());
  listen('accounts-dialog', 'cancel', cancel);
  listen('accounts-form', 'submit', submit);
  listen('accounts-cancel', 'click', () => {
    input.value = '';
    if (state.attempt) void run(() => api.cancelAccount(state.attempt.id));
  });
  for (const [id, method] of [
    ['accounts-oauth', 'oauth'],
    ['accounts-key', 'api_key'],
  ])
    listen(
      id,
      'click',
      () => void run(() => api.startAccount(provider.value, method)),
    );
  const unsubscribe = api.onAccounts(receive);
  const cleanup = () => {
    disposed = true;
    input.value = '';
    unsubscribe();
    for (const remove of listeners) remove();
  };
  cleanup.open = open;
  return cleanup;
}
