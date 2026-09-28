/**
 * World layout: the single source of truth for where things are on the chunk.
 *
 * Station positions, approach points (where astronauts stand to work),
 * the landing pad, decorations and camera limits all live here. Coordinates
 * are in world units, y-up. The chunk's top surface sits around y = 0.
 *
 * The default camera looks from +X/+Z toward the origin, so on screen
 * "right" is +X/-Z and "far" is -X/-Z.
 */
import type { StationId } from '@groundcrew/shared';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PALETTE = {
  terrainTop: '#f7b99c',
  terrainHigh: '#fcd3b8',
  terrainLow: '#ec9f88',
  craterFloor: '#e3a3a0',
  // Alternating light/dark bands read as layered rock from a distance.
  strata: ['#f09a84', '#dd7a70', '#f2ad8e', '#c47489', '#a97fb4', '#7c6aa8'],
  underside: '#5a5190',
  // The camera always looks down, so only the part of the sky dome below the
  // horizon is ever on screen: peach glow near the horizon, cooling to
  // periwinkle underneath.
  skyZenith: '#94b8ee',
  skyHorizon: '#ffd2bb',
  skyLow: '#f6b9cb',
  skyMid: '#c9b3ea',
  skyNadir: '#98a3e6',
  shadowTint: '#9d86c7',
  sunlight: '#fff0dc',
  machineBody: '#fbf3ea',
  machineDark: '#5b5078',
  machineTrim: '#e8dcf0',
  mint: '#8ee6c4',
  teal: '#3ec9b6',
  glass: '#2f2b57',
} as const;

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

export const CHUNK = {
  /** Average radius of the chunk's top surface. */
  radius: 8.2,
  /** Walkable radius (astronauts stay inside this). */
  walkRadius: 6.7,
  /** Lowest point of the tapering underside. */
  bottomY: -9.2,
} as const;

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export interface StationConfig {
  id: StationId;
  label: string;
  /** What the station is used for, shown in the HUD legend. */
  description: string;
  /** Strong accent color unique to this station. */
  accent: string;
  /** Center of the station footprint on the ground. */
  position: Vec3;
  /** Rotation around Y. The station's front (local +Z) faces this way. */
  yaw: number;
  /** Radius of the circular obstacle astronauts walk around. */
  footprint: number;
  /** Standing spots in front of the station, one per working astronaut. */
  approach: Vec3[];
  /** Yaw an astronaut should face while working (toward the station). */
  workYaw: number;
}

/** Yaw that makes local +Z point from `from` toward `to` on the XZ plane. */
export function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(to[0] - from[0], to[2] - from[2]);
}

/**
 * Standing spots in a shallow arc in front of a station: `count` points at
 * `distance` from the station center, spread `spacing` apart sideways.
 */
function approachSlots(position: Vec3, yaw: number, distance: number, spacing: number, count = 3): Vec3[] {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  // Perpendicular (to the station's right).
  const rx = fz;
  const rz = -fx;
  const slots: Vec3[] = [];
  // Order: center, left, right, ... so the first worker gets the best spot.
  for (let i = 0; i < count; i++) {
    const side = i === 0 ? 0 : (i % 2 === 1 ? -1 : 1) * Math.ceil(i / 2);
    const lateral = side * spacing;
    // Pull side slots slightly back so the group forms an arc.
    const d = distance + Math.abs(side) * 0.25;
    slots.push([position[0] + fx * d + rx * lateral, 0, position[2] + fz * d + rz * lateral]);
  }
  return slots;
}

function station(
  id: StationId,
  label: string,
  description: string,
  accent: string,
  position: Vec3,
  footprint: number,
  approachDistance: number,
): StationConfig {
  // Every station faces the middle of the chunk.
  const yaw = yawToward(position, [0, 0, 0]);
  const approach = approachSlots(position, yaw, approachDistance, 1.0);
  return {
    id,
    label,
    description,
    accent,
    position,
    yaw,
    footprint,
    approach,
    workYaw: yaw + Math.PI,
  };
}

export const STATIONS: Record<StationId, StationConfig> = {
  fabricator: station('fabricator', 'Fabricator', 'Edit / Write files', '#ff8a3d', [-4.8, 0, -1.2], 1.35, 1.75),
  scanner: station('scanner', 'Scanner', 'Read / Grep / Glob', '#2ec4b6', [-1.2, 0, -4.8], 1.2, 1.65),
  drill: station('drill', 'Drill', 'Bash commands', '#ffc23c', [-2.5, 0, 4.3], 1.2, 1.7),
  radar: station('radar', 'Radar Dish', 'Web search / fetch', '#ff6f9f', [4.3, 0, -2.5], 1.25, 1.75),
};

// ---------------------------------------------------------------------------
// Landing pad
// ---------------------------------------------------------------------------

const PAD_POSITION: Vec3 = [1.0, 0, 1.0];

export const LANDING_PAD = {
  position: PAD_POSITION,
  radius: 1.55,
  /** Height of the pad deck above the ground. */
  deckHeight: 0.2,
  /** Where waiting astronauts stand (on the pad, facing the camera). */
  slots: [
    [PAD_POSITION[0], 0, PAD_POSITION[2]],
    [PAD_POSITION[0] - 0.75, 0, PAD_POSITION[2] + 0.35],
    [PAD_POSITION[0] + 0.35, 0, PAD_POSITION[2] - 0.75],
    [PAD_POSITION[0] + 0.55, 0, PAD_POSITION[2] + 0.6],
    [PAD_POSITION[0] - 0.6, 0, PAD_POSITION[2] - 0.55],
  ] as Vec3[],
  /** Waiting astronauts look toward the camera. */
  waitYaw: Math.PI / 4,
} as const;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Radius of the ring of waypoints astronauts use to walk around obstacles. */
export const WAYPOINT_RING = { radius: 3.0, count: 12 } as const;

// ---------------------------------------------------------------------------
// Decorations (rocks and alien plants); rocks also block walking.
// ---------------------------------------------------------------------------

export type DecorationKind = 'rock' | 'plant' | 'crystal' | 'mushroom';

export interface DecorationConfig {
  kind: DecorationKind;
  position: Vec3;
  scale: number;
  rotation: number;
  color: string;
}

export const DECORATIONS: DecorationConfig[] = [
  { kind: 'rock', position: [5.6, 0, 2.8], scale: 0.75, rotation: 0.4, color: '#d7a3b4' },
  { kind: 'rock', position: [6.1, 0, 2.0], scale: 0.42, rotation: 1.9, color: '#c795b4' },
  { kind: 'rock', position: [-5.9, 0, 2.3], scale: 0.62, rotation: 2.2, color: '#c996a8' },
  { kind: 'rock', position: [2.3, 0, -6.1], scale: 0.7, rotation: 5.1, color: '#dca7a6' },
  { kind: 'rock', position: [-4.1, 0, -4.9], scale: 0.48, rotation: 3.3, color: '#cf9cb8' },
  { kind: 'rock', position: [3.1, 0, 5.7], scale: 0.55, rotation: 0.9, color: '#d4a0ae' },
  { kind: 'plant', position: [5.0, 0, 3.7], scale: 1, rotation: 0, color: '#8ee6c4' },
  { kind: 'plant', position: [-6.2, 0, -1.7], scale: 0.85, rotation: 1, color: '#6fd6c9' },
  { kind: 'plant', position: [0.8, 0, -6.5], scale: 1.1, rotation: 2, color: '#8ee6c4' },
  { kind: 'plant', position: [-1.0, 0, 6.2], scale: 0.9, rotation: 3, color: '#a3e9b8' },
  { kind: 'plant', position: [6.2, 0, -0.5], scale: 0.8, rotation: 4, color: '#6fd6c9' },
  { kind: 'crystal', position: [-5.3, 0, 4.1], scale: 0.8, rotation: 0.3, color: '#b9a2ff' },
  { kind: 'crystal', position: [3.9, 0, -5.2], scale: 0.9, rotation: 1.2, color: '#9fd8ff' },
  { kind: 'crystal', position: [-3.1, 0, -6.3], scale: 0.7, rotation: 2.1, color: '#b9a2ff' },
  { kind: 'mushroom', position: [2.0, 0, 4.7], scale: 0.9, rotation: 0.7, color: '#ff9fc0' },
  { kind: 'mushroom', position: [-6.5, 0, 0.5], scale: 0.7, rotation: 1.4, color: '#ffb38a' },
  { kind: 'mushroom', position: [5.3, 0, -4.0], scale: 0.8, rotation: 2.6, color: '#ff9fc0' },
];

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAMERA = {
  fov: 32,
  target: [0, -1.9, 0] as Vec3,
  /** Default view direction (spherical angles around the target). */
  azimuth: Math.PI / 4,
  polar: 1.02,
  distance: 33,
  /** OrbitControls limits: small angle range, clamped zoom, no panning. */
  azimuthRange: 0.6,
  minPolar: 0.72,
  maxPolar: 1.18,
  minDistance: 17,
  maxDistance: 44,
} as const;
