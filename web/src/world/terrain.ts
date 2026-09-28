/**
 * Pure terrain math shared by the terrain mesh and the astronauts' movement,
 * so feet always land on the rendered surface.
 *
 * The surface is a patch of a big planet: a gently rolling base area around
 * the origin where the stations sit, rising into soft hills further out.
 */
import { LANDING_PAD, STATIONS, SURFACE, type Vec3 } from './config';

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Value noise (deterministic, no dependencies)
// ---------------------------------------------------------------------------

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth 2D value noise in [0, 1]. */
function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Two octaves of noise, roughly in [-1, 1]. */
function fbm(x: number, z: number): number {
  return (valueNoise(x, z) - 0.5) * 1.4 + (valueNoise(x * 2.1 + 17, z * 2.1 - 9) - 0.5) * 0.6;
}

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

interface FlatZone {
  x: number;
  z: number;
  radius: number;
}

// Ground under stations and the pad is flattened so machines sit level.
const FLAT_ZONES: FlatZone[] = [
  ...Object.values(STATIONS).map((s) => ({ x: s.position[0], z: s.position[2], radius: s.footprint + 1.2 })),
  { x: LANDING_PAD.position[0], z: LANDING_PAD.position[2], radius: LANDING_PAD.radius + 0.8 },
];

/** Shallow craters with a soft raised rim, in open ground. */
export const CRATERS: { x: number; z: number; radius: number; depth: number }[] = [
  { x: 6.5, z: 5.5, radius: 1.5, depth: 0.25 },
  { x: -8, z: 3.5, radius: 1.1, depth: 0.2 },
  { x: 3.5, z: -8, radius: 1.2, depth: 0.22 },
  { x: 11, z: 3, radius: 0.9, depth: 0.18 },
  { x: -3, z: 12, radius: 1.3, depth: 0.22 },
];

/** 0..1: how much (x, z) is inside a crater bowl (for tinting). */
export function craterAmount(x: number, z: number): number {
  let amount = 0;
  for (const c of CRATERS) {
    const d = Math.hypot(x - c.x, z - c.z) / c.radius;
    amount = Math.max(amount, 1 - smoothstep(0.55, 1.0, d));
  }
  return amount;
}

function craterOffset(x: number, z: number): number {
  let offset = 0;
  for (const c of CRATERS) {
    const d = Math.hypot(x - c.x, z - c.z) / c.radius;
    if (d > 1.8) continue;
    const bowl = -c.depth * (1 - smoothstep(0.1, 1.0, d));
    const rim = c.depth * 0.45 * Math.exp(-(((d - 1.0) / 0.28) ** 2));
    offset += bowl + rim;
  }
  return offset;
}

/** 0 in the base area, rising to 1 out in the hills. */
export function hillAmount(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // Wobble the edge of the base so it isn't a perfect circle.
  const edge = SURFACE.baseRadius + fbm(x * 0.08 + 40, z * 0.08) * 3;
  return smoothstep(edge, edge + 7, r);
}

/** Terrain height at (x, z). */
export function terrainHeight(x: number, z: number): number {
  // Small rolling bumps plus fine roughness that makes the low-poly facets read.
  const bumps = fbm(x * 0.2, z * 0.2) * 0.45 + fbm(x * 0.9 + 11, z * 0.9 - 3) * 0.14;

  // Big soft hills beyond the base.
  const hills = hillAmount(x, z);
  const hillShape = (fbm(x * 0.05, z * 0.05) * 0.8 + 0.75) * SURFACE.hillHeight + fbm(x * 0.14 + 5, z * 0.14) * 1.6;

  // Everything (bumps, craters, hills) fades to 0 under stations and the pad,
  // so machines always sit level at y = 0 and never sink into the ground.
  let flat = 1;
  for (const zone of FLAT_ZONES) {
    const d = Math.hypot(x - zone.x, z - zone.z);
    flat *= smoothstep(zone.radius * 0.75, zone.radius * 1.4, d);
  }

  return (bumps + craterOffset(x, z) + hills * Math.max(0, hillShape)) * flat;
}

/** Point on the terrain surface above (x, z). */
export function surfacePoint(x: number, z: number): Vec3 {
  return [x, terrainHeight(x, z), z];
}

/** True if (x, z) is somewhere astronauts may walk. */
export function isWalkable(x: number, z: number): boolean {
  return Math.hypot(x, z) <= SURFACE.walkRadius;
}

/** Height astronauts stand at: the terrain, plus the deck when on the landing pad. */
export function groundHeight(x: number, z: number): number {
  const d = Math.hypot(x - LANDING_PAD.position[0], z - LANDING_PAD.position[2]);
  const onPad = 1 - smoothstep(LANDING_PAD.radius - 0.15, LANDING_PAD.radius + 0.1, d);
  return terrainHeight(x, z) + onPad * LANDING_PAD.deckHeight;
}
