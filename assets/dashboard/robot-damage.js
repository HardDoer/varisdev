// Decorative only: this model never reads or changes agent/session/task state.
// Distances are scene units, angles radians; effects are relative to a robot's
// home on the floor (not its moving body). No timers, random globals or DOM.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const ZERO = () => [0, 0, 0];
const EXPLOSION_SECONDS = 0.9;
const REPLACEMENT_SECONDS = 3.6;

export function createRobotDamage({maxRobots = 16, maxEffects = 96} = {}) {
  const limit = (n, fallback, max) =>
    Number.isFinite(n) ? clamp(Math.floor(n), 1, max) : fallback;
  maxRobots = limit(maxRobots, 16, 32);
  maxEffects = limit(maxEffects, 96, 160);
  const robots = new Map();
  let debris = [],
    motion = true,
    disposed = false,
    serial = 0;

  function fresh(id) {
    return {
      id,
      damage: 0,
      phase: 'alive',
      age: 0,
      offset: ZERO(),
      velocity: ZERO(),
      rotation: ZERO(),
      spin: ZERO(),
      generation: 0,
      hits: 0,
    };
  }
  function settle(robot) {
    robot.offset = ZERO();
    robot.velocity = ZERO();
    robot.rotation = ZERO();
    robot.spin = ZERO();
  }
  function replace(robot) {
    robot.phase = 'alive';
    robot.age = 0;
    robot.damage = 0;
    robot.generation++;
    settle(robot);
  }
  function remove(id) {
    robots.delete(id);
    debris = debris.filter(piece => piece.owner !== id);
  }
  function pieces(robot, strength, direction, exploding) {
    // Seeded per hit: both renderers get the same bounded physical fragments.
    let seed = 2166136261;
    for (const c of String(robot.id))
      seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
    seed ^= robot.hits * 2654435761;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = exploding ? 24 : Math.ceil(3 + strength * 3);
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const speed = (exploding ? 2.2 : 0.6) + random() * strength * 2.4;
      const kind =
        exploding && i < 6
          ? ['head', 'limb', 'limb', 'armor', 'armor', 'armor'][i]
          : i % 3 === 0
            ? 'armor'
            : 'spark';
      const size =
        kind === 'head'
          ? [0.5, 0.3, 0.45]
          : kind === 'limb'
            ? [0.18, 0.52, 0.22]
            : kind === 'armor'
              ? [0.22 + random() * 0.22, 0.08, 0.3]
              : [0.045, 0.045, 0.12];
      debris.push({
        id: ++serial,
        owner: robot.id,
        kind,
        size,
        position: [robot.offset[0], 1.6 + robot.offset[1], robot.offset[2]],
        velocity: [
          Math.cos(angle) * speed,
          2 + random() * (exploding ? 5 : 2),
          Math.sin(angle) * speed - direction * strength,
        ],
        rotation: [random() * 3, random() * 3, random() * 3],
        spin: [random() * 10 - 5, random() * 10 - 5, random() * 10 - 5],
        age: 0,
        duration: kind === 'spark' ? 0.35 + random() * 0.5 : 2 + random() * 1.5,
      });
    }
    if (debris.length > maxEffects)
      debris.splice(0, debris.length - maxEffects);
  }
  function hit(id, direction = 1, strength = 1) {
    if (disposed || id === undefined || id === null || id === '') return false;
    let robot = robots.get(id);
    if (!robot) {
      if (robots.size >= maxRobots) remove(robots.keys().next().value);
      robot = fresh(id);
      robots.set(id, robot);
    }
    if (robot.phase !== 'alive') return false;
    strength = Number.isFinite(strength) ? clamp(strength, 0.15, 2.2) : 1;
    direction = Number.isFinite(direction) && direction < 0 ? -1 : 1;
    robot.hits++;
    robot.damage = Math.min(
      1,
      robot.damage + 0.08 + 0.045 * strength * strength,
    );
    const exploding = robot.damage >= 1;
    if (motion) {
      // An immediate small contact displacement keeps an impact visible even
      // before the first animation frame (which intentionally has zero dt).
      robot.offset[1] = Math.min(4, robot.offset[1] + 0.025 * strength);
      robot.offset[2] = clamp(
        robot.offset[2] - direction * 0.045 * strength,
        -5,
        5,
      );
      robot.rotation[0] += direction * 0.035 * strength;
      robot.velocity[0] = clamp(
        robot.velocity[0] + direction * strength * 0.75,
        -6,
        6,
      );
      robot.velocity[1] = Math.min(9, robot.velocity[1] + 2 + strength * 2.6);
      // Positive screen-space hits travel right, toward negative scene Z.
      robot.velocity[2] = clamp(
        robot.velocity[2] - direction * strength * 4,
        -10,
        10,
      );
      robot.spin[0] += direction * strength * 7;
      robot.spin[1] += direction * strength * 2.8;
      robot.spin[2] -= direction * strength * 2;
      pieces(robot, strength, direction, exploding);
    }
    if (exploding) {
      robot.phase = 'exploding';
      robot.age = 0;
      if (!motion) replace(robot);
    }
    return true;
  }
  function step(dt) {
    for (const robot of robots.values()) {
      if (robot.phase === 'exploding') {
        robot.age += dt;
        if (robot.age >= EXPLOSION_SECONDS) {
          robot.phase = 'replacing';
          robot.age = 0;
          robot.damage = 0;
          settle(robot);
        }
      } else if (robot.phase === 'replacing') {
        robot.age += dt;
        if (robot.age >= REPLACEMENT_SECONDS) replace(robot);
      } else {
        const airborne = robot.offset[1] > 0 || robot.velocity[1] > 0;
        if (airborne) robot.velocity[1] -= 14 * dt;
        for (let axis = 0; axis < 3; axis++) {
          if (axis !== 1) {
            robot.velocity[axis] += -robot.offset[axis] * 5 * dt;
            robot.velocity[axis] *= Math.exp(-2.6 * dt);
          }
          robot.offset[axis] += robot.velocity[axis] * dt;
          robot.spin[axis] += -robot.rotation[axis] * 13 * dt;
          robot.spin[axis] *= Math.exp(-3 * dt);
          robot.rotation[axis] += robot.spin[axis] * dt;
        }
        if (robot.offset[1] < 0) {
          robot.offset[1] = 0;
          robot.velocity[1] =
            Math.abs(robot.velocity[1]) > 1 ? -robot.velocity[1] * 0.3 : 0;
          robot.velocity[0] *= 0.7;
          robot.velocity[2] *= 0.7;
        }
        for (let axis = 0; axis < 3; axis++) {
          if (
            Math.abs(robot.offset[axis]) + Math.abs(robot.velocity[axis]) <
            0.002
          )
            robot.offset[axis] = robot.velocity[axis] = 0;
          if (
            Math.abs(robot.rotation[axis]) + Math.abs(robot.spin[axis]) <
            0.002
          )
            robot.rotation[axis] = robot.spin[axis] = 0;
        }
      }
    }
    for (const piece of debris) {
      piece.age += dt;
      piece.velocity[1] -= 12 * dt;
      for (let axis = 0; axis < 3; axis++) {
        piece.position[axis] += piece.velocity[axis] * dt;
        piece.rotation[axis] += piece.spin[axis] * dt;
      }
      const floor = piece.size[1] / 2 + 0.03;
      if (piece.position[1] < floor) {
        piece.position[1] = floor;
        piece.velocity[1] =
          Math.abs(piece.velocity[1]) > 0.8 ? -piece.velocity[1] * 0.32 : 0;
        piece.velocity[0] *= 0.72;
        piece.velocity[2] *= 0.72;
        piece.spin = piece.spin.map(n => n * 0.65);
      }
    }
    debris = debris.filter(piece => piece.age < piece.duration);
  }
  function tick(dt) {
    if (disposed || !motion || !Number.isFinite(dt) || dt <= 0) return;
    // Drop suspended-tab catch-up, and substep for stable gravity and springs.
    let remaining = Math.min(dt, 0.25);
    while (remaining > 0.000001) {
      const delta = Math.min(remaining, 1 / 120);
      step(delta);
      remaining -= delta;
    }
  }
  function pose(id) {
    const robot = robots.get(id) || fresh(id);
    const replacing = robot.phase === 'replacing';
    const rise = replacing ? clamp((robot.age - 0.65) / 1.9, 0, 1) : 1;
    const smooth = rise * rise * (3 - 2 * rise);
    return {
      damage: robot.damage,
      phase: robot.phase,
      phaseAge: robot.age,
      blast:
        robot.phase === 'exploding'
          ? clamp(1 - robot.age / EXPLOSION_SECONDS, 0, 1)
          : 0,
      offset: [...robot.offset],
      rotation: [...robot.rotation],
      door: replacing
        ? Math.min(
            clamp(robot.age / 0.55, 0, 1),
            clamp((REPLACEMENT_SECONDS - robot.age) / 0.65, 0, 1),
          )
        : 0,
      lift: replacing && smooth < 1 ? -3.4 * (1 - smooth) : 0,
      visible: robot.phase === 'alive' || (replacing && rise > 0),
      generation: robot.generation,
    };
  }
  return {
    hit,
    tick,
    pose,
    effects: () =>
      debris.map(piece => ({
        id: piece.id,
        owner: piece.owner,
        kind: piece.kind,
        size: [...piece.size],
        position: [...piece.position],
        rotation: [...piece.rotation],
        life: 1 - piece.age / piece.duration,
      })),
    setMotion(enabled) {
      motion = Boolean(enabled);
      if (!motion) {
        debris = [];
        for (const robot of robots.values()) {
          if (robot.phase !== 'alive') replace(robot);
          else settle(robot);
        }
      }
    },
    retain(ids) {
      const keep = new Set(ids);
      for (const id of robots.keys()) if (!keep.has(id)) remove(id);
    },
    reset() {
      robots.clear();
      debris = [];
      serial = 0;
    },
    dispose() {
      disposed = true;
      robots.clear();
      debris = [];
    },
  };
}
