import {iso} from './year1998-geometry.js';

const clamp = n => Math.max(0, Math.min(1, n));
const smooth = n => {
  const t = clamp(n);
  return t * t * (3 - 2 * t);
};

// Descend above the work site through the open roof. The entry height follows
// the camera so the entire craft (and any suspended wreck) starts offscreen.
function height(x, z, hover, progress, viewTop) {
  const entry = Math.max(hover + 90, iso(x, z)[1] - viewTop + 70);
  return entry + (hover - entry) * smooth(progress);
}

function departingHeight(
  x,
  z,
  altitude,
  progress,
  leaving,
  clearance,
  viewTop,
  route,
) {
  const weight = 1 - smooth(progress);
  altitude += (route.extension || 0) * weight;
  const boundary = iso(x, z)[1] - viewTop;
  if (!leaving) route.exited = false;
  else if (altitude > boundary + clearance) route.exited = true;
  // Extend an already hidden departure when a resize reveals more of the sky.
  // Retain that extension on recall, tapering it to zero at the work position.
  if (route.exited && altitude < boundary + clearance && weight > 0) {
    const extension = boundary + 70 - altitude;
    route.extension = (route.extension || 0) + extension / weight;
    altitude += extension;
  }
  return altitude;
}

export function officeRepairFlight(
  site,
  pose,
  viewTop,
  route = {exited: false},
) {
  if (pose.phase === 'intact' || pose.phase === 'damaged') {
    route.exited = false;
    route.extension = 0;
  }
  const x = Math.max(-11.1, Math.min(8.5, site.x + 0.55));
  const z = Math.max(-5.65, Math.min(4.9, site.z + 0.5));
  return [
    x,
    departingHeight(
      x,
      z,
      height(x, z, Math.max(14, (site.h || 0) + 12), pose.botProgress, viewTop),
      pose.botProgress,
      pose.phase === 'leaving',
      5,
      viewTop,
      route,
    ),
    z,
  ];
}

export function officeCleanupFlight(
  home,
  pose,
  viewTop,
  route = {exited: false},
) {
  if (!pose.cleanup) return null;
  const x = home[0] + pose.offset[0] + 0.65;
  const z = home[1] + pose.offset[2] - 0.35;
  const arrival = clamp(pose.phaseAge / 2);
  const departure = clamp((pose.phaseAge - 3.1) / 2.9);
  const altitude = departingHeight(
    x,
    z,
    height(x, z, 25, arrival * (1 - departure), viewTop),
    arrival * (1 - departure),
    pose.cleanup.phase === 'leave',
    30,
    viewTop,
    route,
  );
  return {
    position: [x, altitude, z],
    cableLength:
      pose.cleanup.phase === 'arrive'
        ? 7 + clamp((pose.phaseAge - 1.4) / 0.6) * 10
        : 17 - pose.cleanup.grip * 6,
    wreckLift:
      smooth((pose.cleanup.grip - 0.6) / 0.4) * 8 +
      (pose.cleanup.phase === 'leave' ? altitude - 25 : 0),
  };
}
