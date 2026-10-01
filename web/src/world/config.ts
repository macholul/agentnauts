/**
 * World layout: the single source of truth for where things are on the
 * planet surface.
 *
 * Station positions, approach points (where astronauts stand to work),
 * the landing pad, decorations and camera limits all live here. Coordinates
 * are in world units, y-up. The base area around the origin sits near y = 0;
 * the surface keeps going well past the edges of the screen, rising into
 * hills away from the base.
 *
 * The default camera looks from +X/+Z toward the origin, so on screen
 * "right" is +X/-Z and "far" is -X/-Z.
 */
import type { StationId } from '@agentnauts/shared';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const PALETTE = {
  terrainTop: '#f5b497',
  terrainHigh: '#fcd0b3',
  terrainLow: '#e89b86',
  /** Leveled ground of the base area. */
  baseGround: '#e2a193',
  hillLow: '#ea9f8a',
  hillHigh: '#fbd2b8',
  craterFloor: '#e3a3a0',
  /** Soft lavender patches across the ground. */
  groundPatch: '#dba3b8',
  /** Far-away haze the terrain fades into (also the background color). */
  haze: '#f0c2b6',
  // Used by the baked lighting environment (reflections on visors).
  skyZenith: '#94b8ee',
  skyHorizon: '#ffd2bb',
  skyMid: '#c9b3ea',
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
// Surface
// ---------------------------------------------------------------------------

export const SURFACE = {
  /** How far the terrain mesh extends (well past anything the camera shows). */
  radius: 120,
  /** Mostly flat base area where the stations are. */
  baseRadius: 15.5,
  /** Astronauts stay inside this radius. */
  walkRadius: 12.5,
  /** Height of the rolling hills outside the base. */
  hillHeight: 5,
} as const;

/** Stations and the pad are built at this scale (bigger toys, more readable). */
export const STATION_SCALE = 1.65;

/** The landing pad is built at its own scale. */
export const PAD_SCALE = 1.3;

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
  // Every station faces the middle of the base.
  const yaw = yawToward(position, [0, 0, 0]);
  const approach = approachSlots(position, yaw, approachDistance * STATION_SCALE, 1.2);
  return {
    id,
    label,
    description,
    accent,
    position,
    yaw,
    footprint: footprint * STATION_SCALE,
    approach,
    workYaw: yaw + Math.PI,
  };
}

export const STATIONS: Record<StationId, StationConfig> = {
  fabricator: station('fabricator', 'Fabricator', 'Edit / Write files', '#ff8a3d', [-10, 0, -1.7], 1.35, 1.75),
  scanner: station('scanner', 'Scanner', 'Read / Grep / Glob', '#2ec4b6', [-1.7, 0, -10], 1.2, 1.65),
  drill: station('drill', 'Drill', 'Bash commands', '#ffc23c', [-5.6, 0, 8.3], 1.2, 1.7),
  radar: station('radar', 'Radar Dish', 'Web and outside tools (MCP)', '#ff6f9f', [8.3, 0, -5.6], 1.25, 1.75),
};

// ---------------------------------------------------------------------------
// Landing pad
// ---------------------------------------------------------------------------

const PAD_POSITION: Vec3 = [1.5, 0, 1.5];
const PAD_RADIUS = 1.55 * PAD_SCALE;

export const LANDING_PAD = {
  position: PAD_POSITION,
  radius: PAD_RADIUS,
  /** Height of the pad deck above the ground. */
  deckHeight: 0.2 * PAD_SCALE,
  /** Where waiting astronauts stand (on the pad, facing the camera). */
  slots: [
    [PAD_POSITION[0], 0, PAD_POSITION[2]],
    [PAD_POSITION[0] - 1.0, 0, PAD_POSITION[2] + 0.45],
    [PAD_POSITION[0] + 0.45, 0, PAD_POSITION[2] - 1.0],
    [PAD_POSITION[0] + 0.75, 0, PAD_POSITION[2] + 0.8],
    [PAD_POSITION[0] - 0.8, 0, PAD_POSITION[2] - 0.75],
  ] as Vec3[],
  /** Waiting astronauts look toward the camera. */
  waitYaw: Math.PI / 4,
} as const;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Radius of the ring of waypoints astronauts use to walk around obstacles. */
export const WAYPOINT_RING = { radius: 5.2, count: 16 } as const;

// ---------------------------------------------------------------------------
// Decorations: small props around the base (rocks and crystals block
// walking) plus big scenery out in the hills.
// ---------------------------------------------------------------------------

export type DecorationKind = 'rock' | 'plant' | 'crystal' | 'mushroom';

export interface DecorationConfig {
  kind: DecorationKind;
  position: Vec3;
  scale: number;
  rotation: number;
  color: string;
  /** Per-prop seed: picks the variant and shapes it, so no two look alike. */
  seed: number;
}

/** Small deterministic PRNG so the scattered props are the same every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DECORATION_COLORS: Record<DecorationKind, string[]> = {
  rock: ['#d7a3b4', '#c795b4', '#c996a8', '#dca7a6', '#cf9cb8', '#e0b0a4', '#b99ac2'],
  plant: ['#8ee6c4', '#6fd6c9', '#a3e9b8', '#ffb3c8', '#c6a8ff'],
  crystal: ['#b9a2ff', '#9fd8ff', '#c7b0ff'],
  mushroom: ['#ff9fc0', '#ffb38a', '#b9a2ff', '#7fd8c8'],
};

/** Keep props off the stations, their work spots, the pad and the paths into the middle. */
function keepsClear(x: number, z: number, margin: number): boolean {
  for (const s of Object.values(STATIONS)) {
    if (Math.hypot(x - s.position[0], z - s.position[2]) < s.footprint + margin + 1.2) return false;
    for (const a of s.approach) if (Math.hypot(x - a[0], z - a[2]) < margin + 1.0) return false;
  }
  if (Math.hypot(x - PAD_POSITION[0], z - PAD_POSITION[2]) < PAD_RADIUS + margin + 1.5) return false;
  // Keep the walking lanes between the pad and each station open.
  for (const s of Object.values(STATIONS)) {
    const [ax, , az] = PAD_POSITION;
    const [bx, , bz] = s.approach[0]!;
    const abx = bx - ax;
    const abz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz)));
    if (Math.hypot(x - (ax + abx * t), z - (az + abz * t)) < margin + 1.6) return false;
  }
  return true;
}

function scatter(): DecorationConfig[] {
  const rand = mulberry32(7);
  const out: DecorationConfig[] = [];
  const place = (kind: DecorationKind, count: number, minR: number, maxR: number, minS: number, maxS: number) => {
    let placed = 0;
    for (let attempt = 0; attempt < count * 30 && placed < count; attempt++) {
      const angle = rand() * Math.PI * 2;
      const r = minR + Math.sqrt(rand()) * (maxR - minR);
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      const scale = minS + rand() * (maxS - minS);
      if (!keepsClear(x, z, scale)) continue;
      if (out.some((d) => Math.hypot(d.position[0] - x, d.position[2] - z) < (d.scale + scale) * 1.1 + 0.6)) continue;
      const colors = DECORATION_COLORS[kind];
      out.push({
        kind,
        position: [x, 0, z],
        scale,
        rotation: rand() * Math.PI * 2,
        color: colors[Math.floor(rand() * colors.length)]!,
        seed: Math.floor(rand() * 1e6),
      });
      placed++;
    }
  };
  // Around the base, where astronauts walk.
  // Around the base, where astronauts walk: just a few, so paths stay open.
  place('rock', 4, 5, 12.5, 0.45, 0.8);
  place('plant', 6, 4, 13, 0.8, 1.15);
  place('crystal', 3, 6, 12.5, 0.7, 0.95);
  place('mushroom', 4, 4, 12.5, 0.7, 1.0);
  // Scenery out in the hills (outside the walkable area).
  place('rock', 18, 15, 55, 1.2, 3.6);
  place('crystal', 9, 16, 50, 1.3, 2.6);
  place('plant', 14, 15, 45, 1.3, 2.4);
  place('mushroom', 7, 15.5, 40, 1.1, 2.2);
  return out;
}

export const DECORATIONS: DecorationConfig[] = scatter();

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export const CAMERA = {
  fov: 32,
  target: [0, 0, 0] as Vec3,
  /** Default view direction (spherical angles around the target). */
  azimuth: Math.PI / 4,
  /** Angle from straight down: high enough that the horizon never shows. */
  polar: 0.9,
  distance: 44,
  /** OrbitControls limits: modest angle range, clamped zoom, no panning. */
  azimuthRange: 0.9,
  minPolar: 0.45,
  maxPolar: 1.0,
  minDistance: 20,
  maxDistance: 62,
} as const;
