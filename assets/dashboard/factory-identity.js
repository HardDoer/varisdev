// Stable, theme-aware visual variation for a parent session's factory.
// Identity values are deliberately discrete: geometry and color stay consistent
// across snapshots, reloads, and machines without persisting extra state.

export function stableFactoryHash(value) {
  let hash = 2166136261;
  for (const character of String(value ?? '')) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

export function factoryIdentity(sessionId) {
  const hash = stableFactoryHash(sessionId);
  const accentKeys = ['mint', 'cyan', 'amber'];
  return Object.freeze({
    token: hash.toString(36),
    accentKey: accentKeys[hash % accentKeys.length],
    // Variants only affect rear-wall and overhead details. Work bays, aisles,
    // consoles, and their purpose remain in the same collision-safe layout.
    gantry: (hash >>> 4) % 3,
    roof: (hash >>> 7) % 3,
    utilities: 2 + ((hash >>> 10) % 3),
    stripePhase: (hash >>> 13) % 4,
  });
}

const mix = (first, second, amount) =>
  first.map((value, index) => value + (second[index] - value) * amount);

export function factoryIdentityPalette(palette, identity) {
  const accent = palette[identity.accentKey] || palette.cyan;
  return {
    // Semantic running/queued/completed/failure colors are never replaced.
    ...palette,
    factoryFloor: mix(palette.floor, accent, 0.1),
    factoryEdge: mix(palette.edge, accent, 0.18),
    factoryMetal: mix(palette.metal, accent, 0.12),
    factoryAccent: mix(accent, palette.white, 0.08),
  };
}
