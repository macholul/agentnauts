import { useMemo } from 'react';
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { CHUNK, PALETTE } from '../../world/config';
import { RIM_DROP, craterAmount, outlineRadius, smoothstep, terrainHeight } from '../../world/terrain';

const SEGMENTS = 128; // around the outline
const RINGS = 44; // from center to rim

/** Soft rolling top surface of the chunk, colored with gentle vertex tints. */
function buildTopGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const base = new Color(PALETTE.terrainTop);
  const high = new Color(PALETTE.terrainHigh);
  const low = new Color(PALETTE.terrainLow);
  const rim = new Color(PALETTE.strata[0]);
  const crater = new Color(PALETTE.craterFloor);
  const c = new Color();

  const pushVertex = (x: number, z: number, t: number) => {
    const y = terrainHeight(x, z);
    positions.push(x, y, z);
    c.copy(base);
    const h = y + smoothstep(0.82, 1, t) * RIM_DROP; // ignore the rim roll-off
    if (h > 0) c.lerp(high, Math.min(1, h / 0.3));
    else c.lerp(low, Math.min(1, -h / 0.3));
    c.lerp(crater, craterAmount(x, z) * 0.6);
    c.lerp(rim, smoothstep(0.84, 1, t) * 0.7);
    // Tiny deterministic variation so the surface reads as painted, not plastic.
    const n = Math.sin(x * 3.1 + z * 1.7) * Math.cos(z * 2.3 - x * 0.9) * 0.025;
    colors.push(c.r + n, c.g + n, c.b + n);
  };

  pushVertex(0, 0, 0);
  for (let i = 1; i <= RINGS; i++) {
    const t = i / RINGS;
    for (let j = 0; j < SEGMENTS; j++) {
      const theta = (j / SEGMENTS) * Math.PI * 2;
      const r = t * outlineRadius(theta);
      pushVertex(Math.cos(theta) * r, Math.sin(theta) * r, t);
    }
  }

  const ringStart = (i: number) => 1 + (i - 1) * SEGMENTS;
  for (let j = 0; j < SEGMENTS; j++) {
    const jn = (j + 1) % SEGMENTS;
    indices.push(0, ringStart(1) + jn, ringStart(1) + j);
  }
  for (let i = 1; i < RINGS; i++) {
    const a = ringStart(i);
    const b = ringStart(i + 1);
    for (let j = 0; j < SEGMENTS; j++) {
      const jn = (j + 1) % SEGMENTS;
      indices.push(a + j, a + jn, b + j);
      indices.push(a + jn, b + jn, b + j);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

interface Stratum {
  thickness: number;
  /** Radius at the bottom of the layer, relative to the outline. */
  bottomScale: number;
  /** How much the middle of the layer pillows outward. */
  bulge: number;
  color: string;
}

const STRATA: Stratum[] = [
  { thickness: 0.6, bottomScale: 0.985, bulge: 0.05, color: PALETTE.strata[0] },
  { thickness: 0.8, bottomScale: 0.955, bulge: 0.065, color: PALETTE.strata[1] },
  { thickness: 0.55, bottomScale: 0.92, bulge: 0.05, color: PALETTE.strata[2] },
  { thickness: 0.85, bottomScale: 0.865, bulge: 0.065, color: PALETTE.strata[3] },
  { thickness: 0.7, bottomScale: 0.8, bulge: 0.055, color: PALETTE.strata[4] },
  { thickness: 0.7, bottomScale: 0.71, bulge: 0.055, color: PALETTE.strata[5] },
];

const STRATA_BOTTOM_Y = -RIM_DROP - STRATA.reduce((sum, layer) => sum + layer.thickness, 0);
const UNDERSIDE_BOTTOM_Y = CHUNK.bottomY + 0.35;
const LAST_SCALE = STRATA[STRATA.length - 1]?.bottomScale ?? 0.7;

/** Radius scale of the underside at s (0 = just below the strata, 1 = tip). */
function undersideScale(s: number): number {
  // Rounded (bowl-like) taper rather than a straight cone.
  const k = 1 - Math.cos((s * Math.PI) / 2) ** 1.6;
  return LAST_SCALE + (0.06 - LAST_SCALE) * k;
}

/**
 * Layered rock/soil bands around the sides plus the tapering underside.
 * Bands don't share vertices, so each one gets its own soft crease.
 */
function buildSideGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new Color();
  const ROWS = 5;

  // Per-layer wobble so the bands aren't perfectly parallel.
  const wobble = (theta: number, layer: number) =>
    1 + 0.022 * Math.sin(theta * 6 + layer * 1.7) + 0.014 * Math.sin(theta * 11 + layer * 0.6);

  let topY = -RIM_DROP;
  let topScale = 1;

  const addBand = (
    bandTopY: number,
    bandBottomY: number,
    scaleTop: (theta: number) => number,
    scaleBottom: (theta: number) => number,
    bulge: number,
    colorAt: (s: number) => Color,
    profile: (s: number) => number = (s) => s,
  ) => {
    const start = positions.length / 3;
    for (let row = 0; row <= ROWS; row++) {
      const s = row / ROWS;
      const y = bandTopY + (bandBottomY - bandTopY) * s;
      const col = colorAt(s);
      for (let j = 0; j < SEGMENTS; j++) {
        const theta = (j / SEGMENTS) * Math.PI * 2;
        const R = outlineRadius(theta);
        const k = profile(s);
        const scale = scaleTop(theta) + (scaleBottom(theta) - scaleTop(theta)) * k;
        const r = R * scale * (1 + bulge * Math.sin(Math.PI * s));
        positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
        colors.push(col.r, col.g, col.b);
      }
    }
    for (let row = 0; row < ROWS; row++) {
      const a = start + row * SEGMENTS;
      const b = a + SEGMENTS;
      for (let j = 0; j < SEGMENTS; j++) {
        const jn = (j + 1) % SEGMENTS;
        indices.push(a + j, a + jn, b + j);
        indices.push(a + jn, b + jn, b + j);
      }
    }
  };

  STRATA.forEach((layer, index) => {
    const bottomY = topY - layer.thickness;
    const prevScale = topScale;
    const color = new Color(layer.color);
    addBand(
      topY,
      bottomY,
      (theta) => (index === 0 ? 1 : prevScale * wobble(theta, index - 1)),
      (theta) => layer.bottomScale * wobble(theta, index),
      layer.bulge,
      () => color,
    );
    topY = bottomY;
    topScale = layer.bottomScale;
  });

  // Tapering underside: from the last stratum down to a soft rounded point.
  const lastIndex = STRATA.length - 1;
  const undersideTop = new Color(PALETTE.strata[5]);
  const undersideBottom = new Color(PALETTE.underside);
  const undersideStart = positions.length / 3;
  addBand(
    topY,
    UNDERSIDE_BOTTOM_Y,
    (theta) => LAST_SCALE * wobble(theta, lastIndex),
    (theta) => 0.06 * wobble(theta, lastIndex + 3),
    0,
    (s) => c.copy(undersideTop).lerp(undersideBottom, Math.min(1, s * 1.4)),
    (s) => (LAST_SCALE - undersideScale(s)) / (LAST_SCALE - 0.06),
  );
  // Close the bottom with a tip vertex.
  const tip = positions.length / 3;
  positions.push(0, CHUNK.bottomY, 0);
  colors.push(undersideBottom.r, undersideBottom.g, undersideBottom.b);
  const lastRow = undersideStart + ROWS * SEGMENTS;
  for (let j = 0; j < SEGMENTS; j++) {
    const jn = (j + 1) % SEGMENTS;
    indices.push(lastRow + j, lastRow + jn, tip);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Rocky lumps hanging off the underside, for a floating-island silhouette. */
const HANGING_ROCKS = [
  { theta: 0.65, s: 0.28, size: 1.0, color: PALETTE.strata[4] },
  { theta: 2.8, s: 0.36, size: 0.9, color: PALETTE.strata[5] },
  { theta: 4.3, s: 0.42, size: 1.05, color: PALETTE.strata[4] },
  { theta: 5.6, s: 0.3, size: 0.75, color: PALETTE.strata[5] },
  { theta: 1.6, s: 0.62, size: 0.7, color: PALETTE.underside },
].map((rock) => {
  const y = STRATA_BOTTOM_Y + (UNDERSIDE_BOTTOM_Y - STRATA_BOTTOM_Y) * rock.s;
  const r = outlineRadius(rock.theta) * undersideScale(rock.s) - rock.size * 0.45;
  return {
    position: [Math.cos(rock.theta) * r, y - rock.size * 0.3, Math.sin(rock.theta) * r] as [number, number, number],
    scale: [rock.size, rock.size * 1.35, rock.size] as [number, number, number],
    color: rock.color,
  };
});

export function TerrainChunk() {
  const top = useMemo(buildTopGeometry, []);
  const sides = useMemo(buildSideGeometry, []);

  return (
    <group>
      <mesh geometry={top} receiveShadow castShadow>
        <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
      </mesh>
      <mesh geometry={sides} receiveShadow castShadow>
        <meshStandardMaterial vertexColors roughness={1} metalness={0} />
      </mesh>
      {HANGING_ROCKS.map((rock, i) => (
        <mesh key={i} position={rock.position} scale={rock.scale} castShadow receiveShadow>
          <icosahedronGeometry args={[1, 2]} />
          <meshStandardMaterial color={rock.color} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}
