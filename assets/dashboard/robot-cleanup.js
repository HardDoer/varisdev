// Shared miniature tow bot geometry, relative to the wreck's floor position.
export function drawCleanupBot(g, fx, C, cleanup) {
  if (!cleanup) return;
  const [x, y, z] = cleanup.position;
  const at = (dx, dy, dz) => [x + dx, y + dy, z + dz];
  g.octagon(at(0, 0.025, 0), [1.9, 0.025, 1.8], C.dark);
  for (const side of [-1, 1]) {
    g.box(at(0, 0.27, side * 0.68), [1.5, 0.34, 0.3], C.dark);
    for (const axle of [-0.48, 0, 0.48]) {
      const wheel = at(axle, 0.27, side * 0.84);
      g.rod(
        [wheel[0], wheel[1], wheel[2] - 0.035],
        [wheel[0], wheel[1], wheel[2] + 0.035],
        0.2,
        C.metal,
      );
      const angle = cleanup.wheel + axle;
      g.rod(
        wheel,
        [
          wheel[0] + Math.cos(angle) * 0.14,
          wheel[1] + Math.sin(angle) * 0.14,
          wheel[2],
        ],
        0.025,
        C.amber,
      );
    }
    const spread = 0.64 - cleanup.grip * 0.3;
    const elbow = at(-1.05, 0.28, side * spread);
    const claw = at(-1.48, 0.14 + cleanup.grip * 0.08, side * spread);
    g.rod(at(-0.55, 0.57, side * 0.48), elbow, 0.075, C.metal);
    g.rod(elbow, claw, 0.055, C.white);
    g.box(claw, [0.48, 0.1, 0.12], C.amber);
    g.rod(claw, at(-1.7, claw[1] - y, side * (spread - 0.18)), 0.06, C.dark);
    g.box(at(-0.12, 0.62, side * 0.61), [0.7, 0.13, 0.035], C.dark);
  }
  g.box(at(0, 0.56, 0), [1.35, 0.58, 1.15], C.amber);
  g.box(at(-0.28, 0.9, 0), [0.72, 0.16, 1.04], C.shell);
  g.box(at(-0.69, 0.65, 0), [0.05, 0.3, 0.86], C.dark);
  for (const side of [-1, 1])
    g.box(at(-0.725, 0.69, side * 0.23), [0.025, 0.13, 0.18], C.cyan, 1);
  // A refuse bin behind the cab and a warning beacon distinguish the janitor.
  g.box(at(0.43, 0.95, 0), [0.5, 0.42, 0.84], C.metal);
  g.box(at(0.43, 1.19, 0), [0.59, 0.07, 0.94], C.dark);
  for (const stripe of [-1, 1])
    g.box(at(0.7, 0.96, stripe * 0.22), [0.025, 0.25, 0.09], C.amber);
  g.cylinder(at(-0.24, 1.03, 0), [0.24, 0.14, 0.24], C.dark);
  g.octagon(at(-0.24, 1.15, 0), [0.19, 0.16, 0.19], C.amber, 0.9);
  fx.octagon(at(-0.24, 1.15, 0), [0.3, 0.25, 0.3], C.amber, 0.15);
}
