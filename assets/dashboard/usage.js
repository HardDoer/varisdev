/* global document */
const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat().format(value || 0);
const cost = value => `$${(value || 0).toFixed(4)}`;
let current;
let reveal;
const selectedUnits = new Map();
let latest;

function setText(id, value) {
  const element = $(id);
  if (element.textContent !== value) element.textContent = value;
}
function meter(id, used, limit) {
  const element = $(id);
  const percent =
    limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  element.style.setProperty('--used', `${percent}%`);
  element.setAttribute('aria-valuenow', String(used || 0));
  element.setAttribute('aria-valuemax', String(limit || 1));
  element.classList.toggle('over-budget', limit > 0 && used > limit);
}
export function initUsage(onReveal) {
  reveal = onReveal;
  $('usage-unit').addEventListener('change', () => {
    if (!latest) return;
    selectedUnits.set(latest.session.id, $('usage-unit').value);
    renderUsage(latest);
  });
}
export function renderUsage(snapshot) {
  latest = snapshot;
  const units = [
    {id: 'parent', name: `${snapshot.session.name} · parent`},
    ...snapshot.agents.map(agent => ({
      id: agent.id,
      name: `${agent.name} · worker`,
    })),
  ];
  const selector = $('usage-unit');
  const unitsSignature = JSON.stringify(units);
  if (selector.dataset.signature !== unitsSignature) {
    selector.dataset.signature = unitsSignature;
    selector.replaceChildren(
      ...units.map(unit => {
        const option = document.createElement('option');
        option.value = unit.id;
        option.textContent = unit.name;
        return option;
      }),
    );
  }
  const worker = snapshot.agents.find(
    agent => agent.id === selectedUnits.get(snapshot.session.id),
  );
  selector.value = worker?.id || 'parent';
  const data = worker
    ? {
        session: {id: `${snapshot.session.id}/${worker.id}`, name: worker.name},
        usage: worker.usage,
      }
    : snapshot;
  $('usage-context-section').hidden = !!worker;
  const changedSession = current?.session.id !== data.session.id;
  current = data;
  const usage = data.usage || {};
  const context = data.session.context;
  setText('usage-recipient', `Model usage for ${data.session.name}`);
  setText(
    'usage-context',
    typeof context?.tokens !== 'number'
      ? 'Available after the next response'
      : `${number(context.tokens)} / ${number(context.window)} tokens`,
  );
  meter('context-budget-meter', context?.tokens, context?.window);
  $('context-budget-meter').hidden = typeof context?.tokens !== 'number';
  setText('usage-input', number(usage.input));
  setText('usage-output', number(usage.output));
  setText('usage-cache-read', number(usage.cacheRead));
  setText('usage-cache-write', number(usage.cacheWrite));
  setText('usage-total', number(usage.totalTokens));
  setText('usage-cost', cost(usage.cost));
  const total =
    (usage.input || 0) +
    (usage.output || 0) +
    (usage.cacheRead || 0) +
    (usage.cacheWrite || 0);
  for (const [id, key] of [
    ['input', 'input'],
    ['output', 'output'],
    ['cache-read', 'cacheRead'],
    ['cache-write', 'cacheWrite'],
  ]) {
    $(`usage-bar-${id}`).style.width =
      `${total ? ((usage[key] || 0) / total) * 100 : 0}%`;
  }
  $('usage-breakdown').setAttribute(
    'aria-label',
    `Input ${number(usage.input)}, output ${number(usage.output)}, cache read ${number(usage.cacheRead)}, cache write ${number(usage.cacheWrite)} tokens`,
  );
  const calls = usage.calls || [];
  const tbody = $('usage-calls');
  const signature = JSON.stringify(calls);
  if (tbody.dataset.signature !== signature || changedSession) {
    tbody.dataset.signature = signature;
    tbody.replaceChildren(
      ...calls.toReversed().map(call => {
        const row = document.createElement('tr');
        const description = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'usage-call-link';
        button.textContent =
          call.kind === 'compaction'
            ? 'Compaction summary'
            : call.kind === 'usage'
              ? call.usageKind === 'cache_warm'
                ? 'Cache warming'
                : 'Model operation'
              : call.toolNames?.length
                ? `Requested ${call.toolNames.join(', ')}`
                : 'Assistant response';
        const hasConversationMessage =
          call.kind === undefined || call.kind === 'response';
        button.disabled = !!worker || !hasConversationMessage;
        button.title = worker
          ? 'Worker call details are saved in its session file.'
          : !hasConversationMessage
            ? 'This model operation has no conversation message.'
            : 'Show this model call in Conversation';
        button.addEventListener('click', () => reveal(call));
        const detail = document.createElement('small');
        detail.textContent = `${new Date(call.at).toLocaleTimeString()} · ${call.model}${call.stopReason === 'error' ? ' · Error' : call.stopReason === 'aborted' ? ' · Stopped' : ''}`;
        description.append(button, detail);
        row.append(description);
        for (const value of [
          number(call.input),
          number(call.output),
          number(call.cacheRead),
          number(call.cacheWrite),
          cost(call.cost),
        ]) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.append(cell);
        }
        return row;
      }),
    );
  }
  $('usage-empty').hidden = calls.length > 0;
  $('usage-table').hidden = calls.length === 0;
  $('usage-truncated').hidden = !usage.truncated;
}
