/* global document */

export function initModelDefaults({api, selected}) {
  const $ = id => document.getElementById(id);
  const dialog = $('session-settings-dialog');
  let state;
  let draft;
  let busy = false;
  let failure = '';
  let message = '';

  const modelKey = model => `${model.provider}/${model.id}`;
  const selectedModel = () =>
    state?.models.find(model => modelKey(model) === draft?.model);

  function option(value, label = value) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = label;
    return item;
  }

  function renderControls() {
    const model = selectedModel();
    $('session-model').disabled = busy || !state?.models.length;
    $('session-thinking').disabled = busy || !model;
    $('apply-session-settings').disabled =
      busy || !model || !model.thinkingLevels.includes(draft?.thinkingLevel);
    $('close-session-settings').disabled = busy;
    $('model-defaults-error').textContent = failure;
    $('model-defaults-error').hidden = !failure;
    $('model-defaults-retry').hidden = !failure || Boolean(state);
    $('model-defaults-retry').disabled = busy;
    $('model-defaults-status').textContent = busy
      ? state
        ? 'Saving defaults…'
        : 'Loading defaults…'
      : message;
  }

  function renderThinking() {
    const levels = selectedModel()?.thinkingLevels || [];
    if (levels.length && !levels.includes(draft.thinkingLevel)) {
      const order = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
      const requested = order.indexOf(draft.thinkingLevel);
      draft.thinkingLevel =
        levels.find(level => order.indexOf(level) >= requested) ||
        levels.at(-1);
    }
    $('session-thinking').replaceChildren(
      ...(levels.length
        ? levels
        : draft?.thinkingLevel
          ? [draft.thinkingLevel]
          : []
      ).map(level => option(level)),
    );
    $('session-thinking').value = draft?.thinkingLevel || '';
    renderControls();
  }

  function renderDraft() {
    const models = state?.models || [];
    const options = models.map(model =>
      option(modelKey(model), `${model.name || model.id} · ${model.provider}`),
    );
    if (!draft?.model || !selectedModel()) {
      const missing = option(
        draft?.model || '',
        draft?.model
          ? `${draft.model} · unavailable`
          : 'Choose a default model',
      );
      missing.disabled = true;
      options.unshift(missing);
    }
    $('session-model').replaceChildren(...options);
    $('session-model').value = draft?.model || '';
    renderThinking();
  }

  function receive(next) {
    state = next;
    draft = {
      model: next.model ? modelKey(next.model) : '',
      thinkingLevel: next.thinkingLevel,
    };
    renderDraft();
  }

  async function load() {
    if (busy) return;
    busy = true;
    failure = '';
    message = '';
    state = undefined;
    draft = undefined;
    renderDraft();
    try {
      receive(await api.getModelDefaults());
    } catch (error) {
      failure = error.message || String(error);
    } finally {
      busy = false;
      renderControls();
    }
  }

  $('open-session-settings').disabled =
    !api?.getModelDefaults || !api?.saveModelDefaults;
  $('open-session-settings').addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
    void load();
  });
  $('close-session-settings').addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  $('model-defaults-retry').addEventListener('click', () => void load());
  $('session-model').addEventListener('change', () => {
    if (!draft || busy) return;
    draft.model = $('session-model').value;
    failure = message = '';
    renderThinking();
  });
  $('session-thinking').addEventListener('change', () => {
    if (!draft || busy) return;
    draft.thinkingLevel = $('session-thinking').value;
    failure = message = '';
    renderControls();
  });
  $('session-settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || $('apply-session-settings').disabled) return;
    const model = selectedModel();
    if (!model) return;
    // Keep the target fixed if selection changes while defaults are being saved.
    const current = selected?.()?.session;
    const target =
      current?.controllable && current.status !== 'closed'
        ? {id: current.id, name: current.name}
        : undefined;
    const configuration = {
      provider: model.provider,
      modelId: model.id,
      thinkingLevel: draft.thinkingLevel,
    };
    let saved = false;
    busy = true;
    failure = message = '';
    renderControls();
    try {
      receive(await api.saveModelDefaults(configuration));
      saved = true;
      if (target) await api.configureSession(target.id, configuration);
      message = target
        ? `Defaults saved and applied to ${target.name}. Other open sessions are unchanged.`
        : 'Defaults saved for new sessions.';
    } catch (error) {
      const detail = error.message || String(error);
      failure = saved
        ? `Defaults saved, but could not apply them to ${target.name}: ${detail}`
        : detail;
    } finally {
      busy = false;
      renderControls();
    }
  });
}
