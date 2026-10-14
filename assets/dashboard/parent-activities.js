const TAU = Math.PI * 2;
const sides = [-1, 1];
const phase = (t, speed = 1) =>
  ((((Number.isFinite(t) ? t : 0) * speed) % 1) + 1) % 1;
const clock = t => (Number.isFinite(t) ? t : 0) % 3600;

// Arm points use the body base; feet are offsets from their planted positions.
export function idleActivityPose(activity, time) {
  const t = clock(time);
  const pose = {
    lift: 0,
    yaw: 0,
    feet: sides.map(() => ({x: 0, y: 0, z: 0})),
    arms: sides.map(side => ({
      elbow: [0.55, 1.2, side * 1.25],
      hand: [1.3, 0.98, side * 1.52],
    })),
  };
  const arm = (index, elbow, hand) => {
    pose.arms[index] = {elbow, hand};
  };
  switch (activity) {
    case 'coffee': {
      const sip = Math.pow((1 + Math.sin(t * 1.4)) / 2, 2);
      arm(0, [0.5, 1.5 + sip * 0.35, -1.25], [1.26, 1.35 + sip * 1.1, -0.66]);
      arm(1, [0.45, 1.35, 1.1], [1.18, 1.16, 0.3]);
      pose.yaw = Math.sin(t * 0.7) * 0.05;
      break;
    }
    case 'jump-rope': {
      const spin = t * 5;
      pose.lift = 0.36 * Math.pow(Math.max(0, Math.cos(spin)), 3);
      for (const [i, side] of sides.entries()) {
        pose.feet[i].y = pose.lift;
        arm(i, [0.2, 1.35, side * 1.4], [0.35, 1.65, side * 1.78]);
      }
      break;
    }
    case 'juggle':
      for (const [i, side] of sides.entries())
        arm(
          i,
          [0.7, 1.1 + Math.sin(t * 0.45 * 6 * TAU) * 0.06, side * 1.35],
          [1.35, 1.3 + Math.sin(t * 0.45 * 6 * TAU) * 0.12, side * 1.15],
        );
      pose.yaw = Math.sin(t * 2.8) * 0.06;
      break;
    case 'dance': {
      const beat = Math.sin(t * 4);
      pose.lift = Math.abs(beat) * 0.09;
      pose.yaw = Math.sin(t * 2) * 0.3;
      for (const [i, side] of sides.entries()) {
        const up = (1 + side * beat) / 2;
        pose.feet[i] = {
          x: side * beat * 0.17,
          y: pose.lift + up * 0.15,
          z: side * 0.12,
        };
        arm(
          i,
          [0.12, 1.7 + up * 0.7, side * 1.5],
          [0.4, 1.1 + up * 2.3, side * 1.9],
        );
      }
      break;
    }
    case 'stretch': {
      const reach = (1 + Math.sin(t * 1.2)) / 2;
      pose.yaw = Math.sin(t * 0.6) * 0.12;
      for (const [i, side] of sides.entries()) {
        pose.feet[i].z = side * 0.2;
        arm(
          i,
          [-0.12, 2.6, side * 1.35],
          [0.15, 3.4 + reach * 0.25, side * (0.7 - reach * 0.3)],
        );
      }
      break;
    }
    case 'weights':
      for (const [i, side] of sides.entries()) {
        const curl = (1 + Math.sin(t * 2 + i * Math.PI)) / 2;
        arm(
          i,
          [0.3, 1.23, side * 1.3],
          [0.65 + (1 - curl) * 0.45, 0.85 + curl * 1.5, side * 1.55],
        );
        pose.feet[i].z = side * 0.15;
      }
      break;
    case 'hula-hoop':
      pose.lift = Math.sin(t * 4) * 0.045;
      pose.yaw = Math.sin(t * 3) * 0.2;
      for (const [i, side] of sides.entries())
        arm(i, [0.05, 2.1, side * 1.45], [0.35, 2.65, side * 1.9]);
      break;
    case 'yo-yo': {
      const pull = Math.pow((1 + Math.cos(t * 2.7)) / 2, 5);
      arm(1, [0.5, 1.5, 1.35], [1.3, 1.95 + pull * 0.25, 1.5]);
      arm(0, [0.3, 1.2, -1.2], [0.8, 1.1, -1.4]);
      break;
    }
    case 'read':
      for (const [i, side] of sides.entries())
        arm(i, [0.65, 1.3, side * 1.08], [1.28, 1.72, side * 0.7]);
      pose.yaw = Math.sin(t * 0.65) * 0.045;
      break;
    case 'sweep': {
      const sweep = Math.sin(t * 1.8);
      arm(0, [0.65, 1.55, -1.05], [1.25, 1.65, -0.15 + sweep * 0.3]);
      arm(1, [0.65, 1.05, 1.08], [1.43, 0.94, 0.06 + sweep * 0.52]);
      pose.yaw = sweep * 0.12;
      break;
    }
    case 'balance':
      pose.feet[1] = {x: 0.3, y: 0.62, z: 0.3};
      pose.yaw = Math.sin(t * 1.4) * 0.11;
      for (const [i, side] of sides.entries())
        arm(
          i,
          [0.05, 1.95 + side * Math.sin(t * 1.4) * 0.12, side * 1.5],
          [0.15, 2 + side * Math.sin(t * 1.4) * 0.22, side * 2.15],
        );
      break;
    case 'paper-plane': {
      const p = phase(t, 0.22);
      const throwStroke = Math.sin(Math.min(1, p / 0.2) * Math.PI);
      arm(
        0,
        [0.35 + throwStroke * 0.2, 1.95, -1.2],
        [1.25 + throwStroke * 0.25, 2.35 + throwStroke * 0.12, -1.05],
      );
      arm(1, [0.5, 1.25, 1.15], [1.08, 1.4, 0.55]);
      break;
    }
  }
  return pose;
}

// All props share the robot's local transform, including its current body lift.
export function drawIdleActivity(g, fx, C, activity, time, pose) {
  const t = clock(time);
  const base = 0.4 + pose.lift;
  const point = p => [p[0], p[1] + base, p[2]];
  const rod = (a, b, radius, color, emission = 0) =>
    g.rod(point(a), point(b), radius, color, emission);
  const box = (p, s, color, emission = 0, yaw = 0) =>
    g.box(point(p), s, color, emission, yaw);
  const ball = (p, size, color) =>
    g.octagon(point(p), [size, size, size], color, 0.15);
  const curve = (sample, segments, radius, color, emission = 0) => {
    let previous = sample(0);
    for (let i = 1; i <= segments; i++) {
      const next = sample(i / segments);
      rod(previous, next, radius, color, emission);
      previous = next;
    }
  };
  const hands = pose.arms.map(a => a.hand);
  switch (activity) {
    case 'coffee': {
      const h = hands[0];
      const mug = [h[0] + 0.06, h[1] + 0.12, h[2] + 0.25];
      g.cylinder(point(mug), [0.43, 0.49, 0.43], C.white);
      g.cylinder(
        point([mug[0], mug[1] + 0.25, mug[2]]),
        [0.34, 0.014, 0.34],
        C.dark,
      );
      curve(
        u => [
          mug[0],
          mug[1] + Math.sin(u * TAU) * 0.17,
          mug[2] - 0.25 - Math.cos(u * TAU) * 0.16,
        ],
        14,
        0.045,
        C.amber,
      );
      for (let i = 0; i < 2; i++)
        curve(
          u => [
            mug[0] + Math.sin(u * 7 - t * 2 + i) * 0.07,
            mug[1] + 0.29 + u * 0.5,
            mug[2] + (i - 0.5) * 0.14,
          ],
          8,
          0.017,
          C.white,
          0.35,
        );
      break;
    }
    case 'jump-rope': {
      const spin = t * 5;
      curve(
        u => [
          0.35 + Math.sin(Math.PI * u) * Math.sin(spin) * 1.75,
          1.65 - Math.sin(Math.PI * u) * Math.cos(spin) * 1.7,
          -1.78 + u * 3.56,
        ],
        32,
        0.035,
        C.amber,
        0.3,
      );
      for (const h of hands)
        rod([h[0], h[1], h[2] - 0.13], [h[0], h[1], h[2] + 0.13], 0.09, C.cyan);
      break;
    }
    case 'juggle':
      for (let i = 0; i < 3; i++) {
        const a = (phase(t, 0.45) + i / 3) * TAU;
        ball(
          [1.35, 1.47 + 2.15 * Math.abs(Math.sin(a)), Math.cos(a) * 1.15],
          0.3,
          [C.amber, C.cyan, C.mint][i],
        );
      }
      break;
    case 'dance':
      for (const [i, side] of sides.entries()) {
        const y = 2.8 + Math.sin(t * 4 + i) * 0.2;
        const z = side * 2.1;
        ball([0.1, y, z], 0.19, C.cyan);
        rod([0.1, y, z], [0.1, y + 0.52, z], 0.035, C.cyan, 0.6);
        rod(
          [0.1, y + 0.52, z],
          [0.1, y + 0.42, z + side * 0.23],
          0.04,
          C.cyan,
          0.6,
        );
      }
      fx.ring(
        [0, 0.42, 0],
        1.65 + Math.sin(t * 4) * 0.12,
        0.04,
        C.mint,
        0.5,
        28,
      );
      break;
    case 'stretch':
      // A curved exercise band stays attached to both overhead hands.
      curve(
        u => [
          0.15,
          hands[0][1] - Math.sin(u * Math.PI) * 0.17,
          hands[0][2] + (hands[1][2] - hands[0][2]) * u,
        ],
        16,
        0.065,
        C.mint,
      );
      break;
    case 'weights':
      for (const h of hands) {
        rod(
          [h[0], h[1], h[2] - 0.39],
          [h[0], h[1], h[2] + 0.39],
          0.065,
          C.metal,
        );
        for (const side of sides) {
          rod(
            [h[0], h[1], h[2] + side * 0.25],
            [h[0], h[1], h[2] + side * 0.43],
            0.27,
            C.dark,
          );
          rod(
            [h[0], h[1], h[2] + side * 0.43],
            [h[0], h[1], h[2] + side * 0.47],
            0.19,
            C.amber,
          );
        }
      }
      break;
    case 'hula-hoop': {
      const spin = t * 3;
      curve(
        u => {
          const a = u * TAU;
          return [
            Math.cos(spin) * 0.16 + Math.cos(a) * 1.83,
            1.05 + Math.sin(a - spin) * 0.28,
            Math.sin(spin) * 0.16 + Math.sin(a) * 1.83,
          ];
        },
        40,
        0.06,
        C.amber,
        0.3,
      );
      ball([Math.cos(spin) * 1.99, 1.05, Math.sin(spin) * 1.99], 0.16, C.cyan);
      break;
    }
    case 'yo-yo': {
      const h = hands[1];
      const length = 0.25 + (1.35 * (1 - Math.cos(t * 2.7))) / 2;
      const end = [h[0] + Math.sin(t * 2.7) * 0.13, h[1] - length, h[2]];
      rod(h, end, 0.018, C.white, 0.2);
      for (const side of sides)
        rod(
          [end[0], end[1], end[2] + side * 0.035],
          [end[0], end[1], end[2] + side * 0.12],
          0.19,
          C.cyan,
        );
      rod(
        [end[0], end[1], end[2] - 0.04],
        [end[0], end[1], end[2] + 0.04],
        0.06,
        C.metal,
      );
      ball(
        [
          end[0] + Math.cos(t * 14) * 0.12,
          end[1] + Math.sin(t * 14) * 0.12,
          end[2] + 0.125,
        ],
        0.05,
        C.amber,
      );
      break;
    }
    case 'read': {
      // Sloped pages form a shallow open V above the supporting hands.
      for (const side of sides) {
        for (let j = 0; j < 8; j++) {
          const z = side * (j + 0.5) * 0.09;
          const y = 1.79 + Math.abs(z) * 0.2;
          box([1.3, y, z], [0.72, 0.07, 0.095], C.white);
          box([1.3, y - 0.06, z], [0.8, 0.045, 0.095], C.cyan);
          if (j % 2 === 0)
            box([1.34, y + 0.04, z], [0.45, 0.008, 0.018], C.dim);
        }
      }
      rod([0.91, 1.76, 0], [1.69, 1.76, 0], 0.045, C.dark);
      const turn = phase(t, 0.22) * Math.PI;
      for (let j = 0; j < 7; j++) {
        const r = (j + 0.5) * 0.085;
        rod(
          [0.96, 1.86 + Math.sin(turn) * r, Math.cos(turn) * r],
          [1.64, 1.86 + Math.sin(turn) * r, Math.cos(turn) * r],
          0.045,
          C.white,
        );
      }
      break;
    }
    case 'sweep': {
      const a = hands[0],
        b = hands[1];
      const floorY = 0.16 - pose.lift;
      const ratio = (floorY - a[1]) / (b[1] - a[1]);
      const head = [
        a[0] + (b[0] - a[0]) * ratio,
        floorY,
        a[2] + (b[2] - a[2]) * ratio,
      ];
      rod(
        [a[0] - 0.06, a[1] + 0.24, a[2] - (b[2] - a[2]) * 0.34],
        head,
        0.055,
        C.metal,
      );
      box(head, [0.24, 0.12, 0.74], C.amber);
      for (let i = 0; i < 9; i++) {
        const z = head[2] + (i - 4) * 0.075;
        rod(
          [head[0], head[1] - 0.04, z],
          [head[0] + 0.1, 0.01 - pose.lift, z + (i - 4) * 0.015],
          0.028,
          C.dim,
        );
      }
      for (let i = 0; i < 4; i++)
        ball(
          [
            1.85 + Math.sin(i * 2) * 0.15,
            0.04 - pose.lift,
            Math.sin(t * 1.8 - i * 0.2) * 0.8,
          ],
          0.065,
          C.amber,
        );
      break;
    }
    case 'balance': {
      // A stack balanced on the helmet wobbles with the arms' correction.
      const wobble = Math.sin(t * 1.4);
      for (let i = 0; i < 3; i++)
        box(
          [0.05 + wobble * i * 0.035, 3.21 + i * 0.15, wobble * i * 0.045],
          [0.65 - i * 0.09, 0.13, 0.65 - i * 0.09],
          [C.amber, C.cyan, C.mint][i],
          0,
          wobble * (i + 1) * 0.08,
        );
      break;
    }
    case 'paper-plane': {
      const p = phase(t, 0.22);
      const travel = Math.max(0, (p - 0.2) / 0.8);
      const h = hands[0];
      const center = [
        h[0] + Math.sin(travel * Math.PI) * 0.65,
        h[1] + 0.14 + Math.sin(travel * Math.PI) * 0.75,
        h[2] + Math.sin(travel * Math.PI) * 2.25,
      ];
      const yaw = travel * TAU;
      const planePoint = (x, y, z) => [
        center[0] + x * Math.cos(yaw) + z * Math.sin(yaw),
        center[1] + y,
        center[2] + z * Math.cos(yaw) - x * Math.sin(yaw),
      ];
      // Solid strips fill two triangular wings; the central fold has depth.
      for (let i = 0; i < 10; i++) {
        const x = -0.4 + (i + 0.5) * 0.08;
        box(
          planePoint(x, 0, 0),
          [0.085, 0.025, (1 - i / 10) * 0.72],
          C.white,
          0,
          yaw,
        );
      }
      rod(planePoint(-0.4, -0.12, 0), planePoint(0.4, 0, 0), 0.035, C.cyan);
      rod(planePoint(-0.4, 0, 0), planePoint(-0.4, -0.12, 0), 0.025, C.white);
      break;
    }
  }
}
