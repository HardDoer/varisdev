/**
 * @typedef {object} SceneUnit
 * @property {string} id
 * @property {string} [status]
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
 * Remaining primary conversations, with the starter first while it is open.
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
  const starter = data?.session;
  return starter && !starter.primaryClosed && starter.status !== 'closed'
    ? [{id: 'parent', unit: starter}, ...additional]
    : additional;
}

/**
 * The large robot belongs to the starter, then the second newest primary.
 * @param {{session?: SceneUnit, agents?: SceneUnit[]} | undefined} data
 * @returns {{id: string, unit: SceneUnit} | undefined}
 */
export function primaryUnit(data) {
  const units = primaryUnits(data);
  return units[0]?.id === 'parent' ? units[0] : units[1] || units[0];
}
