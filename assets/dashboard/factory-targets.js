export function validSceneTarget(target) {
  return (
    target !== null &&
    typeof target === 'object' &&
    ((typeof target.id === 'string' && target.id.length > 0) ||
      (typeof target.id === 'number' && Number.isFinite(target.id))) &&
    [target.x, target.y, target.radius].every(Number.isFinite) &&
    target.radius > 0
  );
}

export function visibleSceneTargets(targets, rect, viewport) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    target =>
      validSceneTarget(target) &&
      target.x >= Math.max(0, rect.left) &&
      target.x <= Math.min(viewport.innerWidth, rect.right) &&
      target.y >= Math.max(0, rect.top) &&
      target.y <= Math.min(viewport.innerHeight, rect.bottom),
  );
}
