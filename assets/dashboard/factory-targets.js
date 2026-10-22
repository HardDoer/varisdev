function validPolygon(polygon) {
  if (
    !Array.isArray(polygon) ||
    polygon.length < 3 ||
    polygon.length > 64 ||
    !polygon.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
  )
    return false;
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) > 0.001;
}

export function sceneTargetContains(target, x, y) {
  if (!target.polygon)
    return Math.hypot(target.x - x, target.y - y) <= target.radius;
  return polygonContains(target.polygon, x, y);
}

function polygonContains(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j],
      b = points[i];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (
      Math.abs(cross) < 0.001 &&
      x >= Math.min(a.x, b.x) &&
      x <= Math.max(a.x, b.x) &&
      y >= Math.min(a.y, b.y) &&
      y <= Math.max(a.y, b.y)
    )
      return true;
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

function closestPoint(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return {x: a.x + dx * t, y: a.y + dy * t};
}

/** Contact on a face touched by a swept polygon, with optional shaft thickness. */
export function polygonContact(polygon, sweep, margin = 0) {
  if (!validPolygon(polygon) || !Array.isArray(sweep) || !sweep.length)
    return null;
  const left = Math.min(...sweep.map(p => p.x)) - margin;
  const right = Math.max(...sweep.map(p => p.x)) + margin;
  const top = Math.min(...sweep.map(p => p.y)) - margin;
  const bottom = Math.max(...sweep.map(p => p.y)) + margin;
  if (
    Math.max(...polygon.map(p => p.x)) < left ||
    Math.min(...polygon.map(p => p.x)) > right ||
    Math.max(...polygon.map(p => p.y)) < top ||
    Math.min(...polygon.map(p => p.y)) > bottom
  )
    return null;
  for (const p of sweep)
    if (polygonContains(polygon, p.x, p.y)) return {x: p.x, y: p.y};
  for (const p of polygon)
    if (polygonContains(sweep, p.x, p.y)) return {x: p.x, y: p.y};
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    for (let j = 0; j < sweep.length; j++) {
      const c = sweep[j],
        d = sweep[(j + 1) % sweep.length];
      const ux = b.x - a.x,
        uy = b.y - a.y,
        vx = d.x - c.x,
        vy = d.y - c.y;
      const cross = ux * vy - uy * vx;
      if (Math.abs(cross) > 1e-9) {
        const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / cross;
        const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / cross;
        if (t >= 0 && t <= 1 && s >= 0 && s <= 1)
          return {x: a.x + ux * t, y: a.y + uy * t};
      }
      if (margin > 0) {
        for (const p of [c, d]) {
          const q = closestPoint(p, a, b);
          if (Math.hypot(p.x - q.x, p.y - q.y) <= margin) return q;
        }
        for (const p of [a, b]) {
          const q = closestPoint(p, c, d);
          if (Math.hypot(p.x - q.x, p.y - q.y) <= margin)
            return {x: p.x, y: p.y};
        }
      }
    }
  }
  return null;
}

function polygonBounds(points) {
  return {
    left: Math.min(...points.map(p => p.x)),
    right: Math.max(...points.map(p => p.x)),
    top: Math.min(...points.map(p => p.y)),
    bottom: Math.max(...points.map(p => p.y)),
  };
}
function overlap(a, b) {
  return (
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top
  );
}

// Index only polygon scenery. Each face sees earlier painted faces in nearby
// viewport cells; circular robot targeting remains independent of this index.
export function polygonOcclusion(targets) {
  const cells = new Map(),
    all = [],
    large = [],
    result = new Map();
  const keys = bounds => {
    const left = Math.floor(bounds.left / 96),
      right = Math.floor(bounds.right / 96);
    const top = Math.floor(bounds.top / 96),
      bottom = Math.floor(bounds.bottom / 96);
    if ((right - left + 1) * (bottom - top + 1) > 256) return null;
    const keys = [];
    for (let x = left; x <= right; x++)
      for (let y = top; y <= bottom; y++) keys.push(`${x}:${y}`);
    return keys;
  };
  for (const target of targets) {
    if (!target?.polygon || !validSceneTarget(target)) continue;
    const bounds = polygonBounds(target.polygon),
      at = keys(bounds);
    const candidates = at
      ? new Set([...large, ...at.flatMap(key => cells.get(key) || [])])
      : new Set(all);
    result.set(
      target,
      [...candidates]
        .filter(face => overlap(bounds, face.bounds))
        .map(face => face.polygon),
    );
    const face = {polygon: target.polygon, bounds};
    all.push(face);
    if (!at) large.push(face);
    else
      for (const key of at) {
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(face);
      }
  }
  return result;
}

const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const signedArea = points =>
  points.reduce((n, a, i) => {
    const b = points[(i + 1) % points.length];
    return n + a.x * b.y - b.x * a.y;
  }, 0);

function convexParts(points) {
  const direction = Math.sign(signedArea(points));
  if (
    points.every(
      (p, i) =>
        cross(
          p,
          points[(i + 1) % points.length],
          points[(i + 2) % points.length],
        ) *
          direction >=
        -1e-9,
    )
  )
    return [points];
  const rest = [...points],
    triangles = [];
  while (rest.length > 3) {
    const index = rest.findIndex((b, i) => {
      const a = rest[(i + rest.length - 1) % rest.length],
        c = rest[(i + 1) % rest.length];
      return (
        cross(a, b, c) * direction > 1e-9 &&
        !rest.some(
          p =>
            p !== a &&
            p !== b &&
            p !== c &&
            polygonContains([a, b, c], p.x, p.y),
        )
      );
    });
    if (index < 0) return [];
    triangles.push([
      rest[(index + rest.length - 1) % rest.length],
      rest[index],
      rest[(index + 1) % rest.length],
    ]);
    rest.splice(index, 1);
  }
  return [...triangles, rest];
}

function halfPlane(points, a, b, direction) {
  const output = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i],
      q = points[(i + 1) % points.length];
    const dp = cross(a, b, p) * direction,
      dq = cross(a, b, q) * direction;
    if (dp >= 0) output.push(p);
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      const t = dp / (dp - dq);
      output.push({x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t});
    }
  }
  return output;
}
function subtractConvex(points, cover) {
  const direction = Math.sign(signedArea(cover)),
    pieces = [];
  let remaining = points;
  for (let i = 0; i < cover.length && remaining.length; i++) {
    const a = cover[i],
      b = cover[(i + 1) % cover.length];
    const outside = halfPlane(remaining, a, b, -direction);
    if (outside.length >= 3 && Math.abs(signedArea(outside)) > 1e-8)
      pieces.push(outside);
    remaining = halfPlane(remaining, a, b, direction);
  }
  return pieces;
}

/** Find a contact in the exposed remainder, including partly covered faces. */
export function exposedPolygonContact(polygon, sweep, margin = 0, covers = []) {
  const first = polygonContact(polygon, sweep, margin);
  if (!first) return null;
  const covered = p => covers.some(cover => polygonContains(cover, p.x, p.y));
  if (!covered(first)) return first;
  let pieces = convexParts(polygon);
  for (const cover of covers) {
    const bounds = polygonBounds(cover);
    for (const part of convexParts(cover)) {
      pieces = pieces.flatMap(piece =>
        overlap(polygonBounds(piece), bounds)
          ? subtractConvex(piece, part)
          : [piece],
      );
      if (!pieces.length) return null;
    }
  }
  for (const piece of pieces) {
    const contact = polygonContact(piece, sweep, margin);
    if (!contact) continue;
    const center = {
      x: piece.reduce((n, p) => n + p.x, 0) / piece.length,
      y: piece.reduce((n, p) => n + p.y, 0) / piece.length,
    };
    for (const t of [0, 1e-6, 1e-4, 0.01, 0.5, 1]) {
      const point = {
        x: contact.x + (center.x - contact.x) * t,
        y: contact.y + (center.y - contact.y) * t,
      };
      if (covered(point)) continue;
      if (
        polygonContains(sweep, point.x, point.y) ||
        (margin > 0 &&
          sweep.some((a, i) => {
            const q = closestPoint(point, a, sweep[(i + 1) % sweep.length]);
            return Math.hypot(point.x - q.x, point.y - q.y) <= margin;
          }))
      )
        return point;
    }
  }
  return null;
}

export function validSceneTarget(target) {
  return (
    target !== null &&
    typeof target === 'object' &&
    ((typeof target.id === 'string' && target.id.length > 0) ||
      (typeof target.id === 'number' && Number.isFinite(target.id))) &&
    [target.x, target.y, target.radius].every(Number.isFinite) &&
    target.radius > 0 &&
    (target.polygon === undefined || validPolygon(target.polygon))
  );
}

export function visibleSceneTargets(targets, rect, viewport) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(
    target =>
      validSceneTarget(target) &&
      (target.polygon
        ? Math.max(...target.polygon.map(p => p.x)) >= Math.max(0, rect.left) &&
          Math.min(...target.polygon.map(p => p.x)) <=
            Math.min(viewport.innerWidth, rect.right) &&
          Math.max(...target.polygon.map(p => p.y)) >= Math.max(0, rect.top) &&
          Math.min(...target.polygon.map(p => p.y)) <=
            Math.min(viewport.innerHeight, rect.bottom)
        : target.x >= Math.max(0, rect.left) &&
          target.x <= Math.min(viewport.innerWidth, rect.right) &&
          target.y >= Math.max(0, rect.top) &&
          target.y <= Math.min(viewport.innerHeight, rect.bottom)),
  );
}
