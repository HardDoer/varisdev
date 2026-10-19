/* global document, MutationObserver, structuredClone */

export function initToolSettings({api, selectedSessionId}) {
  const $ = id => document.getElementById(id);
  const dialog = $('tool-settings-dialog');
  const notice = $('agent-notice-dialog');
  const commitNotice = $('commit-notice-dialog');
  const listeners = [];
  let disposed = false;
  let sessionId;
  let state;
  let draft;
  let imageState;
  let imageModel;
  let busy = false;
  let failure = '';
  let request = 0;
  let observedAgent = false;
  let acknowledged = false;
  let noticeLoaded = false;
  let noticeBusy = false;
  let noticeFailure = '';
  let commitResolve;
  let commitAcknowledged = false;
  let commitLoaded = false;
  let commitBusy = false;
  let commitFailure = '';

  function listen(element, event, callback) {
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  }
  function hideMenu() {
    const menu = $('app-menu-panel');
    if (menu.matches(':popover-open')) menu.hidePopover();
  }
  function errorText(error) {
    return error?.message || String(error);
  }
  function modelKey(model) {
    return `${model.provider}/${model.id}`;
  }
  function models() {
    const entries = new Map(
      (state?.models || []).map(model => [modelKey(model), model]),
    );
    const saved = [...draft.agents.allowedModels, draft.commit.model];
    for (const id of saved) {
      if (id && !entries.has(id))
        entries.set(id, {name: id, unavailable: true});
    }
    return [...entries].map(([id, model]) => ({...model, key: id}));
  }
  function commitAllowed(id) {
    return draft.agents.allowedModels.includes(id);
  }
  function commitValid() {
    return (
      draft.commit.model === null ||
      (state.models.some(model => modelKey(model) === draft.commit.model) &&
        commitAllowed(draft.commit.model))
    );
  }
  function renderModels() {
    const query = $('tool-settings-search').value.trim().toLowerCase();
    const entries = models();
    const visible = entries.filter(model =>
      `${model.name} ${model.key}`.toLowerCase().includes(query),
    );
    $('tool-settings-models').replaceChildren(
      ...visible.map(model => {
        const label = document.createElement('label');
        label.className = 'tool-model-option';
        const input = document.createElement('input');
        const checked = draft.agents.allowedModels.includes(model.key);
        input.type = 'checkbox';
        input.name = 'tool-settings-model';
        input.value = model.key;
        input.checked = checked;
        input.disabled = busy || (model.unavailable && !checked);
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = model.name;
        const detail = document.createElement('small');
        detail.textContent = model.key;
        text.append(name, detail);
        if (model.unavailable) {
          const reason = document.createElement('small');
          reason.textContent =
            'Unavailable in Pi’s current model list. Check Scoped models and provider access.';
          text.append(reason);
        }
        label.classList.toggle('unavailable', Boolean(model.unavailable));
        input.addEventListener('change', () => {
          const selected = new Set(draft.agents.allowedModels);
          if (input.checked) selected.add(model.key);
          else selected.delete(model.key);
          draft.agents.allowedModels = [...selected];
          failure = '';
          renderControls();
        });
        label.append(input, text);
        return label;
      }),
    );
    $('tool-settings-empty').hidden = visible.length > 0;
    $('tool-settings-empty').textContent = query
      ? 'No models match your search.'
      : 'No models available. Check your provider in Menu → Accounts, then reopen these settings.';
  }
  function renderCommitModels() {
    const inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = 'Inherit current agent model';
    $('commit-model').replaceChildren(
      inherit,
      ...models()
        .filter(
          model => commitAllowed(model.key) || draft.commit.model === model.key,
        )
        .map(model => {
          const option = document.createElement('option');
          option.value = model.key;
          const reason = model.unavailable
            ? ' — unavailable'
            : !commitAllowed(model.key)
              ? ' — not allowed'
              : '';
          option.textContent = `${model.name} (${model.key})${reason}`;
          option.disabled = Boolean(
            model.unavailable || !commitAllowed(model.key),
          );
          return option;
        }),
    );
    $('commit-model').value = draft.commit.model ?? '';
  }
  function renderImageModels() {
    const select = $('image-model');
    const firstUse = document.createElement('option');
    firstUse.value = '';
    firstUse.textContent = 'Ask on first use';
    const options = imageState.presets.map(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = `${preset.label}${preset.description ? ` — ${preset.description}` : ''}`;
      return option;
    });
    if (
      imageModel &&
      !imageState.presets.some(preset => preset.id === imageModel)
    ) {
      const legacy = document.createElement('option');
      legacy.value = imageModel;
      legacy.textContent = `${imageModel} (saved)`;
      legacy.disabled = true;
      options.push(legacy);
    }
    select.replaceChildren(firstUse, ...options);
    select.value = imageModel;
    select.disabled = busy;
    $('image-model-environment').textContent = imageState.environment
      ? `${imageState.environment} overrides this saved choice.`
      : '';
    $('image-model-environment').hidden = !imageState.environment;
  }
  function renderControls() {
    const loaded = Boolean(state && draft);
    $('tool-settings-content').hidden = !loaded;
    $('tool-settings-loading').hidden = !busy || loaded;
    const errors = [failure, ...(state?.diagnostics || [])]
      .filter(Boolean)
      .join('\n');
    $('tool-settings-error').textContent = errors;
    $('tool-settings-error').hidden = !errors;
    $('tool-settings-retry').hidden = loaded || !failure;
    $('tool-settings-retry').disabled = busy;
    $('tool-settings-close').disabled = busy;
    $('tool-settings-save').disabled = busy || !loaded;
    if (!loaded) return;
    $('tool-settings-search').disabled = busy;
    $('commit-model').disabled = busy;
    $('commit-thinking').disabled = busy;
    renderCommitModels();
    renderImageModels();
    $('commit-thinking').value = draft.commit.thinkingLevel ?? '';
    const invalid = !commitValid();
    $('tool-settings-validation').textContent = invalid
      ? 'Choose an available allowed Commit model, or inherit the current agent model.'
      : '';
    $('tool-settings-save').disabled = busy || invalid;
    const count = draft.agents.allowedModels.length;
    $('tool-settings-selection').textContent =
      `${count} model${count === 1 ? '' : 's'} selected.`;
  }
  function render() {
    renderControls();
    if (state && draft) renderModels();
  }
  async function load() {
    if (busy || disposed) return;
    const version = ++request;
    busy = true;
    failure = '';
    render();
    try {
      const [next, media] = await Promise.all([
        api.getToolSettings(sessionId),
        api.getToolModels(),
      ]);
      const image = media.find(model => model.id === 'openai-image');
      if (!image)
        throw new Error('OpenAI image model settings are unavailable.');
      if (disposed || version !== request) return;
      imageState = image;
      imageModel = image.model;
      state = next;
      draft = structuredClone(next.settings);
      draft.agents.allowedModels ??= [];
    } catch (error) {
      failure = errorText(error);
    } finally {
      busy = false;
      if (!disposed && version === request) render();
    }
  }
  async function open(focus = 'agents') {
    if (disposed || busy) return;
    hideMenu();
    sessionId = selectedSessionId() ?? undefined;
    state = undefined;
    draft = undefined;
    failure = '';
    $('tool-settings-search').value = '';
    render();
    if (!dialog.open) dialog.showModal();
    await load();
    if (!disposed && dialog.open && state && draft)
      $(focus === 'commit' ? 'commit-model' : 'tool-settings-search').focus();
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !draft || $('tool-settings-save').disabled) return;
    busy = true;
    failure = '';
    render();
    try {
      await api.saveToolSettings('all', structuredClone(draft), sessionId);
      if (imageModel !== imageState.model) {
        await api.saveToolModel('openai-image', imageModel);
        imageState.model = imageModel;
      }
      if (!disposed) dialog.close();
    } catch (error) {
      failure = errorText(error);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  function maybeNotice() {
    if (commitResolve && (commitLoaded || commitFailure)) {
      if (!disposed && !document.querySelector('dialog[open]')) {
        hideMenu();
        renderCommitNotice();
        commitNotice.showModal();
        (commitLoaded
          ? $('commit-notice-continue')
          : $('commit-notice-retry')
        ).focus();
      }
      return;
    }
    if (
      disposed ||
      !observedAgent ||
      acknowledged ||
      notice.open ||
      (!noticeLoaded && !noticeFailure) ||
      document.querySelector('dialog[open]')
    )
      return;
    hideMenu();
    renderNotice();
    notice.showModal();
    (noticeLoaded
      ? $('agent-notice-acknowledge')
      : $('agent-notice-retry')
    ).focus();
  }
  function renderNotice() {
    $('agent-notice-error').textContent = noticeFailure;
    $('agent-notice-error').hidden = !noticeFailure;
    $('agent-notice-retry').hidden = noticeLoaded;
    $('agent-notice-retry').disabled = noticeBusy;
    $('agent-notice-acknowledge').disabled = noticeBusy || !noticeLoaded;
    $('agent-notice-configure').disabled = noticeBusy || !noticeLoaded;
  }
  async function loadNotice() {
    if (noticeBusy || disposed) return;
    noticeBusy = true;
    noticeFailure = '';
    renderNotice();
    try {
      const result = await api.getAgentNotice();
      if (disposed) return;
      acknowledged = result.acknowledged;
      noticeLoaded = true;
      if (acknowledged && notice.open) notice.close();
    } catch (error) {
      noticeFailure = `Could not load the agent notice preference. ${errorText(error)}`;
    } finally {
      noticeBusy = false;
      if (!disposed) {
        renderNotice();
        maybeNotice();
      }
    }
  }
  async function acknowledge(configure = false) {
    if (noticeBusy || !noticeLoaded || disposed) return;
    noticeBusy = true;
    noticeFailure = '';
    renderNotice();
    try {
      await api.acknowledgeAgentNotice();
      if (disposed) return;
      acknowledged = true;
      notice.close();
      if (configure) open('agents');
    } catch (error) {
      noticeFailure = `Could not remember your acknowledgment. Try again. ${errorText(error)}`;
    } finally {
      noticeBusy = false;
      if (!disposed) renderNotice();
    }
  }

  function renderCommitNotice() {
    $('commit-notice-error').textContent = commitFailure;
    $('commit-notice-error').hidden = !commitFailure;
    $('commit-notice-retry').hidden = commitLoaded;
    $('commit-notice-retry').disabled = commitBusy;
    $('commit-notice-continue').disabled = commitBusy || !commitLoaded;
    $('commit-notice-configure').disabled = commitBusy || !commitLoaded;
    $('commit-notice-cancel').disabled = commitBusy;
  }
  function finishCommitNotice(proceed) {
    const resolve = commitResolve;
    commitResolve = undefined;
    commitNotice.close();
    resolve?.(proceed);
  }
  async function loadCommitNotice() {
    if (commitBusy || disposed) return;
    commitBusy = true;
    commitFailure = '';
    renderCommitNotice();
    try {
      if (!api?.getCommitNotice || !api?.acknowledgeCommitNotice)
        throw new Error(
          'Commit notice settings are unavailable. Restart or update the desktop app.',
        );
      const result = await api.getCommitNotice();
      if (disposed) return;
      commitLoaded = true;
      commitAcknowledged = result.acknowledged;
      if (commitAcknowledged) finishCommitNotice(true);
    } catch (error) {
      commitFailure = `Could not load the commit notice preference. ${errorText(error)}`;
    } finally {
      commitBusy = false;
      if (!disposed) {
        renderCommitNotice();
        maybeNotice();
      }
    }
  }
  async function acknowledgeCommit(configure = false) {
    if (commitBusy || !commitLoaded || disposed) return;
    commitBusy = true;
    commitFailure = '';
    renderCommitNotice();
    try {
      await api.acknowledgeCommitNotice();
      if (disposed) return;
      commitAcknowledged = true;
      finishCommitNotice(!configure);
      if (configure) open('commit');
    } catch (error) {
      commitFailure = `Could not remember your acknowledgment. Try again. ${errorText(error)}`;
    } finally {
      commitBusy = false;
      if (!disposed) renderCommitNotice();
    }
  }

  $('open-model-settings').disabled =
    !api?.getToolSettings ||
    !api?.saveToolSettings ||
    !api?.getToolModels ||
    !api?.saveToolModel;
  listen($('open-model-settings'), 'click', () => void open());
  listen($('tool-settings-form'), 'submit', save);
  listen($('tool-settings-close'), 'click', () => {
    if (!busy) dialog.close();
  });
  listen(dialog, 'cancel', event => {
    if (busy) event.preventDefault();
  });
  listen($('tool-settings-retry'), 'click', () => void load());
  listen($('tool-settings-search'), 'input', renderModels);
  listen($('image-model'), 'change', event => {
    imageModel = event.target.value;
    failure = '';
    renderControls();
  });
  listen($('commit-model'), 'change', event => {
    draft.commit.model = event.target.value || null;
    failure = '';
    renderControls();
  });
  listen($('commit-thinking'), 'change', event => {
    draft.commit.thinkingLevel = event.target.value || null;
    failure = '';
    renderControls();
  });
  listen($('agent-notice-retry'), 'click', () => void loadNotice());
  listen($('agent-notice-acknowledge'), 'click', () => void acknowledge());
  listen($('agent-notice-configure'), 'click', () => void acknowledge(true));
  listen(notice, 'cancel', event => {
    event.preventDefault();
    void acknowledge();
  });
  listen($('commit-notice-retry'), 'click', () => void loadCommitNotice());
  listen($('commit-notice-continue'), 'click', () => void acknowledgeCommit());
  listen(
    $('commit-notice-configure'),
    'click',
    () => void acknowledgeCommit(true),
  );
  listen($('commit-notice-cancel'), 'click', () => {
    if (!commitBusy) finishCommitNotice(false);
  });
  listen(commitNotice, 'cancel', event => {
    event.preventDefault();
    if (!commitBusy) finishCommitNotice(false);
  });
  const observer = new MutationObserver(maybeNotice);
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['open'],
  });
  if (api?.getAgentNotice && api?.acknowledgeAgentNotice) void loadNotice();
  return {
    beforePrompt(prompt) {
      if (!/^\/commit(?:\s|$)/.test(prompt.trim()) || commitAcknowledged)
        return Promise.resolve(true);
      if (disposed || commitResolve) return Promise.resolve(false);
      return new Promise(resolve => {
        commitResolve = resolve;
        commitLoaded = false;
        void loadCommitNotice();
      });
    },
    observe(snapshot) {
      if (snapshot.sessions?.some(session => session.agents?.length > 0)) {
        observedAgent = true;
        maybeNotice();
      }
    },
    dispose() {
      disposed = true;
      request++;
      observer.disconnect();
      for (const remove of listeners) remove();
      dialog.close();
      notice.close();
      finishCommitNotice(false);
    },
  };
}
