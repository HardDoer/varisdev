const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const finitePoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const MAX_MARKS = 32;

// Faces are captured from the same filled primitives that paint the office.
// Local distances follow each face's projected axes, including vertical walls.
export function officeSurface(points, material) {
  if (
    !Array.isArray(points) ||
    points.length !== 4 ||
    !points.every(
      p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
    )
  )
    return null;
  const [a, b, c, d] = points;
  if (
    Math.abs(a[0] + c[0] - b[0] - d[0]) > 0.01 ||
    Math.abs(a[1] + c[1] - b[1] - d[1]) > 0.01
  )
    return null;
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const height = Math.hypot(d[0] - a[0], d[1] - a[1]);
  if (!width || !height) return null;
  const u = [(b[0] - a[0]) / width, (b[1] - a[1]) / width];
  const v = [(d[0] - a[0]) / height, (d[1] - a[1]) / height];
  const det = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(det) < 0.01) return null;
  const bounds = {
    left: Math.min(...points.map(p => p[0])),
    right: Math.max(...points.map(p => p[0])),
    top: Math.min(...points.map(p => p[1])),
    bottom: Math.max(...points.map(p => p[1])),
  };
  return {points, material, origin: a, u, v, width, height, det, bounds};
}

function localPoint(face, point) {
  const x = point.x - face.origin[0],
    y = point.y - face.origin[1];
  return {
    x: (x * face.v[1] - y * face.v[0]) / face.det,
    y: (y * face.u[0] - x * face.u[1]) / face.det,
  };
}

function contains(face, point) {
  const p = localPoint(face, point);
  return (
    p.x >= -0.001 &&
    p.y >= -0.001 &&
    p.x <= face.width + 0.001 &&
    p.y <= face.height + 0.001
  );
}

function scenePoint(face, x, y) {
  return {
    x: face.origin[0] + face.u[0] * x + face.v[0] * y,
    y: face.origin[1] + face.u[1] * x + face.v[1] * y,
  };
}

const GLASS = new Set([
  '#203e4d',
  '#76a5b4',
  '#b5d3d4',
  '#7aa7b2',
  '#96b7d0',
  '#6e9da4',
  '#a8dbbf',
]);
const PLASTIC = new Set([
  '#e3dfc6',
  '#d5d2b8',
  '#9c9f8c',
  '#c7c9b1',
  '#8f9e8e',
  '#6e8078',
  '#b6baa4',
  '#e1dcc2',
  '#a4ac98',
  '#8d9a8b',
  '#7e8d83',
  '#e3ddc1',
  '#42585b',
  '#5d695f',
  '#dad8c2',
  '#b9c4b0',
  '#8fa49a',
  '#e0dfc9',
  '#95aaa0',
  '#c2cbb6',
  '#497984',
  '#92c5cd',
  '#c5e1df',
  '#a0b4aa',
]);
const PAPER = new Set([
  '#f5eed7',
  '#f4edce',
  '#f9f1d7',
  '#f5eed6',
  '#fff4cf',
  '#b5ccd5',
  '#eac0a5',
]);

export function officeMaterial(site, fill) {
  if (GLASS.has(fill)) return 'glass';
  if (PAPER.has(fill)) return 'paper';
  if (site.kind === 'wall') return 'plaster';
  if (site.kind === 'floor') return 'carpet';
  if (PLASTIC.has(fill)) return 'plastic';
  return site.kind === 'machinery' ? 'metal' : 'wood';
}

function path(ctx, points) {
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.closePath();
}
function fill(ctx, points, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  path(ctx, points);
  ctx.fill();
}
function stroke(ctx, points, color, width = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.stroke();
}
function disk(ctx, x, y, r, color) {
  fill(
    ctx,
    [
      [x - r, y - r * 0.3],
      [x - r * 0.4, y - r],
      [x + r * 0.6, y - r * 0.8],
      [x + r, y + r * 0.2],
      [x + r * 0.2, y + r],
      [x - r * 0.7, y + r * 0.6],
    ],
    color,
  );
}

function drawMark(ctx, mark, material, pose) {
  const gun = mark.weapon === 'gun';
  const strength = Math.min(1.5, mark.amount);
  const remaining =
    mark.weapon === 'flame' ? pose.scorch : gun ? pose.chips : pose.dent;
  if (!remaining) return;
  // The aggregate model controls repair; accumulated contacts never enlarge a hole.
  const repair =
    pose.phase === 'repairing' ? clamp(remaining / mark.initial) : 1;
  ctx.globalAlpha *= repair;
  const radius = (gun ? 2.3 : 2.8) * (0.9 + strength * 0.15);
  if (mark.weapon === 'flame') {
    const r = 3 + Math.min(1, pose.scorch) * 4;
    ctx.globalAlpha *= Math.min(0.85, 0.25 + pose.scorch);
    disk(ctx, 0, 0, r, '#554b3e');
    disk(ctx, 0.5, -0.2, r * 0.65, '#272b29');
    return;
  }
  if (material === 'metal') {
    disk(ctx, 0, 0, radius + 1, '#516569');
    stroke(
      ctx,
      [
        [-radius, 0.5],
        [-1, radius],
        [radius, 0],
      ],
      '#c9d4c7',
      1.2,
    );
    disk(ctx, 0.3, -0.2, gun ? 1.3 : 0.7, '#172c32');
  } else if (material === 'glass') {
    const r = gun ? 4 : 2.8;
    for (let i = 0; i < 5; i++) {
      const a = mark.seed + i * 1.26;
      stroke(
        ctx,
        [
          [0, 0],
          [Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5],
          [Math.cos(a + 0.18) * r, Math.sin(a + 0.18) * r],
        ],
        '#dcebed',
        0.7,
      );
    }
    disk(ctx, 0, 0, gun ? 1.5 : 0.7, '#19343c');
  } else if (material === 'carpet' || material === 'paper') {
    disk(ctx, 0, 0, radius, material === 'carpet' ? '#536364' : '#a39677');
    disk(ctx, 0, 0, gun ? 1.35 : 0.6, '#243435');
    stroke(
      ctx,
      [
        [-radius, 0.3],
        [-0.8, -0.3],
        [0.8, 0.4],
        [radius, -0.4],
      ],
      '#c1b99b',
      0.6,
    );
  } else {
    const chip =
      material === 'plaster'
        ? '#f3e8cb'
        : material === 'plastic'
          ? '#e4ddbf'
          : '#d7ba7d';
    disk(ctx, 0, 0, radius + (gun ? 0.9 : 0), '#746e59');
    disk(ctx, -0.3, 0.4, radius, chip);
    disk(ctx, 0, 0, gun ? 1.45 : 0.6, '#283431');
    if (gun && material === 'wood')
      stroke(
        ctx,
        [
          [-4, -0.8],
          [-1.5, -0.3],
          [1.8, 0.2],
          [4, 0.9],
        ],
        '#6e593b',
        0.7,
      );
    if (gun && material === 'plaster')
      stroke(
        ctx,
        [
          [-0.3, -1.5],
          [-1, -3],
          [-0.5, -4],
        ],
        '#8a8976',
        0.6,
      );
  }
}

export function createOfficeImpacts() {
  const sites = new Map();
  let order = 0,
    serial = 0,
    scope;

  function setSites(descriptors, nextScope) {
    if (scope !== nextScope) {
      sites.clear();
      scope = nextScope;
    }
    const keep = new Set(descriptors.map(s => s.id));
    for (const id of sites.keys()) if (!keep.has(id)) sites.delete(id);
    for (const descriptor of descriptors) {
      const previous = sites.get(descriptor.id);
      if (!previous || previous.variant !== descriptor.variant)
        sites.set(descriptor.id, {
          variant: descriptor.variant,
          surfaces: [],
          marks: [],
          order: 0,
        });
    }
  }
  function setSurfaces(id, surfaces, background = false) {
    const site = sites.get(id);
    if (!site) return;
    const next = surfaces.filter(Boolean);
    if (
      site.marks.length &&
      (next.length !== site.surfaces.length ||
        next.some((face, index) => face !== site.surfaces[index]))
    ) {
      const key = face => JSON.stringify([face.material, face.points]);
      const indices = new Map(next.map((face, index) => [key(face), index]));
      site.marks = site.marks.flatMap(mark => {
        const previous = site.surfaces[mark.face];
        const index = previous && indices.get(key(previous));
        return index === undefined ? [] : [{...mark, face: index}];
      });
    }
    site.surfaces = next;
    site.order = background ? 0 : ++order;
  }
  function contact(id, point) {
    const site = sites.get(id);
    if (!site || (point !== undefined && !finitePoint(point))) return null;
    const faces = site.surfaces;
    if (point) {
      for (let i = faces.length - 1; i >= 0; i--) {
        if (!contains(faces[i], point)) continue;
        return {face: i, ...localPoint(faces[i], point)};
      }
      return null;
    }
    // Legacy contacts and fire spread use the largest exposed face's center.
    for (const face of [...faces].sort(
      (a, b) =>
        b.width * b.height * Math.abs(b.det) -
        a.width * a.height * Math.abs(a.det),
    )) {
      const center = scenePoint(face, face.width / 2, face.height / 2);
      const resolved = contact(id, center);
      if (resolved && faces[resolved.face] === face) return resolved;
    }
    return faces.length
      ? {
          face: faces.length - 1,
          x: faces.at(-1).width / 2,
          y: faces.at(-1).height / 2,
        }
      : null;
  }
  function hit(id, weapon, amount, at, pose) {
    const site = sites.get(id),
      face = site?.surfaces[at?.face];
    if (
      !face ||
      !['gun', 'cane', 'flame'].includes(weapon) ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return false;
    if (!pose.damage && !pose.scorch && !pose.chips && !pose.dent)
      site.marks = [];
    const x = clamp(at.x / face.width),
      y = clamp(at.y / face.height);
    const near = site.marks.find(
      mark =>
        mark.weapon === weapon &&
        mark.face === at.face &&
        Math.hypot((mark.x - x) * face.width, (mark.y - y) * face.height) <
          (weapon === 'flame' ? 5 : 1),
    );
    if (near) return true;
    site.marks.push({
      face: at.face,
      material: face.material,
      x,
      y,
      weapon,
      amount,
      seed: (++serial * 2.399963) % (Math.PI * 2),
      initial:
        weapon === 'gun'
          ? Math.min(1, pose.chips + 0.28 * Math.min(3, amount))
          : weapon === 'cane'
            ? Math.min(1, pose.dent + 0.09 * Math.min(3, amount))
            : Math.min(1, pose.scorch + 0.3 * Math.min(0.25, amount)),
    });
    if (site.marks.length > MAX_MARKS) site.marks.shift();
    return true;
  }
  function targets(project) {
    return [...sites.entries()]
      .sort((a, b) => b[1].order - a[1].order)
      .flatMap(([id, site]) =>
        [...site.surfaces].reverse().map(face => {
          const polygon = face.points.map(([x, y]) => project({x, y}));
          const x = polygon.reduce((n, p) => n + p.x, 0) / polygon.length;
          const y = polygon.reduce((n, p) => n + p.y, 0) / polygon.length;
          return {
            id,
            x,
            y,
            radius: Math.max(...polygon.map(p => Math.hypot(p.x - x, p.y - y))),
            polygon,
          };
        }),
      );
  }
  function draw(ctx, id, pose, time) {
    const site = sites.get(id);
    if (!site || !pose) return;
    if (
      !pose.damage &&
      !pose.scorch &&
      !pose.chips &&
      !pose.dent &&
      !pose.fire
    ) {
      site.marks = [];
      return;
    }
    let marks = site.marks;
    if (pose.scorch && !marks.some(mark => mark.weapon === 'flame')) {
      const at = contact(id);
      if (at) {
        const face = site.surfaces[at.face];
        marks = [
          ...marks,
          {
            ...at,
            x: at.x / face.width,
            y: at.y / face.height,
            material: face.material,
            weapon: 'flame',
            amount: 1,
            initial: pose.scorch,
          },
        ];
      }
    }
    for (const mark of marks) {
      const face = site.surfaces[mark.face];
      if (!face || face.material !== mark.material) continue;
      const center = scenePoint(
        face,
        mark.x * face.width,
        mark.y * face.height,
      );
      ctx.save();
      ctx.beginPath();
      path(ctx, face.points);
      ctx.clip();
      // Later painted faces cover the mark just as they cover the original face.
      for (const cover of site.surfaces.slice(mark.face + 1)) {
        if (
          cover.bounds.right < center.x - 16 ||
          cover.bounds.left > center.x + 16 ||
          cover.bounds.bottom < center.y - 16 ||
          cover.bounds.top > center.y + 16
        )
          continue;
        ctx.beginPath();
        ctx.rect(-2000, -2000, 4000, 4000);
        path(ctx, cover.points);
        ctx.clip('evenodd');
      }
      ctx.transform(
        face.u[0],
        face.u[1],
        face.v[0],
        face.v[1],
        center.x,
        center.y,
      );
      drawMark(ctx, mark, face.material, pose);
      ctx.restore();
    }
    if (pose.fire) {
      const mark = [...marks].reverse().find(mark => mark.weapon === 'flame');
      const face = mark && site.surfaces[mark.face];
      if (!face) return;
      const center = scenePoint(
        face,
        mark.x * face.width,
        mark.y * face.height,
      );
      for (let i = 0; i < 4; i++) {
        const cycle = (time * 3 + i / 4) % 1,
          x = center.x - 5 + i * 3;
        const h = (7 + (1 - cycle) * 8) * pose.fire;
        fill(
          ctx,
          [
            [x - 2, center.y + 1],
            [x - 3, center.y - h * 0.3],
            [x + 1, center.y - h],
            [x + 3, center.y + 1],
          ],
          '#f14c16',
        );
        fill(
          ctx,
          [
            [x - 1, center.y],
            [x + 1, center.y - h * 0.6],
            [x + 2, center.y],
          ],
          '#ffe28a',
        );
      }
    }
  }
  return {setSites, setSurfaces, contact, hit, targets, draw};
}
