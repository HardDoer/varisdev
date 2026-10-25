import {iso} from './year1998-geometry.js';

/** Factory scenery for the shared Canvas2D scene and its damage surfaces. */
export function createFactory2DScenery({
  box,
  tile,
  panel,
  line,
  rect,
  object,
  decorate,
  state,
  bays,
}) {
  function ground() {
    const {colors: c, identity} = state();
    box(-1.3, -0.45, 21, 11.9, 0, c.floor, c.edge, c.dark, -6);
    // The central transport lane stays clear for robots and visitors.
    tile(-11.6, -0.65, 20.6, 1.3, c.dark);
    for (const z of [-0.7, 0.65]) tile(-11.6, z, 20.6, 0.07, c.cyan);
    bays.forEach(([x, z]) => {
      tile(x - 1.7, z - 2.2, 3, 3.2, c.edge);
      tile(x - 1.6, z - 2.1, 2.8, 3, c.dark);
      tile(x - 1.6, z + 0.8, 2.8, 0.1, c.metal);
    });
    tile(-8.8, -2.65, 4.5, 3.35, c.edge);
    tile(-8.65, -2.5, 4.2, 3.05, c.dark);
    tile(-8.65, 0.45, 4.2, 0.1, c[identity.accentKey]);
    line([iso(-11.8, 5.5), iso(9.2, 5.5), iso(9.2, -6.4)], c.metal);
    for (let x = -11; x < 9; x += 0.6) tile(x, 5.2, 0.3, 0.2, c.amber);
  }

  function walls() {
    const {colors: c, identity} = state();
    object('wall:back', () => {
      panel(-11.8, -6.4, 21, 0, 44, c.edge);
      panel(-11.8, -6.39, 21, 42, 45, c.metal);
      panel(-11.8, -6.38, 21, 4, 6, c.cyan);
      for (const x of [-11.6, -6.6, -1.6, 3.4, 8.9]) {
        panel(x, -6.35, 0.25, 0, 44, c.metal);
        panel(x + 0.04, -6.33, 0.08, 6, 40, c.dark);
      }
      for (const x of [-10.8, -5.8, -0.8, 4.2]) {
        panel(x, -6.32, 3.7, 18, 36, c.dark);
        panel(x + 0.15, -6.3, 3.4, 20, 34, c.screen);
        panel(x + 0.2, -6.28, 3.3, 31, 33, c[identity.accentKey]);
        panel(x + 1.8, -6.27, 0.12, 20, 34, c.metal);
      }
    });
    object('wall:left', () => {
      panel(-11.8, -6.4, 11.9, 0, 44, c.dark, 'z');
      panel(-11.78, -6.4, 11.9, 42, 45, c.metal, 'z');
      for (const z of [-5.9, -1.5, 3.5]) {
        panel(-11.75, z, 0.2, 0, 43, c.edge, 'z');
        panel(-11.73, z + 0.35, 2.5, 21, 24, c.metal, 'z');
        panel(-11.72, z + 0.4, 2.4, 22, 23, c.amber, 'z');
      }
    });
  }

  function workstation(x, z, unit, manager) {
    const {colors: c, time, identity} = state();
    const cx = x - 0.25,
      cz = z - 1.2,
      w = manager ? 3.6 : 2.9;
    const accent = manager ? c[identity.accentKey] : c.cyan;
    box(cx, cz, w - 0.3, 1.6, 10, c.edge, c.dark, c.edge);
    box(cx, cz, w, 1.9, 13, c.metal, c.edge, c.dark, 10);
    panel(cx - w / 2 + 0.15, cz + 0.96, w - 0.3, 10, 12, accent);
    box(cx, cz - 0.3, 1.6, 0.25, 29, c.metal, c.outline, c.edge, 14);
    panel(cx - 0.7, cz - 0.16, 1.4, 18, 27, c.screen);
    const working = ['running', 'cancelling', 'compacting'].includes(
      unit?.status,
    );
    decorate(() => {
      for (let row = 0; row < 3; row++)
        panel(
          cx - 0.55,
          cz - 0.14,
          working ? 0.3 + ((time * 0.6 + row * 0.3) % 0.8) : 0.5 + row * 0.15,
          20 + row * 2,
          21 + row * 2,
          c.eyes,
        );
    });
    tile(cx - 0.7, cz + 0.2, 1.4, 0.5, c.screen, 14);
    for (let i = 0; i < 5; i++)
      tile(cx - 0.6 + i * 0.24, cz + 0.3, 0.12, 0.15, c.metal, 14.1);
    tile(cx + w / 2 - 0.45, cz + 0.3, 0.22, 0.3, c[unit?.status] || c.dim, 14);
  }

  function queue(x, z) {
    const {colors: c} = state();
    box(x, z, 0.75, 0.8, 10, c.metal, c.edge, c.dark);
    box(x, z, 0.65, 0.65, 13, c.queued, c.edge, c.dark, 10);
    tile(x - 0.2, z - 0.2, 0.4, 0.4, c.screen, 14);
  }

  function machinery(kind, x, z) {
    const {colors: c, time} = state();
    if (kind === 'printer') {
      // Rollers turn beneath a part at the inspection station.
      box(x, z, 1.6, 1.1, 10, c.metal, c.edge, c.dark);
      box(x, z, 1.4, 0.85, 14, c.dark, c.metal, c.edge, 10);
      decorate(() => {
        for (let i = 0; i < 5; i++) {
          const dx = ((i / 5 + time * 0.12) % 1) * 1.2 - 0.6;
          tile(x + dx, z - 0.35, 0.08, 0.7, c.metal, 14.1);
        }
      });
      box(x, z, 0.45, 0.45, 20, c.amber, c.edge, c.metal, 14);
    } else if (kind === 'cooler') {
      box(x, z, 0.7, 0.8, 27, c.metal, c.edge, c.dark);
      panel(x - 0.22, z + 0.41, 0.44, 6, 23, c.screen);
      panel(x - 0.12, z + 0.42, 0.24, 8, 21, c.cyan);
    } else {
      const h = kind === 'server' ? 35 : 28;
      box(x, z, 1, 0.8, h, c.metal, c.edge, c.dark);
      for (let low = 3; low < h - 2; low += 6) {
        panel(x - 0.4, z + 0.42, 0.8, low, low + 4, c.screen);
        const led = iso(x + 0.25, z + 0.44, low + 2);
        rect(led[0], led[1], 2, 1, low % 2 ? c.mint : c.violet);
      }
    }
  }
  return {ground, walls, workstation, queue, machinery};
}
