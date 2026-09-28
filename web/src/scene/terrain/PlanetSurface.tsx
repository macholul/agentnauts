import { useMemo } from 'react';
import { BufferGeometry, Color, Float32BufferAttribute } from 'three';
import { PALETTE, SURFACE } from '../../world/config';
import { craterAmount, hillAmount, smoothstep, terrainHeight } from '../../world/terrain';
import { groundTexture } from '../textures';

/** World units covered by one repeat of the ground texture. */
const TEXTURE_TILE = 7;

const CELLS = 170; // grid cells per side
/**
 * Grid coordinate (-1..1) to world coordinate. Cubic so cells are small
 * (~0.5 units) around the base and grow to a few units far away.
 */
function warp(u: number): number {
  return SURFACE.radius * (0.3 * u + 0.7 * u * u * u);
}

function hash(i: number, j: number, salt: number): number {
  const h = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Large, soft patches of color variation across the ground. */
function patch(x: number, z: number): number {
  return Math.sin(x * 0.13 + Math.sin(z * 0.09) * 2) * Math.cos(z * 0.11 - Math.sin(x * 0.07) * 1.5);
}

/**
 * A big patch of planet surface: faceted low-poly triangles (jittered so
 * they don't read as a grid), softly colored, rising into hills around the
 * base. It extends far past the camera's view so it never has an edge.
 */
function buildSurface(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const top = new Color(PALETTE.terrainTop);
  const base = new Color(PALETTE.baseGround);
  const high = new Color(PALETTE.terrainHigh);
  const low = new Color(PALETTE.terrainLow);
  const hillLow = new Color(PALETTE.hillLow);
  const hillHigh = new Color(PALETTE.hillHigh);
  const crater = new Color(PALETTE.craterFloor);
  const lavender = new Color(PALETTE.groundPatch);
  const hillColor = new Color();
  const c = new Color();

  const step = 2 / CELLS;
  for (let i = 0; i <= CELLS; i++) {
    for (let j = 0; j <= CELLS; j++) {
      const u = -1 + i * step;
      const v = -1 + j * step;
      // Jitter within the local cell size (edges stay put).
      const edge = i === 0 || j === 0 || i === CELLS || j === CELLS;
      const ju = edge ? 0 : (hash(i, j, 1) - 0.5) * step * 0.7;
      const jv = edge ? 0 : (hash(i, j, 2) - 0.5) * step * 0.7;
      const x = warp(u + ju);
      const z = warp(v + jv);
      const y = terrainHeight(x, z);
      positions.push(x, y, z);
      uvs.push(x / TEXTURE_TILE, z / TEXTURE_TILE);

      const r = Math.hypot(x, z);
      const hills = hillAmount(x, z);
      // Leveled base ground in the middle, natural ground around it.
      c.copy(base).lerp(top, smoothstep(9, 14, r));
      c.lerp(lavender, Math.max(0, patch(x, z)) * 0.35);
      c.lerp(high, Math.max(0, -patch(x + 40, z - 20)) * 0.4);
      const bump = y - hills * SURFACE.hillHeight;
      if (bump > 0) c.lerp(high, Math.min(1, bump / 0.5) * 0.5);
      else c.lerp(low, Math.min(1, -bump / 0.5) * 0.5);
      c.lerp(crater, craterAmount(x, z) * 0.6);
      if (hills > 0) {
        hillColor.copy(hillLow).lerp(hillHigh, smoothstep(0, SURFACE.hillHeight * 1.5, y));
        c.lerp(hillColor, hills * 0.85);
      }
      // Per-vertex tint wobble gives each facet its own painted shade.
      const n = (hash(i, j, 3) - 0.5) * 0.09;
      colors.push(c.r + n, c.g + n * 0.85, c.b + n * 0.7);
    }
  }

  const row = CELLS + 1;
  for (let i = 0; i < CELLS; i++) {
    for (let j = 0; j < CELLS; j++) {
      const a = i * row + j;
      const b = a + row;
      // Randomly flip the diagonal so the facets look organic.
      if (hash(i, j, 4) < 0.5) {
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      } else {
        indices.push(a, b + 1, b, a, a + 1, b + 1);
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function PlanetSurface() {
  const geometry = useMemo(buildSurface, []);
  const map = useMemo(groundTexture, []);
  return (
    <mesh geometry={geometry} receiveShadow castShadow>
      <meshStandardMaterial map={map} vertexColors flatShading roughness={0.95} metalness={0} />
    </mesh>
  );
}
