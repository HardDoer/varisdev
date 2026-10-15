import {stableFactoryHash} from './factory-identity.js';

const HOME = Object.freeze([-6.25, 0]);

// Both routes use the loading dock and the open left edge of the parent dais.
// They avoid the rear wall, work bays, desks, queue pad, and cargo stack.
export const VISITOR_ROUTE = Object.freeze([
  Object.freeze([-10.62, 2.72]),
  Object.freeze([-10.02, 1.72]),
  Object.freeze([-9.45, 1.38]),
]);
export const HOME_ROUTE = Object.freeze([
  VISITOR_ROUTE[0],
  Object.freeze([-9.9, 1.55]),
  Object.freeze([-8.75, 0.68]),
  HOME,
]);

const ACTIVE = new Set(['running', 'compacting']);
const TAU = Math.PI * 2;
const STARTLE_SECONDS = 0.7;
const WAIT_MIN_SECONDS = 24;
const WAIT_SPREAD_SECONDS = 42;
const VISIT_MIN_SECONDS = 7;
const VISIT_SPREAD_SECONDS = 8;

const sessionOf = value => value?.session || value;
const open = session => session?.id && session.status !== 'closed';

function normalizedSessions(value) {
  const collection = Array.isArray(value)
    ? value
    : Array.isArray(value?.sessions)
      ? value.sessions
      : Array.isArray(value?.hub?.sessions)
        ? value.hub.sessions
        : null;
  if (collection)
    return {
      sessions: collection.map(sessionOf).filter(open),
      authoritative: true,
    };
  const session = sessionOf(value);
  return {sessions: open(session) ? [session] : [], authoritative: false};
}

function nextRandom(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

function resetWait(state) {
  state.phase = 'wait';
  state.targetId = null;
  state.returnFactory = null;
  state.startledFrom = null;
  state.directHome = false;
  state.routeIndex = 0;
  state.elapsed = 0;
  state.x = HOME[0];
  state.z = HOME[1];
  state.yaw = 0;
  state.speed = 0;
  state.stride = 0;
  state.surprise = 0;
  state.wait = WAIT_MIN_SECONDS + nextRandom(state) * WAIT_SPREAD_SECONDS;
}

function makeState(session) {
  const state = {
    id: session.id,
    status: session.status || 'idle',
    name: session.name || '',
    seed: stableFactoryHash(session.id) || 1,
    phase: 'wait',
    targetId: null,
    returnFactory: null,
    startledFrom: null,
    directHome: false,
    routeIndex: 0,
    elapsed: 0,
    x: HOME[0],
    z: HOME[1],
    yaw: 0,
    speed: 0,
    stride: 0,
    surprise: 0,
    wait: 0,
    visitDuration: 0,
  };
  resetWait(state);
  return state;
}

function face(state, target, dt) {
  const delta = Math.atan2(
    Math.sin(target - state.yaw),
    Math.cos(target - state.yaw),
  );
  state.yaw += delta * (1 - Math.exp(-10 * dt));
  state.yaw = Math.atan2(Math.sin(state.yaw), Math.cos(state.yaw));
}

function moveTo(state, point, maximumSpeed, dt) {
  const dx = point[0] - state.x;
  const dz = point[1] - state.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.00001) {
    state.x = point[0];
    state.z = point[1];
    state.speed = 0;
    return true;
  }
  face(state, Math.atan2(dz, dx), dt);
  state.speed = Math.min(maximumSpeed, state.speed + dt * 10);
  const step = Math.min(distance, state.speed * dt);
  state.x += (dx / distance) * step;
  state.z += (dz / distance) * step;
  state.stride = (state.stride + step * 5) % TAU;
  return step >= distance;
}

function shownFactory(state) {
  if (state.phase === 'wait') return null;
  if (
    state.phase === 'leaving-home' ||
    state.phase === 'leaving' ||
    state.phase === 'homecoming'
  )
    return state.id;
  if (state.phase === 'startled') return state.returnFactory;
  return state.targetId;
}

/** Coordinate idle parents travelling between the currently open factories. */
export function createFactoryVisitors() {
  const states = new Map();
  let openIds = [];
  let authoritativeSeen = false;
  let disposed = false;
  let motion = true;

  function recall(state) {
    if (!['leaving-home', 'leaving', 'arrive', 'visit'].includes(state.phase))
      return false;
    state.returnFactory = shownFactory(state);
    state.startledFrom = state.phase;
    state.phase = 'startled';
    state.elapsed = 0;
    state.speed = 0;
    state.surprise = 1;
    return true;
  }

  function update(value) {
    if (disposed) return;
    const normalized = normalizedSessions(value);
    const incoming = new Set(normalized.sessions.map(session => session.id));
    if (normalized.authoritative) {
      authoritativeSeen = true;
      openIds = [...incoming].sort();
      for (const id of states.keys()) if (!incoming.has(id)) states.delete(id);
      for (const state of states.values()) {
        if (!state.targetId || incoming.has(state.targetId)) continue;
        // A destination can close while the parent is en route or visiting.
        // Reverse locally when possible; otherwise enter the source factory at
        // its loading dock and complete the normal trip to the workstation.
        if (
          state.phase === 'leaving-home' ||
          (state.phase === 'startled' &&
            state.returnFactory === state.id &&
            state.startledFrom === 'leaving-home')
        ) {
          state.phase = 'homecoming';
          state.directHome = true;
        } else if (
          state.phase === 'leaving' ||
          (state.phase === 'startled' && state.returnFactory === state.id)
        ) {
          state.phase = 'homecoming';
          state.routeIndex = Math.min(
            HOME_ROUTE.length - 1,
            state.routeIndex + 1,
          );
        } else if (state.phase !== 'wait' && state.phase !== 'homecoming') {
          state.phase = 'homecoming';
          state.routeIndex = 1;
          state.x = HOME_ROUTE[0][0];
          state.z = HOME_ROUTE[0][1];
        }
        state.targetId = null;
        state.returnFactory = state.id;
        state.elapsed = 0;
        state.speed = 0;
        state.surprise = 0;
      }
    } else if (!authoritativeSeen) {
      // Standalone scenes only receive their selected snapshot. Treat a switch
      // as replacement, not evidence that every previously viewed id is open.
      openIds = [...incoming].sort();
      for (const id of states.keys()) if (!incoming.has(id)) states.delete(id);
    }
    for (const session of [...normalized.sessions].sort((first, second) =>
      String(first.id).localeCompare(String(second.id)),
    )) {
      let state = states.get(session.id);
      if (!state) {
        state = makeState(session);
        states.set(session.id, state);
      }
      const wasActive = ACTIVE.has(state.status);
      state.status = session.status || 'idle';
      state.name = session.name || state.name;
      if (ACTIVE.has(state.status) && !wasActive) recall(state);
      if (!motion || state.status === 'closed') resetWait(state);
    }
  }

  function chooseTarget(state) {
    const occupied = new Set(
      [...states.values()]
        .filter(other => other.id !== state.id && other.phase !== 'wait')
        .map(other => other.targetId),
    );
    const choices = openIds.filter(
      id => id !== state.id && !occupied.has(id) && states.has(id),
    );
    if (!choices.length) return null;
    return choices[Math.floor(nextRandom(state) * choices.length)];
  }

  function beginVisit(state, target) {
    state.targetId = target;
    state.phase = 'leaving-home';
    state.routeIndex = HOME_ROUTE.length - 2;
    state.elapsed = 0;
    state.speed = 0;
    state.visitDuration =
      VISIT_MIN_SECONDS + nextRandom(state) * VISIT_SPREAD_SECONDS;
  }

  function advance(state, dt) {
    state.elapsed += dt;
    if (state.phase === 'wait') {
      if (
        state.status === 'idle' &&
        openIds.length > 1 &&
        state.elapsed >= state.wait
      ) {
        const target = chooseTarget(state);
        if (target) beginVisit(state, target);
        else {
          state.elapsed = 0;
          state.wait = 4 + nextRandom(state) * 4;
        }
      }
      return;
    }
    if (state.phase === 'startled') {
      state.surprise = 1 - Math.min(1, state.elapsed / STARTLE_SECONDS);
      if (state.elapsed >= STARTLE_SECONDS) {
        if (state.returnFactory === state.id) {
          // Reverse the exact departure segment, or run directly back along
          // the center aisle when the visit began from a roaming pose.
          state.phase = 'homecoming';
          state.directHome = state.startledFrom === 'leaving-home';
          state.routeIndex = Math.min(
            HOME_ROUTE.length - 1,
            state.routeIndex + 1,
          );
        } else {
          // Leave the visited factory first, then enter the source factory at
          // its loading dock and continue all the way to the workstation.
          state.phase = 'depart';
          state.routeIndex =
            state.startledFrom === 'arrive'
              ? state.routeIndex
              : Math.max(0, VISITOR_ROUTE.length - 2);
        }
        state.elapsed = 0;
        state.speed = 0;
        state.surprise = 0;
        state.startledFrom = null;
      }
      return;
    }
    if (state.phase === 'leaving-home') {
      if (moveTo(state, HOME, 1.45, dt)) {
        state.phase = 'leaving';
        state.routeIndex = HOME_ROUTE.length - 2;
        state.elapsed = 0;
        state.speed = 0;
      }
      return;
    }
    if (state.phase === 'leaving') {
      if (moveTo(state, HOME_ROUTE[state.routeIndex], 1.45, dt)) {
        if (state.routeIndex === 0) {
          state.phase = 'arrive';
          state.routeIndex = 0;
          state.x = VISITOR_ROUTE[0][0];
          state.z = VISITOR_ROUTE[0][1];
        } else state.routeIndex--;
      }
      return;
    }
    if (state.phase === 'arrive') {
      const next = Math.min(state.routeIndex + 1, VISITOR_ROUTE.length - 1);
      if (moveTo(state, VISITOR_ROUTE[next], 1.45, dt)) {
        state.routeIndex = next;
        if (next === VISITOR_ROUTE.length - 1) {
          state.phase = 'visit';
          state.elapsed = 0;
          state.speed = 0;
          face(state, Math.PI, dt);
        }
      }
      return;
    }
    if (state.phase === 'visit') {
      face(state, Math.PI, dt);
      if (ACTIVE.has(state.status)) recall(state);
      else if (state.elapsed >= state.visitDuration) {
        state.phase = 'depart';
        state.routeIndex = VISITOR_ROUTE.length - 2;
        state.elapsed = 0;
        state.speed = 0;
      }
      return;
    }
    if (state.phase === 'depart') {
      if (moveTo(state, VISITOR_ROUTE[state.routeIndex], 4.8, dt)) {
        if (state.routeIndex === 0) {
          state.phase = 'homecoming';
          state.returnFactory = state.id;
          state.routeIndex = 1;
          state.x = HOME_ROUTE[0][0];
          state.z = HOME_ROUTE[0][1];
          state.speed = 0;
        } else state.routeIndex--;
      }
      return;
    }
    if (state.phase === 'homecoming') {
      if (state.directHome) {
        if (moveTo(state, HOME, 4.8, dt)) resetWait(state);
      } else if (moveTo(state, HOME_ROUTE[state.routeIndex], 4.8, dt)) {
        if (state.routeIndex === HOME_ROUTE.length - 1) resetWait(state);
        else state.routeIndex++;
      }
    }
  }

  return {
    update,
    observeLocalPose(id, pose) {
      const state = states.get(id);
      if (
        disposed ||
        !state ||
        state.phase !== 'wait' ||
        !Number.isFinite(pose?.x) ||
        !Number.isFinite(pose?.z)
      )
        return;
      state.x = pose.x;
      state.z = pose.z;
      if (Number.isFinite(pose.yaw)) state.yaw = pose.yaw;
    },
    prompt(id) {
      const state = states.get(id);
      return !disposed && state ? recall(state) : false;
    },
    tick(dt) {
      if (disposed || !motion || !Number.isFinite(dt) || dt <= 0) return;
      let remaining = Math.min(dt, 1);
      while (remaining > 0.0000001) {
        const step = Math.min(remaining, 1 / 60);
        for (const state of states.values()) advance(state, step);
        remaining -= step;
      }
    },
    visitorsAt(factoryId) {
      if (disposed || !factoryId) return [];
      return [...states.values()]
        .filter(state => shownFactory(state) === factoryId)
        .map(state => ({
          id: state.id,
          name: state.name,
          status: state.status,
          phase: state.phase,
          x: state.x,
          z: state.z,
          yaw: state.yaw,
          stride: state.stride,
          surprise: state.surprise,
          jump:
            state.phase === 'startled'
              ? Math.sin(
                  Math.min(1, state.elapsed / STARTLE_SECONDS) * Math.PI,
                ) * 1.15
              : 0,
        }));
    },
    isAway(id) {
      const state = states.get(id);
      return Boolean(state && state.phase !== 'wait');
    },
    awayMessage(id) {
      const state = states.get(id);
      if (!state || state.phase === 'wait') return '';
      const destination = states.get(state.targetId)?.name || state.targetId;
      if (state.phase === 'homecoming') return 'Returning to own workstation';
      if (state.phase === 'startled')
        return destination
          ? `Startled — returning from ${destination}`
          : 'Startled — returning to own workstation';
      if (state.phase === 'depart')
        return destination
          ? `Returning from ${destination}`
          : 'Returning to own workstation';
      return destination
        ? `Visiting ${destination}`
        : 'Visiting another factory';
    },
    setMotion(enabled) {
      motion = Boolean(enabled);
      if (!motion) for (const state of states.values()) resetWait(state);
    },
    dispose() {
      disposed = true;
      states.clear();
      openIds = [];
      authoritativeSeen = false;
    },
    // Exposed for deterministic regression tests, not wall-clock scheduling.
    snapshot(id) {
      const state = states.get(id);
      return state ? {...state} : null;
    },
  };
}
