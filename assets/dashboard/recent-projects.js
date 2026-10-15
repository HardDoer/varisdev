/* global document */

export function initRecentProjects({api, open}) {
  const section = document.getElementById('recent-projects');
  const list = document.getElementById('recent-projects-list');
  const status = document.getElementById('recent-projects-status');
  const error = document.getElementById('recent-projects-error');
  let revision = 0;
  let disposed = false;
  let busy = false;

  function setBusy(value) {
    busy = value;
    for (const button of list.querySelectorAll('button'))
      button.disabled = busy;
    list.setAttribute('aria-busy', String(busy));
  }

  async function refresh() {
    if (!api?.recentProjects || disposed) return;
    const request = ++revision;
    section.hidden = false;
    error.hidden = true;
    status.textContent = 'Loading recent projects…';
    try {
      const folders = await api.recentProjects();
      if (disposed || request !== revision) return;
      const items = folders.map(cwd => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'recent-project quiet-button';
        button.title = `Open ${cwd}`;
        const name = document.createElement('strong');
        name.textContent = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
        const path = document.createElement('span');
        path.textContent = cwd;
        button.append(name, path);
        button.addEventListener('click', () => {
          if (busy || disposed) return;
          setBusy(true);
          error.hidden = true;
          void Promise.resolve()
            .then(() => open(cwd))
            .catch(problem => {
              if (disposed) return;
              error.textContent = problem.message || String(problem);
              error.hidden = false;
            })
            .finally(() => {
              if (!disposed) setBusy(false);
            });
        });
        item.append(button);
        return item;
      });
      list.replaceChildren(...items);
      setBusy(busy);
      status.textContent = items.length
        ? ''
        : 'Projects you open will appear here.';
    } catch (problem) {
      if (disposed || request !== revision) return;
      status.textContent = '';
      error.textContent = `Could not load recent projects: ${problem.message || String(problem)}`;
      error.hidden = false;
    }
  }

  void refresh();
  return {
    refresh,
    setBusy,
    dispose() {
      disposed = true;
      revision++;
      list.replaceChildren();
    },
  };
}
