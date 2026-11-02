/* global document */

export function initWorkspaceRename({api, current, sessions, renamed}) {
  const $ = id => document.getElementById(id);
  const button = $('rename-workspace');
  const dialog = $('rename-workspace-dialog');
  const form = $('rename-workspace-form');
  const input = $('rename-workspace-name');
  const cancel = $('rename-workspace-cancel');
  const save = $('rename-workspace-save');
  const error = $('rename-workspace-error');
  let target;
  let busy = false;
  let disposed = false;
  const available = session =>
    session &&
    (session.controllable ?? session.owned) &&
    session.status !== 'closed';

  function clearError() {
    error.hidden = true;
    input.removeAttribute('aria-invalid');
  }
  function showError(message, invalid = false) {
    error.textContent = message;
    error.hidden = false;
    if (invalid) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  }
  function setBusy(value) {
    busy = value;
    input.disabled = cancel.disabled = save.disabled = value;
    save.textContent = value ? 'Saving…' : 'Save';
  }
  function close() {
    target = undefined;
    if (dialog.open) dialog.close();
  }
  function open() {
    if (disposed || busy || dialog.open || !api?.renameSession) return;
    const session = current();
    if (!available(session)) return;
    target = session.id;
    clearError();
    input.value = session.name;
    setBusy(false);
    dialog.showModal();
    input.focus();
    input.select();
  }
  function dismiss(event) {
    event.preventDefault();
    if (!busy) close();
  }
  async function submit(event) {
    event.preventDefault();
    if (!target || busy) return;
    const name = input.value.trim();
    if (!name || input.value.length > 120) {
      showError('Workspace name must contain 1 to 120 characters.', true);
      return;
    }
    if (!available(sessions().find(session => session.id === target))) {
      close();
      return;
    }
    const id = target;
    clearError();
    setBusy(true);
    try {
      await api.renameSession(id, name);
      if (!disposed && target === id) {
        close();
        renamed();
      }
    } catch (problem) {
      if (!disposed && target === id)
        showError(problem.message || String(problem));
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  button.addEventListener('click', open);
  cancel.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', dismiss);
  form.addEventListener('submit', submit);
  input.addEventListener('input', clearError);
  return {
    sync() {
      if (
        target &&
        !available(sessions().find(session => session.id === target))
      )
        close();
    },
    dispose() {
      disposed = true;
      close();
      button.removeEventListener('click', open);
      cancel.removeEventListener('click', dismiss);
      dialog.removeEventListener('cancel', dismiss);
      form.removeEventListener('submit', submit);
      input.removeEventListener('input', clearError);
    },
  };
}
