const TAU = Math.PI * 2;
const clamp = n => Math.max(0, Math.min(1, n));
const CHAR = [0.075, 0.062, 0.055];
const TEAL = [0.18, 0.94, 0.84];
const WHITE = [0.88, 1, 0.96];
const tint = (color, amount) =>
  Array.isArray(color)
    ? color.map((v, i) => v + (CHAR[i] - v) * amount)
    : `color-mix(in srgb, #13100e ${Math.round(amount * 100)}%, ${color})`;
const material = (color, fallback) =>
  Array.isArray(color) ? fallback : fallback === TEAL ? '#2fefd6' : '#e0fff5';

// Damage changes the actual primitives. Breaking a slab removes sections of its
// top and sides; repair rebuilds those same primitives from their original data.
export function environmentPrimitives(g, site, pose) {
  if (!pose?.damage && !pose?.scorch) return g;
  const chips = pose.chips || 0,
    dent = pose.dent || 0,
    scorch = clamp(pose.scorch || 0);
  const p = (point, strength = 1) => [
    point[0] + dent * 0.08 * strength,
    point[1] -
      dent * Math.min(0.16, Math.max(0.025, point[1] * 0.075)) * strength,
    point[2] + dent * 0.04 * strength,
  ];
  const color = c => tint(c, scorch * 0.94);
  const result = Object.create(g);
  result.box = (point, size, c, emission = 0, yaw = 0) => {
    if (chips > 0.12 && size[0] > 0.45 && size[2] > 0.4) {
      const nx = 3,
        nz = 3;
      for (let x = 0; x < nx; x++) {
        for (let z = 0; z < nz; z++) {
          // A growing, jagged missing corner leaves the supporting frame visible.
          if (x + z >= (chips > 0.5 ? 2 : 3)) continue;
          const q = p([
            point[0] + ((x + 0.5) / nx - 0.5) * size[0],
            point[1],
            point[2] + ((z + 0.5) / nz - 0.5) * size[2],
          ]);
          g.box(
            q,
            [size[0] / nx, size[1], size[2] / nz],
            color(c),
            emission * (1 - scorch),
            yaw,
          );
        }
      }
    } else {
      const q = p(point);
      if (chips > 0.4 && point[0] > site.x + 0.1 && point[2] > site.z + 0.1)
        return;
      g.box(q, size, color(c), emission * (1 - scorch), yaw + dent * 0.025);
    }
  };
  for (const name of ['cylinder', 'octagon'])
    result[name] = (point, size, c, emission = 0, ...rest) => {
      const damaged = [...size];
      damaged[1] *= 1 - chips * 0.35;
      g[name](p(point), damaged, color(c), emission * (1 - scorch), ...rest);
    };
  result.rod = (a, b, radius, c, emission = 0) => {
    if (chips > 0.25 && (a[0] + b[0]) / 2 > site.x + 0.12) return;
    g.rod(p(a), p(b), radius, color(c), emission * (1 - scorch));
  };
  result.ring = (point, radius, thickness, c, emission = 0, segments = 28) => {
    for (let i = 0; i < segments; i++) {
      if (chips > 0.12 && i > segments * (0.8 - chips * 0.3)) continue;
      const at = j => [
        point[0] + Math.cos((j * TAU) / segments) * radius,
        point[1],
        point[2] + Math.sin((j * TAU) / segments) * radius,
      ];
      result.rod(at(i), at(i + 1), thickness, c, emission);
    }
  };
  return result;
}

export function repairBotPosition(site, pose) {
  const progress = clamp(pose?.botProgress || 0);
  const edge = site.x < 0 ? -11.7 : 11.7;
  return [edge + (site.x + 0.95 - edge) * progress, 0, site.z + 0.75];
}

export function drawEnvironmentSurface(g, fx, C, site, pose, time) {
  if (!pose || (!pose.damage && !pose.scorch && !pose.fire)) return;
  const {x, z} = site,
    y = site.h || 0.01,
    size = site.radius || 0.7;
  const black = Array.isArray(C.dark) ? CHAR : '#191512';
  if (pose.scorch > 0.01) {
    g.octagon([x, y + 0.015, z], [size * 1.65, 0.018, size * 1.2], black);
    for (let i = 0; i < 4; i++) {
      const angle = i * 2.4;
      g.octagon(
        [
          x + Math.cos(angle) * size * 0.47,
          y + 0.024,
          z + Math.sin(angle) * size * 0.47,
        ],
        [size * 0.65 * pose.scorch, 0.02, size * 0.45],
        black,
      );
    }
  }
  if (pose.dent > 0.01 || pose.chips > 0.01) {
    const extent = size * (0.28 + Math.max(pose.dent, pose.chips) * 0.6);
    const points = [
      [x - extent * 0.8, y + 0.035, z - extent * 0.45],
      [x - extent * 0.14, y + 0.035, z - extent * 0.1],
      [x - extent * 0.3, y + 0.035, z + extent * 0.18],
      [x + extent * 0.5, y + 0.035, z + extent * 0.36],
      [x + extent * 0.85, y + 0.035, z + extent * 0.75],
    ];
    for (let i = 1; i < points.length; i++) {
      // Pale chipped edges keep dark cracks readable on every floor palette.
      g.rod(points[i - 1], points[i], 0.032 + pose.chips * 0.02, C.metal);
      g.rod(
        points[i - 1].map((v, a) => (a === 1 ? v + 0.012 : v)),
        points[i].map((v, a) => (a === 1 ? v + 0.012 : v)),
        0.014 + pose.chips * 0.012,
        black,
      );
    }
    g.rod(
      points[2],
      [x + extent * 0.18, y + 0.04, z - extent * 0.65],
      0.018,
      black,
    );
    if (pose.chips > 0.1) {
      for (let i = 0; i < 5; i++) {
        const angle = i * 2.39;
        g.box(
          [
            x + Math.cos(angle) * size * 0.85,
            0.04 + (i % 2) * 0.04,
            z + Math.sin(angle) * size * 0.7,
          ],
          [0.12 + pose.chips * 0.14, 0.09, 0.13],
          C.metal,
          0,
          angle,
        );
      }
    }
  }
  if (pose.fire > 0) {
    const orange = Array.isArray(C.dark) ? [1, 0.2, 0.025] : '#ff4a0c';
    const yellow = Array.isArray(C.dark) ? [1, 0.82, 0.19] : '#ffd234';
    for (let i = 0; i < 7; i++) {
      const cycle = (time * 2.8 + i / 7) % 1,
        angle = i * 2.4,
        height = (0.35 + (1 - cycle) * 0.95) * pose.fire;
      const base = [
        x + Math.cos(angle) * size * 0.42,
        y + 0.04,
        z + Math.sin(angle) * size * 0.42,
      ];
      const tip = [
        base[0] + Math.sin(time * 12 + i) * 0.11,
        base[1] + height,
        base[2],
      ];
      g.rod(base, tip, 0.09 + (1 - cycle) * 0.06, orange, 1);
      g.rod(
        base,
        tip.map((v, a) => (a === 1 ? base[1] + height * 0.63 : v)),
        0.055,
        yellow,
        1,
      );
      fx.octagon(tip, [0.24, 0.32, 0.24], orange, 0.22);
      if (i < 3)
        g.octagon(
          [base[0] + cycle * 0.3, y + 1 + cycle * 1.2, base[2]],
          [0.25 + cycle * 0.3, 0.25, 0.25],
          black,
        );
    }
  }
}

export function drawEnvironmentRepairBot(
  g,
  fx,
  C,
  site,
  pose,
  time,
  floor = 0,
  position = null,
) {
  if (
    !pose?.botProgress ||
    !['arriving', 'repairing', 'leaving'].includes(pose.phase)
  )
    return;
  const p = position || repairBotPosition(site, pose),
    teal = material(C.dark, TEAL),
    white = material(C.dark, WHITE);
  const at = (x, y, z) => [p[0] + x, floor + y, p[2] + z];
  for (const side of [-1, 1]) {
    g.box(at(0, 0.16, side * 0.29), [0.86, 0.26, 0.19], C.dark);
    for (const wheel of [-0.26, 0, 0.26]) {
      g.octagon(at(wheel, 0.16, side * 0.32), [0.16, 0.23, 0.11], C.metal);
      g.box(at(wheel, 0.25, side * 0.32), [0.08, 0.04, 0.14], white);
    }
  }
  g.box(at(0, 0.36, 0), [0.7, 0.37, 0.52], teal);
  g.box(at(-0.1, 0.62, 0), [0.45, 0.23, 0.46], C.shell);
  g.box(at(-0.34, 0.63, 0), [0.045, 0.16, 0.39], C.screen);
  for (const side of [-1, 1])
    g.box(at(-0.37, 0.65, side * 0.11), [0.025, 0.07, 0.08], white, 1);
  g.box(at(-0.1, 0.63, 0.245), [0.36, 0.15, 0.025], C.screen);
  for (const side of [-1, 1])
    g.box(at(-0.1 + side * 0.09, 0.65, 0.263), [0.065, 0.06, 0.02], white, 1);
  g.cylinder(at(0.23, 0.62, 0.1), [0.19, 0.38, 0.19], C.metal);
  g.box(at(0.23, 0.83, 0.1), [0.21, 0.045, 0.21], teal);
  const working = pose.phase === 'repairing' && !pose.repairWaiting;
  const elbow = at(-0.42, 0.75, -0.22);
  const target = [site.x, (site.h || 0) + 0.08, site.z];
  const tip = working ? target : at(-0.6, 0.7, -0.23);
  g.rod(at(-0.2, 0.45, -0.28), elbow, 0.055, C.metal);
  g.rod(elbow, tip, 0.045, white);
  g.box(tip, [0.13, 0.1, 0.15], C.screen);
  if (!working) return;
  if (pose.repairProgress < 0.3) {
    // A broad extinguisher jet precedes the narrower welding arc.
    for (let i = 0; i < 5; i++) {
      const t = (time * 3 + i / 5) % 1;
      g.octagon(
        tip.map(
          (v, a) => v + (a === 1 ? t * 0.55 : Math.sin(i * 2.7) * t * 0.35),
        ),
        [0.12 + t * 0.19, 0.12, 0.12 + t * 0.19],
        white,
        0.4,
      );
    }
  } else {
    g.octagon(target, [0.18, 0.18, 0.18], white, 1);
    fx.octagon(target, [0.45, 0.35, 0.45], teal, 0.6);
    for (let i = 0; i < 6; i++) {
      const a = (i * TAU) / 6 + time * 7,
        length = 0.16 + ((time * 4 + i / 6) % 1) * 0.26;
      g.rod(
        target,
        [
          target[0] + Math.cos(a) * length,
          target[1] + 0.1 + length * 0.65,
          target[2] + Math.sin(a) * length,
        ],
        0.015,
        teal,
        1,
      );
    }
  }
}
