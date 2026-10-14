// All timing is driven by tick(); creating a controller schedules no work.
export const IDLE_ACTIVITIES = Object.freeze([
  'coffee',
  'jump-rope',
  'juggle',
  'dance',
  'stretch',
  'weights',
  'hula-hoop',
  'yo-yo',
  'read',
  'sweep',
  'balance',
  'paper-plane',
]);

const HOME = -6.25;
const STARTLE_SECONDS = 0.7;
const REST_MIN_SECONDS = 40;
const REST_MAX_SECONDS = 120;
const TAU = Math.PI * 2;
const active = status => status === 'running' || status === 'compacting';
const smoothstep = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function createParentMotion() {
  let sessionId;
  let initialized = false;
  let disposed = false;
  let motion = true;
  let status = 'idle';
  let mode = 'rest';
  let activity = null;
  let elapsed = 0;
  let x = HOME;
  let yaw = 0;
  let stride = 0;
  let speed = 0;
  let destination = HOME;
  let duration = 0;
  let pendingPrompt = false;
  let stopRemaining = 0;
  let seed = 1;
  let bag = [];
  let lastActivity = null;

  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  function enter(next, seconds = 0) {
    mode = next;
    elapsed = 0;
    activity = null;
    duration = seconds;
  }

  function rest() {
    speed = 0;
    stride = 0;
    enter(
      'rest',
      REST_MIN_SECONDS + random() * (REST_MAX_SECONDS - REST_MIN_SECONDS),
    );
  }

  function settle() {
    x = HOME;
    yaw = 0;
    speed = 0;
    stride = 0;
    if (active(status)) enter('work');
    else rest();
  }

  function reset(id) {
    sessionId = id;
    initialized = true;
    pendingPrompt = false;
    stopRemaining = 0;
    bag = [];
    lastActivity = null;
    seed = 2166136261;
    for (const char of String(id ?? '')) {
      seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    }
    settle();
  }

  function wake() {
    if (!motion || stopRemaining > 0) return false;
    if (!['idle', 'walk', 'rest'].includes(mode)) return false;
    speed = 0;
    enter('startled');
    return true;
  }

  function nextActivity() {
    if (bag.length === 0) {
      bag = [...IDLE_ACTIVITIES];
      for (let index = bag.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [bag[index], bag[other]] = [bag[other], bag[index]];
      }
      // Avoid a duplicate across the boundary between two shuffled rounds.
      if (bag[bag.length - 1] === lastActivity) {
        [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
    }
    lastActivity = bag.pop();
    return lastActivity;
  }

  function roam() {
    // Keep the entire route in the center aisle, clear of consoles and bays.
    const candidate = -3 + random() * 9.5;
    destination =
      Math.abs(candidate - x) >= 1.5
        ? candidate
        : x < 1.75
          ? Math.min(6.5, x + 2 + random() * 2)
          : Math.max(-3, x - 2 - random() * 2);
    speed = 0;
    enter('walk');
  }

  function face(target, dt) {
    const delta = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
    yaw += delta * (1 - Math.exp(-10 * dt));
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  }

  function move(target, maximumSpeed, dt) {
    const distance = target - x;
    if (Math.abs(distance) < 0.00001) {
      x = target;
      speed = 0;
      return true;
    }
    face(distance > 0 ? 0 : Math.PI, dt);
    speed = Math.min(maximumSpeed, speed + dt * 12);
    const step = Math.min(Math.abs(distance), speed * dt);
    x += Math.sign(distance) * step;
    stride = (stride + step * 5) % TAU;
    return step >= Math.abs(distance);
  }

  function advance(dt) {
    if (stopRemaining > 0) {
      stopRemaining = Math.max(0, stopRemaining - dt);
      if (stopRemaining === 0) settle();
      return;
    }
    elapsed += dt;
    if (mode === 'startled') {
      if (elapsed >= STARTLE_SECONDS) enter('return');
    } else if (mode === 'return') {
      if (move(HOME, 5, dt)) {
        face(0, dt);
        if (Math.abs(yaw) < 0.015) {
          yaw = 0;
          speed = 0;
          stride = 0;
          if (active(status)) enter('work');
          else rest();
        }
      }
    } else if (mode === 'walk') {
      if (move(destination, 1.35, dt)) {
        speed = 0;
        enter('idle', 5 + random() * 3);
        activity = nextActivity();
      }
    } else if (mode === 'idle') {
      face(0, dt);
      if (elapsed >= duration) rest();
    } else if (mode === 'rest' && status === 'idle' && elapsed >= duration) {
      pendingPrompt = false;
      roam();
    }
  }

  return {
    update(snapshot) {
      if (disposed) return;
      const previousStatus = status;
      status = snapshot?.status ?? 'idle';
      if (!initialized || snapshot?.id !== sessionId) {
        reset(snapshot?.id);
        return;
      }
      const awaitingPrompt = pendingPrompt;
      if (active(status)) pendingPrompt = false;
      if (!motion || status === 'closed') {
        settle();
        return;
      }
      if (active(status) && !active(previousStatus)) stopRemaining = 0;
      if (stopRemaining > 0 || mode === 'startled' || mode === 'return') return;
      if (active(status) && !active(previousStatus)) {
        if (awaitingPrompt && mode === 'rest') enter('work');
        else wake();
      } else if (!active(status) && active(previousStatus)) rest();
    },

    prompt() {
      if (disposed || !initialized || status !== 'idle' || pendingPrompt)
        return;
      stopRemaining = 0;
      if (wake()) pendingPrompt = true;
    },

    cancelPrompt() {
      if (disposed) return;
      pendingPrompt = false;
    },

    tick(dt) {
      if (
        disposed ||
        !initialized ||
        !motion ||
        !Number.isFinite(dt) ||
        dt <= 0
      ) {
        return;
      }
      // Bound recovery after a suspended tab and integrate at a steady step.
      let remaining = Math.min(dt, 1);
      while (remaining > 0.0000001) {
        const step = Math.min(remaining, 1 / 60);
        advance(step);
        remaining -= step;
      }
    },

    setMotion(enabled) {
      if (disposed || motion === Boolean(enabled)) return;
      motion = Boolean(enabled);
      pendingPrompt = false;
      settle();
      if (stopRemaining > 0) enter('rest');
    },

    stop() {
      if (disposed) return;
      pendingPrompt = false;
      settle();
      enter('rest');
      stopRemaining = 2.5;
    },

    dispose() {
      pendingPrompt = false;
      stopRemaining = 0;
      settle();
      disposed = true;
    },

    pose() {
      const startled = motion && mode === 'startled';
      const progress = Math.min(1, elapsed / STARTLE_SECONDS);
      return {
        mode,
        activity,
        elapsed,
        duration: mode === 'idle' ? duration : 0,
        x,
        z: 0,
        yaw,
        ground: x <= -4.05 ? 0 : -0.4 * smoothstep((x + 4.05) / 0.6),
        stride: motion ? stride : 0,
        jump: startled ? Math.sin(progress * Math.PI) * 1.35 : 0,
        surprise: startled ? 1 - smoothstep(progress) : 0,
      };
    },
  };
}
