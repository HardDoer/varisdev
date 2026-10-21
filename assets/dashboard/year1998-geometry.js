export const iso = (x, z, h = 0) => [(x - z) * 14, (x + z) * 7 - h];

// Footprints order objects separated along either room axis. Center depth alone
// puts a wide desk in front of objects that actually stand beyond its front edge.
export function sortOfficeObjects(objects) {
  const remaining = objects
    .map(object => ({
      ...object,
      left: object.x - object.w / 2,
      right: object.x + object.w / 2,
      back: object.z - object.d / 2,
      front: object.z + object.d / 2,
    }))
    .sort((a, b) => a.x + a.z - (b.x + b.z));
  const behind = (a, b) => a.right <= b.left || a.front <= b.back;
  const ordered = [];
  while (remaining.length) {
    const index = remaining.findIndex(
      object =>
        !remaining.some(
          other => behind(other, object) && !behind(object, other),
        ),
    );
    // Intersecting footprints (including moving visitors) keep center order.
    ordered.push(remaining.splice(Math.max(0, index), 1)[0]);
  }
  return ordered;
}
