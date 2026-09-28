/**
 * Pure terrain math shared by the terrain mesh and the astronauts' movement,
 * so feet always land on the rendered surface.
 */
import { CHUNK, LANDING_PAD, STATIONS, type Vec3 } from './config';

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Irregular, soft outline of the chunk: radius as a function of angle. */
export function outlineRadius(theta: number): number {
  return (
    CHUNK.radius *
    (1 + 0.055 * Math.sin(3 * theta + 0.7) + 0.035 * Math.sin(5 * theta + 2.1) + 0.018 * Math.sin(9 * theta + 0.3))
  );
}

/** Height at which the top surface meets the strata (the rounded lip). */
export const RIM_DROP = 0.6;

interface FlatZone {
  x: number;
  z: number;
  radius: number;
}

// Ground under stations and the pad is flattened so machines sit level.
const FLAT_ZONES: FlatZone[] = [
  ...Object.values(STATIONS).map((s) => ({ x: s.position[0], z: s.position[2], radius: s.footprint + 0.9 })),
  { x: LANDING_PAD.position[0], z: LANDING_PAD.position[2], radius: LANDING_PAD.radius + 0.6 },
];

/** Normalized distance from center: 0 at the middle, 1 at the outline. */
export function radialT(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r === 0) return 0;
  return r / outlineRadius(Math.atan2(z, x));
}

/** Shallow craters with a soft raised rim, in open ground. */
export const CRATERS: { x: number; z: number; radius: number; depth: number }[] = [
  { x: 3.5, z: 3.2, radius: 1.05, depth: 0.2 },
  { x: -3.8, z: 1.5, radius: 0.75, depth: 0.15 },
  { x: 1.8, z: -3.6, radius: 0.85, depth: 0.17 },
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

/** Gentle rolling bumps, flattened under machines and faded near the rim. */
export function terrainHeight(x: number, z: number): number {
  let bumps =
    0.24 * Math.sin(0.55 * x + 0.4) * Math.cos(0.5 * z - 0.8) +
    0.12 * Math.sin(0.9 * x + 1.1 * z + 1.3) +
    0.06 * Math.cos(1.6 * z - 0.7 * x + 0.5);

  for (const zone of FLAT_ZONES) {
    const d = Math.hypot(x - zone.x, z - zone.z);
    bumps *= smoothstep(zone.radius * 0.75, zone.radius * 1.4, d);
  }

  const t = radialT(x, z);
  bumps *= 1 - smoothstep(0.72, 0.94, t);

  // Rounded lip: a quarter-circle profile over the outer ~18% of the radius.
  const s = clamp((t - 0.82) / 0.18, 0, 1);
  const drop = RIM_DROP * (1 - Math.sqrt(1 - s * s));

  return bumps + craterOffset(x, z) - drop;
}

/** Point on the terrain surface above (x, z). */
export function surfacePoint(x: number, z: number): Vec3 {
  return [x, terrainHeight(x, z), z];
}

/** True if (x, z) is somewhere astronauts may walk. */
export function isWalkable(x: number, z: number): boolean {
  const theta = Math.atan2(z, x);
  const limit = (CHUNK.walkRadius * outlineRadius(theta)) / CHUNK.radius;
  return Math.hypot(x, z) <= limit;
}
