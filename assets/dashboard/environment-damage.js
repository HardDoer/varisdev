// Decorative state belongs to one scene/session; this model has no task access.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const STEP = 1 / 60;
const EPSILON = 1e-9;
const DELAY = 5;
const ARRIVAL = 2;
const REPAIR = 3;
const EXTINGUISH = 0.75;
const DEPARTURE = 2;
const IGNITION = 0.6;
const SPREAD_DELAY = 1.5;
const SPREAD_RADIUS = 3;
const SPREAD_HOPS = 2;
const SPREAD_SITES = 8;

/** Register world-space {id, x, z} sites before applying weapon contacts. */
export function createEnvironmentDamage({maxSites = 128} = {}) {
  maxSites = Number.isFinite(maxSites)
    ? clamp(Math.floor(maxSites), 1, 256)
    : 128;
  let sites = new Map();
  let motion = true;
  let disposed = false;
  let pending = 0;

  function fresh({id, x, z}) {
    return {
      id,
      x,
      z,
      damage: 0,
      dent: 0,
      chips: 0,
      scorch: 0,
      heat: 0,
      fire: 0,
      fireAge: 0,
      phase: 'intact',
      phaseAge: 0,
      weapon: null,
      incident: null,
      spreadDepth: 0,
      spreadDone: false,
      repairStart: null,
    };
  }

  function hasActivity() {
    for (const site of sites.values()) if (site.phase !== 'intact') return true;
    return false;
  }

  function validId(id) {
    return (
      (typeof id === 'string' && id.length > 0) ||
      (typeof id === 'number' && Number.isFinite(id))
    );
  }

  // Rebuilding scene geometry keeps damage on surviving ids. Missing ids are
  // discarded; metadata and renderer objects remain owned by the scene.
  function setSites(descriptors) {
    if (disposed || !Array.isArray(descriptors)) return;
    const next = new Map();
    for (const descriptor of descriptors) {
      if (next.size >= maxSites) break;
      if (
        !descriptor ||
        !validId(descriptor.id) ||
        !Number.isFinite(descriptor.x) ||
        !Number.isFinite(descriptor.z) ||
        next.has(descriptor.id)
      )
        continue;
      const site = sites.get(descriptor.id) || fresh(descriptor);
      site.x = descriptor.x;
      site.z = descriptor.z;
      next.set(site.id, site);
    }
    sites = next;
    if (!hasActivity()) pending = 0;
  }

  function postpone(site) {
    site.phase = 'damaged';
    site.phaseAge = 0;
    site.repairStart = null;
  }

  function ignite(site, incident = null, depth = 0) {
    site.fire = 1;
    site.fireAge = 0;
    site.heat = IGNITION;
    site.spreadDepth = depth;
    site.spreadDone = false;
    site.incident = incident || {
      x: site.x,
      z: site.z,
      visited: new Set(),
    };
    site.incident.visited.add(site.id);
  }

  // Flame amounts are exposure seconds. Other amounts are contact strengths.
  function hit(id, weapon, amount = 1) {
    if (
      disposed ||
      !['cane', 'gun', 'flame'].includes(weapon) ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return false;
    const site = sites.get(id);
    if (!site) return false;
    amount = Math.min(amount, weapon === 'flame' ? 0.25 : 3);
    if (weapon === 'cane') {
      site.dent = clamp(site.dent + 0.09 * amount, 0, 1);
      site.damage = clamp(site.damage + 0.055 * amount, 0, 1);
    } else if (weapon === 'gun') {
      site.chips = clamp(site.chips + 0.28 * amount, 0, 1);
      site.damage = clamp(site.damage + 0.26 * amount, 0, 1);
    } else {
      site.scorch = clamp(site.scorch + 0.3 * amount, 0, 1);
      site.damage = clamp(site.damage + 0.15 * amount, 0, 1);
      site.heat = Math.min(IGNITION, site.heat + amount);
      if (!site.fire && site.heat + EPSILON >= IGNITION) ignite(site);
    }
    site.weapon = weapon;
    postpone(site);
    return true;
  }

  function spread(source) {
    source.spreadDone = true;
    const incident = source.incident;
    if (
      !incident ||
      source.spreadDepth >= SPREAD_HOPS ||
      incident.visited.size >= SPREAD_SITES
    )
      return;
    const candidates = [];
    for (const site of sites.values()) {
      if (
        site.fire ||
        incident.visited.has(site.id) ||
        site.phase === 'repairing' ||
        site.phase === 'leaving'
      )
        continue;
      const distance = Math.hypot(site.x - source.x, site.z - source.z);
      if (
        distance <= SPREAD_RADIUS &&
        Math.hypot(site.x - incident.x, site.z - incident.z) <=
          SPREAD_RADIUS * SPREAD_HOPS
      )
        candidates.push({site, distance});
    }
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        String(a.site.id).localeCompare(String(b.site.id)),
    );
    // Each source lights at most two neighbors; each incident has a shared cap
    // and remembers visited sites even after their repairs finish.
    for (const {site} of candidates.slice(0, 2)) {
      if (incident.visited.size >= SPREAD_SITES) break;
      ignite(site, incident, source.spreadDepth + 1);
      site.weapon = 'flame';
      site.scorch = clamp(site.scorch + 0.12, 0, 1);
      site.damage = clamp(site.damage + 0.06, 0, 1);
      postpone(site);
    }
  }

  function step() {
    const spreading = [];
    for (const site of sites.values()) {
      if (site.phase === 'intact') continue;
      site.phaseAge += STEP;
      if (site.fire > 0) site.fireAge += STEP;
      else site.heat = Math.max(0, site.heat - STEP * 0.08);
      if (site.phase === 'damaged' || site.phase === 'arriving') {
        if (site.fire > 0) {
          site.damage = clamp(site.damage + STEP * 0.045, 0, 1);
          site.scorch = clamp(site.scorch + STEP * 0.1, 0, 1);
          if (!site.spreadDone && site.fireAge + EPSILON >= SPREAD_DELAY)
            spreading.push(site);
        }
        if (site.phase === 'damaged' && site.phaseAge + EPSILON >= DELAY) {
          site.phase = 'arriving';
          site.phaseAge = Math.max(0, site.phaseAge - DELAY);
        } else if (
          site.phase === 'arriving' &&
          site.phaseAge + EPSILON >= ARRIVAL
        ) {
          site.phase = 'repairing';
          site.phaseAge = Math.max(0, site.phaseAge - ARRIVAL);
          site.repairStart = {
            damage: site.damage,
            dent: site.dent,
            chips: site.chips,
            scorch: site.scorch,
            fire: site.fire,
          };
        }
      } else if (site.phase === 'repairing') {
        const start = site.repairStart;
        site.fire = start.fire * clamp(1 - site.phaseAge / EXTINGUISH, 0, 1);
        const remaining = clamp(
          (REPAIR - site.phaseAge) / (REPAIR - EXTINGUISH),
          0,
          1,
        );
        for (const key of ['damage', 'dent', 'chips', 'scorch'])
          site[key] = start[key] * remaining;
        if (site.phaseAge + EPSILON >= REPAIR) {
          site.phase = 'leaving';
          site.phaseAge = Math.max(0, site.phaseAge - REPAIR);
          site.damage = site.dent = site.chips = site.scorch = 0;
          site.fire = site.fireAge = site.heat = 0;
          site.repairStart = null;
        }
      } else if (site.phaseAge + EPSILON >= DEPARTURE) {
        Object.assign(site, fresh(site));
      }
    }
    // New fires begin together after this substep, independent of Map order.
    for (const source of spreading) spread(source);
  }

  function tick(seconds) {
    if (
      disposed ||
      !motion ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      !hasActivity()
    )
      return;
    pending += seconds;
    // Keep fractional time across frames. Work stops as soon as the finite
    // repair/spread lifecycle ends, including after a long suspended interval.
    while (pending + EPSILON >= STEP) {
      pending = Math.max(0, pending - STEP);
      step();
      if (!hasActivity()) {
        pending = 0;
        break;
      }
    }
  }

  function pose(id) {
    const site = sites.get(id);
    if (!site || disposed) return null;
    const arriving = site.phase === 'arriving';
    const repairing = site.phase === 'repairing';
    const leaving = site.phase === 'leaving';
    return {
      id: site.id,
      x: site.x,
      z: site.z,
      damage: site.damage,
      dent: site.dent,
      chips: site.chips,
      scorch: site.scorch,
      fire: motion ? site.fire : 0,
      fireAge: motion ? site.fireAge : 0,
      weapon: site.weapon,
      phase: site.phase,
      phaseAge: site.phaseAge,
      repairProgress: repairing
        ? clamp(site.phaseAge / REPAIR, 0, 1)
        : leaving
          ? 1
          : 0,
      // Proximity to the site: edge=0, working position=1.
      botProgress: !motion
        ? 0
        : arriving
          ? clamp(site.phaseAge / ARRIVAL, 0, 1)
          : repairing
            ? 1
            : leaving
              ? clamp(1 - site.phaseAge / DEPARTURE, 0, 1)
              : 0,
    };
  }

  return {
    setSites,
    hit,
    tick,
    pose,
    poses: () => Array.from(sites.keys(), pose),
    active: () => !disposed && motion && hasActivity(),
    setMotion(enabled) {
      if (disposed) return;
      motion = Boolean(enabled);
    },
    // Keep the scene's registration when changing sessions.
    reset() {
      if (disposed) return;
      for (const site of sites.values()) Object.assign(site, fresh(site));
      pending = 0;
    },
    dispose() {
      disposed = true;
      sites.clear();
      pending = 0;
    },
  };
}
