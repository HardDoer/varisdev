// Decorative only: this model never reads or changes agent/session/task state.
// Positions are relative to the robot's home on the floor.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const ZERO = () => [0, 0, 0];
const smooth = n => n * n * (3 - 2 * n);
const FALL_SECONDS = 0.9;
const WRECK_SECONDS = 2.4;
const CLEANUP_SECONDS = 6;
const REPLACEMENT_SECONDS = 3.6;
const SURPRISE_SECONDS = 1.15;

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
      hitAge: SURPRISE_SECONDS,
      strength: 0,
      direction: 1,
      generation: 0,
      hits: 0,
    };
  }
  function replace(robot) {
    robot.phase = 'alive';
    robot.age = 0;
    robot.damage = 0;
    robot.hitAge = SURPRISE_SECONDS;
    robot.generation++;
  }
  function remove(id) {
    robots.delete(id);
    debris = debris.filter(piece => piece.owner !== id);
  }
  function pieces(robot, strength, direction, destroyed) {
    let seed = 2166136261;
    for (const c of String(robot.id))
      seed = Math.imul(seed ^ c.charCodeAt(0), 16777619);
    seed ^= robot.hits * 2654435761;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const count = destroyed ? 18 : Math.ceil(2 + strength * 2);
    for (let i = 0; i < count; i++) {
      const angle = random() * Math.PI * 2;
      const speed = 0.5 + random() * strength * (destroyed ? 1.2 : 0.6);
      // The body stays intact; only small chips and sparks break free.
      const kind = i % 3 === 0 ? 'armor' : 'spark';
      const size =
        kind === 'armor'
          ? [0.12 + random() * 0.12, 0.05, 0.18]
          : [0.045, 0.045, 0.12];
      debris.push({
        id: ++serial,
        owner: robot.id,
        kind,
        size,
        position: [0, 1.6, 0],
        velocity: [
          Math.cos(angle) * speed,
          1 + random() * (destroyed ? 3 : 2),
          Math.sin(angle) * speed - direction * strength * 0.3,
        ],
        rotation: [random() * 3, random() * 3, random() * 3],
        spin: [random() * 10 - 5, random() * 10 - 5, random() * 10 - 5],
        age: 0,
        duration: kind === 'spark' ? 0.25 + random() * 0.4 : 1.5 + random(),
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
    robot.hitAge = 0;
    robot.strength = strength;
    robot.direction = direction;
    robot.damage = Math.min(
      1,
      robot.damage + 0.08 + 0.045 * strength * strength,
    );
    const destroyed = robot.damage >= 1;
    if (motion) pieces(robot, strength, direction, destroyed);
    if (destroyed) {
      robot.phase = 'exploding';
      robot.age = 0;
      if (!motion) replace(robot);
    }
    return true;
  }
  function step(dt) {
    for (const robot of robots.values()) {
      if (robot.phase === 'alive') {
        robot.hitAge = Math.min(SURPRISE_SECONDS, robot.hitAge + dt);
        continue;
      }
      robot.age += dt;
      const duration = {
        exploding: FALL_SECONDS,
        wrecked: WRECK_SECONDS,
        cleanup: CLEANUP_SECONDS,
        replacing: REPLACEMENT_SECONDS,
      }[robot.phase];
      if (robot.age + 1e-9 < duration) continue;
      robot.age = Math.max(0, robot.age - duration);
      if (robot.phase === 'exploding') robot.phase = 'wrecked';
      else if (robot.phase === 'wrecked') robot.phase = 'cleanup';
      else if (robot.phase === 'cleanup') {
        robot.phase = 'replacing';
        robot.damage = 0;
      } else replace(robot);
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
    // Drop suspended-tab catch-up and substep the fragment physics.
    let remaining = Math.min(dt, 0.25);
    while (remaining > 0.000001) {
      const delta = Math.min(remaining, 1 / 120);
      step(delta);
      remaining -= delta;
    }
  }
  function cleanupPose(robot) {
    if (robot.phase !== 'cleanup') return null;
    const arrival = smooth(clamp(robot.age / 2, 0, 1));
    const grip = clamp((robot.age - 2) / 1.1, 0, 1);
    // Enter from beyond the factory and leave room for the trailing wreck
    // to clear the scene before its replacement starts.
    const travel = smooth(clamp((robot.age - 3.1) / 2.9, 0, 1)) * 25.2;
    return {
      phase: robot.age < 2 ? 'arrive' : robot.age < 3.1 ? 'load' : 'leave',
      position: [20 - arrival * 17.2 + travel, 0, 0],
      grip,
      travel,
      wheel: (arrival * 17.2 + travel) * 4,
    };
  }
  function pose(id) {
    const robot = robots.get(id) || fresh(id);
    const replacing = robot.phase === 'replacing';
    const alive = robot.phase === 'alive';
    const corpse = !alive && !replacing;
    const rise = replacing ? clamp((robot.age - 0.65) / 1.9, 0, 1) : 1;
    const contact =
      alive && motion ? Math.max(0, 1 - robot.hitAge / 0.4) ** 2 : 0;
    const recoil = robot.direction * robot.strength * contact;
    const cleanup = cleanupPose(robot);
    return {
      damage: robot.damage,
      phase: robot.phase,
      phaseAge: robot.age,
      surprise:
        alive && motion
          ? clamp((SURPRISE_SECONDS - robot.hitAge) / 0.7, 0, 1)
          : 0,
      flinch: (robot.strength / 2.2) * contact,
      // A short, monotonic flinch. No spring, spin or upward launch.
      offset: [recoil * 0.025, 0, -recoil * 0.055],
      rotation: [recoil * 0.025, 0, -recoil * 0.01],
      collapse: corpse
        ? robot.phase === 'exploding'
          ? smooth(clamp(robot.age / FALL_SECONDS, 0, 1))
          : 1
        : 0,
      corpseOffset: cleanup
        ? [cleanup.travel, Math.max(0, (cleanup.grip - 0.6) / 0.4) * 0.08, 0]
        : ZERO(),
      cleanup,
      blast:
        robot.phase === 'exploding' ? clamp(1 - robot.age / 0.45, 0, 1) : 0,
      door: replacing
        ? Math.min(
            clamp(robot.age / 0.55, 0, 1),
            clamp((REPLACEMENT_SECONDS - robot.age) / 0.65, 0, 1),
          )
        : 0,
      lift: replacing && rise < 1 ? -3.4 * (1 - smooth(rise)) : 0,
      visible: !replacing || rise > 0,
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
          robot.hitAge = SURPRISE_SECONDS;
          if (robot.phase !== 'alive') replace(robot);
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
