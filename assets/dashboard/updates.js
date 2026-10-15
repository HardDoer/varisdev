/* global document */

export function initUpdates(
  api,
  {beforeRestart = () => {}, selectedSessionId = () => undefined} = {},
) {
  if (!api?.getUpdateStatus || !api.onUpdateStatus || !api.onShowUpdates)
    return () => {};
  const $ = id => document.getElementById(id);
  const badge = $('updates-button');
  const dialog = $('updates-dialog');
  const message = $('updates-message');
  const error = $('updates-error');
  const action = $('updates-action');
  const check = $('updates-check');
  let status = {phase: 'idle'};
  let busy = false;
  let failure = '';
  let revision = 0;
  let disposed = false;

  function render() {
    const phase = status.phase;
    const working = busy || phase === 'checking' || phase === 'updating';
    badge.hidden = phase === 'idle' || phase === 'checking';
    badge.textContent =
      {
        checking: 'Checking for updates…',
        available: 'Updates available',
        updating: 'Updating VarisDev…',
        ready: 'Restart to finish update',
        error: 'Update needs attention',
      }[phase] || 'Updates available';
    badge.classList.toggle('error', phase === 'error');
    message.textContent =
      {
        idle: status.checkedAt
          ? 'VarisDev is up to date.'
          : 'Check for VarisDev updates.',
        checking: 'Checking for updates…',
        available: 'Updates are available for VarisDev.',
        updating: 'Updating VarisDev…',
        ready: 'Restart to finish updating VarisDev.',
        error: 'The update could not be completed.',
      }[phase] || '';
    error.textContent = failure || status.error || '';
    error.hidden = !error.textContent;
    action.hidden = !['available', 'updating', 'ready', 'error'].includes(
      phase,
    );
    action.disabled = working;
    action.textContent =
      phase === 'ready'
        ? 'Restart to finish update'
        : phase === 'error'
          ? 'Retry update'
          : phase === 'updating'
            ? 'Updating…'
            : 'Install update';
    check.hidden = ['available', 'updating', 'ready'].includes(phase);
    check.disabled = working || phase === 'ready';
    dialog.setAttribute('aria-busy', String(working));
  }
  function receive(next) {
    if (disposed) return;
    revision++;
    status = next;
    failure = '';
    render();
  }
  function open() {
    if (!dialog.open) dialog.showModal();
    render();
  }
  function close() {
    dialog.close();
  }
  async function run(operation) {
    if (busy) return;
    busy = true;
    failure = '';
    render();
    try {
      const next = await operation();
      if (next) receive(next);
    } catch (problem) {
      if (!disposed) failure = problem.message || String(problem);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  function checkUpdates() {
    return run(() => api.checkUpdates());
  }
  function update() {
    return run(async () => {
      if (status.phase !== 'ready') return api.installUpdate();
      await beforeRestart();
      return api.restartUpdate(selectedSessionId() ?? undefined);
    });
  }
  badge.addEventListener('click', open);
  $('updates-close').addEventListener('click', close);
  check.addEventListener('click', checkUpdates);
  action.addEventListener('click', update);
  const unsubscribe = api.onUpdateStatus(receive);
  const unsubscribeMenu = api.onShowUpdates(open);
  const initialRevision = revision;
  api
    .getUpdateStatus()
    .then(next => {
      if (!disposed && revision === initialRevision) receive(next);
    })
    .catch(problem => {
      if (disposed || revision !== initialRevision) return;
      status = {phase: 'error'};
      failure = problem.message || String(problem);
      render();
    });
  render();
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeMenu();
    badge.removeEventListener('click', open);
    $('updates-close').removeEventListener('click', close);
    check.removeEventListener('click', checkUpdates);
    action.removeEventListener('click', update);
  };
}
