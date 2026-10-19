/* global document, localStorage */
const storageKey = 'varisdev.dismissed-agents.v1';
const activeStatuses = new Set(['queued', 'running', 'cancelling']);
const finishedStatuses = new Set(['cancelled', 'completed', 'failed']);

export function initAgentControls({
  api,
  selected,
  selectedAgent,
  refresh,
  removed = () => {},
}) {
  const all = document.getElementById('cancel-all-agents');
  const one = document.getElementById('cancel-agent');
  const remove = document.getElementById('remove-agent');
  const allError = document.getElementById('cancel-all-agents-error');
  const oneError = document.getElementById('cancel-agent-error');
  const pending = new Set();
  const errors = new Map();
  const dismissed = new Map();
  const key = (sessionId, agentId) => `${sessionId}:${agentId}`;
  const cancellable = agent => ['queued', 'running'].includes(agent.status);
  const removable = agent =>
    agent?.resumable === false || finishedStatuses.has(agent?.status);

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (
          !Array.isArray(entry) ||
          typeof entry[0] !== 'string' ||
          !Array.isArray(entry[1])
        )
          continue;
        const ids = entry[1].filter(id => typeof id === 'string');
        if (ids.length) dismissed.set(entry[0], new Set(ids));
      }
    }
  } catch {
    // Keep dismissals in memory when stored preferences are unavailable.
  }

  function persistDismissed() {
    try {
      const saved = [...dismissed]
        .filter(([, ids]) => ids.size)
        .map(([sessionId, ids]) => [sessionId, [...ids]]);
      if (saved.length) localStorage.setItem(storageKey, JSON.stringify(saved));
      else localStorage.removeItem(storageKey);
    } catch {
      // The current window still keeps the dismissal.
    }
  }

  function filterHub(hub) {
    if (!hub || !Array.isArray(hub.sessions)) return hub;
    let storageChanged = false;
    let hubChanged = false;
    const sessions = hub.sessions.map(data => {
      const sessionId = data?.session?.id;
      const ids = dismissed.get(sessionId);
      if (!ids?.size || !Array.isArray(data.agents)) return data;
      for (const agent of data.agents) {
        if (
          ids.has(agent.id) &&
          agent.resumable !== false &&
          activeStatuses.has(agent.status)
        ) {
          ids.delete(agent.id);
          storageChanged = true;
        }
      }
      if (!ids.size) {
        dismissed.delete(sessionId);
        return data;
      }
      const agents = data.agents.filter(agent => !ids.has(agent.id));
      const filteredCount = data.agents.length - agents.length;
      if (!filteredCount) return data;
      const totalAgents = Math.max(
        0,
        (data.totalAgents ?? data.agents.length) - filteredCount,
      );
      hubChanged = true;
      return {...data, agents, totalAgents};
    });
    if (storageChanged) persistDismissed();
    return hubChanged ? {...hub, sessions} : hub;
  }

  function render() {
    const data = selected();
    const agent = data?.agents.find(item => item.id === selectedAgent());
    const sessionId = data?.session.id;
    const controllable =
      data && (data.session.controllable ?? data.session.owned);
    const allPending = pending.has(key(sessionId, 'all'));
    const onePending = pending.has(key(sessionId, agent?.id));
    const canRemove = removable(agent);
    if (canRemove) errors.delete(key(sessionId, agent.id));
    all.disabled =
      !api || !controllable || allPending || !data.agents.some(cancellable);
    all.textContent = allPending ? 'Cancelling…' : 'Cancel all agents';
    one.hidden = !agent;
    one.disabled =
      !api ||
      !controllable ||
      allPending ||
      onePending ||
      !agent ||
      !cancellable(agent);
    one.textContent =
      onePending || agent?.status === 'cancelling'
        ? 'Cancelling…'
        : 'Cancel agent';
    one.setAttribute(
      'aria-label',
      agent ? `Cancel agent ${agent.name}` : 'Cancel agent',
    );
    remove.hidden = !canRemove;
    remove.disabled = !canRemove;
    remove.textContent = 'Remove agent';
    remove.setAttribute(
      'aria-label',
      agent ? `Remove agent ${agent.name}` : 'Remove agent',
    );
    const allMessage = errors.get(key(sessionId, 'all'));
    allError.textContent = allMessage || '';
    allError.hidden = !allMessage;
    const oneMessage = canRemove
      ? undefined
      : errors.get(key(sessionId, agent?.id));
    oneError.textContent = oneMessage || '';
    oneError.hidden = !oneMessage;
  }

  async function cancel(agentId) {
    const data = selected();
    if (!api || !data || !agentId) return;
    const sessionId = data.session.id;
    const id = key(sessionId, agentId);
    if (pending.has(id)) return;
    pending.add(id);
    errors.delete(id);
    render();
    try {
      await api.cancelAgent(sessionId, agentId);
    } catch (error) {
      if (!dismissed.get(sessionId)?.has(agentId))
        errors.set(id, error instanceof Error ? error.message : String(error));
    } finally {
      pending.delete(id);
      refresh();
      render();
    }
  }

  function dismiss(
    sessionId = selected()?.session.id,
    agentId = selectedAgent(),
  ) {
    const data = selected();
    const agent =
      data?.session.id === sessionId
        ? data.agents.find(item => item.id === agentId)
        : undefined;
    if (agent && !removable(agent)) return;
    if (!sessionId || !agentId) return;
    const ids = dismissed.get(sessionId) || new Set();
    ids.add(agentId);
    dismissed.set(sessionId, ids);
    pending.delete(key(sessionId, agentId));
    errors.delete(key(sessionId, agentId));
    persistDismissed();
    removed();
    render();
  }

  all.addEventListener('click', () => void cancel('all'));
  one.addEventListener('click', () => void cancel(selectedAgent()));
  remove.addEventListener('click', () => dismiss());
  return {render, filterHub, dismiss};
}
