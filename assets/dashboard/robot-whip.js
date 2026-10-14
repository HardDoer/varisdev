// Decorative only: callers supply visible robots and advance the scene clock.
export const WHIP_SECONDS = 1.8;
export const WHIP_CRACK = 0.68;
const clamp = n => Math.max(0, Math.min(1, n));
const smooth = n => {
  const t = clamp(n);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a.map((n, i) => n + (b[i] - n) * t);

export function createRobotWhip(random = Math.random) {
  let sessionId,
    initialized = false,
    enabled = true,
    disposed = false;
  let candidates = [],
    blocked = true,
    active = null;
  const delay = () => 20 + clamp(random()) * 25;
  let remaining = delay();
  function cancel() {
    active = null;
    remaining = delay();
  }
  return {
    update(id, targets, interrupt = false) {
      if (disposed) return;
      if (!initialized || sessionId !== id) {
        initialized = true;
        sessionId = id;
        cancel();
      }
      const lostWorkers = candidates.length > 0 && targets.length === 0;
      candidates = targets;
      blocked = interrupt;
      if (active && (blocked || !targets.includes(active.target))) cancel();
      else if (lostWorkers) remaining = delay();
    },
    tick(dt) {
      if (
        disposed ||
        !enabled ||
        !initialized ||
        blocked ||
        !candidates.length ||
        !Number.isFinite(dt) ||
        dt <= 0
      )
        return;
      if (active) {
        active.age += dt;
        if (active.age >= WHIP_SECONDS) cancel();
      } else {
        remaining -= dt;
        if (remaining <= 0) {
          const index = Math.min(
            candidates.length - 1,
            Math.floor(clamp(random()) * candidates.length),
          );
          active = {target: candidates[index], age: 0};
        }
      }
    },
    pose: () => (active ? {...active} : null),
    cancel,
    setMotion(value) {
      if (enabled !== Boolean(value)) {
        enabled = Boolean(value);
        cancel();
      }
    },
    dispose() {
      disposed = true;
      active = null;
      candidates = [];
    },
  };
}

export function whipPose(age) {
  const windup = smooth(age / 0.42);
  const swing = smooth((age - 0.42) / 0.26);
  const blend = smooth(age / 0.16) * (1 - smooth((age - 1.15) / 0.65));
  const elbow = mix([0.55, 1.2, 1.25], [-0.45, 2.15, 1.42], windup);
  const hand = mix([1.3, 0.98, 1.52], [-0.9, 3.15, 1.45], windup);
  return {
    blend,
    elbow: mix(elbow, [0.8, 1.85, 1.05], swing),
    hand: mix(hand, [1.95, 2.05, 0.65], swing),
    turn: Math.sin(clamp(age / WHIP_SECONDS) * Math.PI) * 0.24,
    reach: smooth((age - 0.4) / 0.28) * (1 - smooth((age - 0.85) / 0.65)),
    crack: age >= WHIP_CRACK ? 1 - clamp((age - WHIP_CRACK) / 0.2) : 0,
    recoil:
      age >= WHIP_CRACK
        ? Math.sin(clamp((age - WHIP_CRACK) / 0.65) * Math.PI)
        : 0,
  };
}

// Shared 3D primitives also project into the SVG fallback overlay.
export function drawRobotWhip(g, fx, C, start, target, age) {
  const pose = whipPose(age);
  const end = mix(start, target, pose.reach);
  if (pose.reach < 0.01) {
    end[1] -= 0.8;
    end[2] += 0.6;
  }
  let previous = start;
  for (let i = 1; i <= 28; i++) {
    const u = i / 28;
    const p = mix(start, end, u);
    const arc = Math.sin(u * Math.PI);
    p[1] += arc * (0.45 + (1 - pose.reach) * 1.5);
    p[2] += arc * Math.sin(u * Math.PI * 2 - age * 10) * (1 - pose.reach) * 0.7;
    g.rod(previous, p, 0.052 * pose.blend, C.dark);
    g.rod(previous, p, 0.027 * pose.blend, C.amber, 0.8);
    previous = p;
  }
  if (pose.crack > 0) {
    for (let i = 0; i < 7; i++) {
      const angle = (i * Math.PI * 2) / 7;
      const tip = [
        target[0] + Math.cos(angle) * 0.65 * pose.crack,
        target[1] + Math.sin(angle) * 0.65 * pose.crack,
        target[2] + Math.sin(angle * 2) * 0.32 * pose.crack,
      ];
      fx.rod(target, tip, 0.04 * pose.crack, i % 2 ? C.white : C.amber, 1);
    }
  }
}
