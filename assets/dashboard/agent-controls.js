/* global document */
export function initAgentControls({api, selected, selectedAgent, refresh}) {
  const all = document.getElementById('cancel-all-agents');
  const one = document.getElementById('cancel-agent');
  const allError = document.getElementById('cancel-all-agents-error');
  const oneError = document.getElementById('cancel-agent-error');
  const pending = new Set();
  const errors = new Map();
  const key = (sessionId, agentId) => `${sessionId}:${agentId}`;
  const cancellable = agent => ['queued', 'running'].includes(agent.status);
  function render() {
    const data = selected();
    const agent = data?.agents.find(item => item.id === selectedAgent());
    const sessionId = data?.session.id;
    const controllable =
      data && (data.session.controllable ?? data.session.owned);
    const allPending = pending.has(key(sessionId, 'all'));
    const onePending = pending.has(key(sessionId, agent?.id));
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
    for (const [element, agentId] of [
      [allError, 'all'],
      [oneError, agent?.id],
    ]) {
      const message = errors.get(key(sessionId, agentId));
      element.textContent = message || '';
      element.hidden = !message;
    }
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
      errors.set(id, error instanceof Error ? error.message : String(error));
    } finally {
      pending.delete(id);
      refresh();
      render();
    }
  }
  all.addEventListener('click', () => void cancel('all'));
  one.addEventListener('click', () => void cancel(selectedAgent()));
  return {render};
}
