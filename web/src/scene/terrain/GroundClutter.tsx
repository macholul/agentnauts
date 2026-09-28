import { useLayoutEffect, useMemo, useRef } from 'react';
import { Color, Object3D, type InstancedMesh } from 'three';
import { LANDING_PAD, STATIONS } from '../../world/config';
import { terrainHeight } from '../../world/terrain';

interface Item {
  x: number;
  z: number;
  scale: number;
  rotation: number;
  tilt: number;
  color: Color;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** True where clutter would sit under a machine, a work spot or the pad. */
function blocked(x: number, z: number): boolean {
  for (const s of Object.values(STATIONS)) {
    if (Math.hypot(x - s.position[0], z - s.position[2]) < s.footprint + 0.4) return true;
  }
  return Math.hypot(x - LANDING_PAD.position[0], z - LANDING_PAD.position[2]) < LANDING_PAD.radius + 0.3;
}

function scatter(count: number, maxRadius: number, seed: number, palette: string[], minS: number, maxS: number): Item[] {
  const rand = seeded(seed);
  const colors = palette.map((c) => new Color(c));
  const items: Item[] = [];
  while (items.length < count) {
    const angle = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * maxRadius;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    if (blocked(x, z)) continue;
    items.push({
      x,
      z,
      scale: minS + rand() * (maxS - minS),
      rotation: rand() * Math.PI * 2,
      tilt: (rand() - 0.5) * 0.5,
      color: colors[Math.floor(rand() * colors.length)]!.clone().offsetHSL(0, 0, (rand() - 0.5) * 0.06),
    });
  }
  return items;
}

function useInstances(ref: React.RefObject<InstancedMesh | null>, items: Item[], yOffset: (item: Item) => number, squash: number) {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dummy = new Object3D();
    items.forEach((item, i) => {
      dummy.position.set(item.x, terrainHeight(item.x, item.z) + yOffset(item), item.z);
      dummy.rotation.set(item.tilt, item.rotation, item.tilt * 0.5);
      dummy.scale.set(item.scale, item.scale * squash, item.scale * 0.85);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, item.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [ref, items, yOffset, squash]);
}

const pebbleOffset = (item: Item) => item.scale * 0.15;
const tuftOffset = (item: Item) => item.scale * 0.2;

/**
 * Small surface detail: rounded pebbles and little mounds of alien moss
 * scattered around the base. Two instanced meshes, so it's cheap.
 */
export function GroundClutter() {
  const pebbleItems = useMemo(
    () => scatter(280, 40, 3, ['#d9a3ad', '#e6b2a4', '#c89cb7', '#f1c3ae'], 0.06, 0.2),
    [],
  );
  const tuftItems = useMemo(() => scatter(140, 30, 9, ['#86dcc0', '#6fcfbf', '#a5e5b6'], 0.1, 0.2), []);
  const pebbles = useRef<InstancedMesh>(null);
  const tufts = useRef<InstancedMesh>(null);
  useInstances(pebbles, pebbleItems, pebbleOffset, 0.55);
  useInstances(tufts, tuftItems, tuftOffset, 0.75);

  return (
    <>
      <instancedMesh ref={pebbles} args={[undefined, undefined, pebbleItems.length]} receiveShadow castShadow>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={tufts} args={[undefined, undefined, tuftItems.length]} castShadow>
        <sphereGeometry args={[1, 12, 8]} />
        <meshStandardMaterial roughness={0.8} emissive="#3fae98" emissiveIntensity={0.12} />
      </instancedMesh>
    </>
  );
}
