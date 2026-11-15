/**
 * @typedef {object} SceneUnit
 * @property {string} id
 * @property {string} [status]
 * @property {string} [activity]
 * @property {string} [agentMode]
 * @property {string | number} [createdAt]
 * @property {number} [creationOrder]
 * @property {boolean} [resumable]
 * @property {boolean} [primaryClosed]
 */

/** @param {SceneUnit | undefined} agent */
export function isPrimaryAgent(agent) {
  return Boolean(agent) && agent.agentMode !== 'subagent';
}

/**
 * The fixed Main agent. A legacy primaryClosed marker cannot remove it.
 * @param {{session?: SceneUnit, agents?: SceneUnit[]} | undefined} data
 * @returns {{id: string, unit: SceneUnit} | undefined}
 */
export function mainUnit(data) {
  const main = data?.session;
  if (!main) return undefined;
  return {
    id: 'parent',
    unit: main.primaryClosed ? {...main, primaryClosed: false} : main,
  };
}

/**
 * Main and available additional primary conversations.
 * @param {{session?: SceneUnit, agents?: SceneUnit[]} | undefined} data
 * @returns {{id: string, unit: SceneUnit}[]}
 */
export function primaryUnits(data) {
  const additional = (data?.agents || [])
    .map(unit => ({id: unit.id, unit}))
    .filter(
      ({unit}) =>
        isPrimaryAgent(unit) &&
        unit.resumable !== false &&
        unit.status !== 'closed',
    )
    .sort((a, b) => {
      const created = unit => {
        const value = unit.createdAt;
        return typeof value === 'number' ? value : Date.parse(value) || 0;
      };
      const order = unit =>
        Number.isSafeInteger(unit.creationOrder) && unit.creationOrder >= 0
          ? unit.creationOrder
          : -1;
      return (
        created(b.unit) - created(a.unit) ||
        order(b.unit) - order(a.unit) ||
        b.id.localeCompare(a.id)
      );
    })
    .map(({id, unit}) => ({id, unit}));
  const main = mainUnit(data);
  return main ? [main, ...additional] : additional;
}

/**
 * The workspace root is always its fixed Main conversation.
 * @param {{session?: SceneUnit, agents?: SceneUnit[]} | undefined} data
 * @returns {{id: string, unit: SceneUnit} | undefined}
 */
export function primaryUnit(data) {
  return mainUnit(data);
}
