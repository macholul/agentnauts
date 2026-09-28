/**
 * Tiny navigation: circular obstacles plus a ring of waypoints around the
 * middle of the chunk. Paths go straight when nothing is in the way and
 * otherwise hop along the ring (shortest path over a visibility graph).
 */
import { DECORATIONS, LANDING_PAD, STATIONS, WAYPOINT_RING, type Vec3 } from './config';
import { groundHeight, isWalkable } from './terrain';

export interface Obstacle {
  x: number;
  z: number;
  radius: number;
}

/** Roughly how wide an astronaut is, for clearance. */
export const AGENT_RADIUS = 0.3;

export const OBSTACLES: Obstacle[] = [
  ...Object.values(STATIONS).map((s) => ({ x: s.position[0], z: s.position[2], radius: s.footprint })),
  ...DECORATIONS.filter((d) => d.kind === 'rock' || d.kind === 'crystal').map((d) => ({
    x: d.position[0],
    z: d.position[2],
    radius: d.kind === 'rock' ? d.scale * 1.05 : d.scale * 0.35,
  })),
];

const RING_NODES: [number, number][] = Array.from({ length: WAYPOINT_RING.count }, (_, i) => {
  const angle = (i / WAYPOINT_RING.count) * Math.PI * 2;
  return [Math.cos(angle) * WAYPOINT_RING.radius, Math.sin(angle) * WAYPOINT_RING.radius];
});

/** Distance from point p to segment ab (XZ plane). */
function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len2));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

/** True if walking straight from a to b doesn't clip any obstacle. */
export function segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
  for (const o of OBSTACLES) {
    // Ignore obstacles we're starting or ending inside of (so we can walk out).
    const r = o.radius + AGENT_RADIUS;
    if (Math.hypot(ax - o.x, az - o.z) < r || Math.hypot(bx - o.x, bz - o.z) < r) continue;
    if (pointSegmentDistance(o.x, o.z, ax, az, bx, bz) < r) return false;
  }
  return true;
}

/** True if a point is clear of obstacles and on walkable ground. */
export function pointClear(x: number, z: number, margin = 0): boolean {
  if (!isWalkable(x, z)) return false;
  for (const o of OBSTACLES) {
    if (Math.hypot(x - o.x, z - o.z) < o.radius + AGENT_RADIUS + margin) return false;
  }
  return true;
}

/**
 * Waypoints from `from` to `to` (excluding `from`, ending at `to`).
 * Dijkstra over {from, to, ring nodes} with straight-line visibility edges.
 */
export function planPath(from: Vec3, to: Vec3): Vec3[] {
  const [fx, , fz] = from;
  const [tx, , tz] = to;
  if (segmentClear(fx, fz, tx, tz)) return [to];

  const nodes: [number, number][] = [[fx, fz], [tx, tz], ...RING_NODES];
  const n = nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;

  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = dist[i] ?? Infinity;
      if (!done[i] && d < best) {
        best = d;
        u = i;
      }
    }
    if (u === -1 || u === 1) break;
    done[u] = true;
    const [ux, uz] = nodes[u]!;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const [vx, vz] = nodes[v]!;
      if (!segmentClear(ux, uz, vx, vz)) continue;
      const alt = best + Math.hypot(vx - ux, vz - uz);
      if (alt < (dist[v] ?? Infinity)) {
        dist[v] = alt;
        prev[v] = u;
      }
    }
  }

  // No route found (e.g. boxed in): just walk straight.
  if (prev[1] === -1) return [to];

  const path: Vec3[] = [];
  for (let v = prev[1]!; v > 0; v = prev[v]!) {
    const [x, z] = nodes[v]!;
    path.unshift([x, groundHeight(x, z), z]);
  }
  path.push(to);
  return path;
}

/**
 * A random wander target: on walkable ground, clear of obstacles, not on
 * top of the landing pad, and a pleasant stroll (not a marathon) away.
 */
export function randomWanderPoint(from: Vec3, random: () => number = Math.random): Vec3 {
  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = 1.5 + random() * 3.5;
    const x = from[0] + Math.cos(angle) * distance;
    const z = from[2] + Math.sin(angle) * distance;
    if (!pointClear(x, z, 0.25)) continue;
    if (Math.hypot(x - LANDING_PAD.position[0], z - LANDING_PAD.position[2]) < LANDING_PAD.radius + 0.3) continue;
    return [x, groundHeight(x, z), z];
  }
  // Fall back to somewhere near the middle.
  const x = (random() - 0.5) * 3;
  const z = (random() - 0.5) * 3;
  return [x, groundHeight(x, z), z];
}

/** A clear spot within `radius` of `center`, used for landing crew near the pad. */
export function randomPointNear(center: Vec3, minRadius: number, maxRadius: number, random: () => number = Math.random): Vec3 {
  for (let attempt = 0; attempt < 30; attempt++) {
    const angle = random() * Math.PI * 2;
    const r = minRadius + random() * (maxRadius - minRadius);
    const x = center[0] + Math.cos(angle) * r;
    const z = center[2] + Math.sin(angle) * r;
    if (pointClear(x, z)) return [x, groundHeight(x, z), z];
  }
  return [center[0], groundHeight(center[0], center[2]), center[2]];
}
