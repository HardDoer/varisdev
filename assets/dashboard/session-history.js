/* global document */

export function initSessionHistory({api, currentFolder, opened}) {
  const $ = id => document.getElementById(id);
  const button = $('resume-session');
  const dialog = $('session-history-dialog');
  const close = $('session-history-close');
  const choose = $('session-history-choose');
  const list = $('session-history-list');
  const status = $('session-history-status');
  const error = $('session-history-error');
  let cwd;
  let revision = 0;
  let resuming = false;
  let disposed = false;

  if (!api?.listSessions) {
    button.disabled = true;
    return () => {};
  }

  function showError(problem) {
    error.textContent = problem.message || String(problem);
    error.hidden = false;
  }
  async function resume(sessionId) {
    if (resuming) return;
    resuming = true;
    error.hidden = true;
    close.disabled = choose.disabled = true;
    for (const item of list.querySelectorAll('button')) item.disabled = true;
    status.textContent = 'Opening session…';
    try {
      const result = await api.createSession({cwd, sessionId});
      if (disposed) return;
      dialog.close();
      await opened(result.id);
    } catch (problem) {
      if (!disposed) showError(problem);
    } finally {
      resuming = false;
      close.disabled = choose.disabled = false;
      for (const item of list.querySelectorAll('button')) item.disabled = false;
      status.textContent = '';
    }
  }
  async function load(folder) {
    const request = ++revision;
    cwd = folder;
    $('session-history-folder').textContent = cwd;
    list.replaceChildren();
    error.hidden = true;
    status.textContent = 'Loading sessions…';
    try {
      const sessions = await api.listSessions(cwd);
      if (disposed || request !== revision) return;
      status.textContent = sessions.length
        ? ''
        : 'No saved sessions in this folder.';
      for (const session of sessions) {
        const item = document.createElement('li');
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'quiet-button';
        const title = document.createElement('strong');
        title.textContent =
          session.name || session.firstMessage || 'Untitled session';
        const details = document.createElement('span');
        details.textContent = `${new Date(session.modified).toLocaleString()} · ${session.messageCount} messages`;
        action.append(title, details);
        action.addEventListener('click', () => void resume(session.id));
        item.append(action);
        list.append(item);
      }
    } catch (problem) {
      if (disposed || request !== revision) return;
      status.textContent = '';
      showError(problem);
    }
  }
  function open() {
    if (dialog.open) return;
    dialog.showModal();
    void load(currentFolder());
  }
  function dismiss(event) {
    if (resuming) {
      event.preventDefault();
      return;
    }
    revision++;
    dialog.close();
  }
  async function chooseFolder() {
    choose.disabled = true;
    const request = revision;
    try {
      const folder = await api.chooseFolder();
      if (!disposed && request === revision && folder) await load(folder);
    } catch (problem) {
      if (!disposed && request === revision) showError(problem);
    } finally {
      choose.disabled = resuming;
    }
  }
  button.addEventListener('click', open);
  close.addEventListener('click', dismiss);
  choose.addEventListener('click', chooseFolder);
  dialog.addEventListener('cancel', dismiss);
  return () => {
    disposed = true;
    revision++;
    button.removeEventListener('click', open);
    close.removeEventListener('click', dismiss);
    choose.removeEventListener('click', chooseFolder);
    dialog.removeEventListener('cancel', dismiss);
  };
}
