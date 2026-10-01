import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, IcosahedronGeometry, Vector3, type BufferGeometry, type Group } from 'three';
import { DECORATIONS, type DecorationConfig } from '../../world/config';
import { terrainHeight } from '../../world/terrain';
import { worldSeconds } from '../../world/sync';

/** Deterministic random stream for one prop. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, min: number, max: number) => min + r() * (max - min);

/** Slightly lighter/darker version of a color. */
function shade(color: string, amount: number): string {
  return `#${new Color(color).offsetHSL(0, 0, amount).getHexString()}`;
}

// ---------------------------------------------------------------------------
// Rocks: every rock is a uniquely lumpy, softly faceted blob.
// ---------------------------------------------------------------------------

/** An icosphere pushed in and out by smooth seeded noise, so each rock is its own shape. */
function lumpyGeometry(seed: number, amount: number): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 2);
  const r = rng(seed);
  // A few random "bulge" directions define the shape.
  const bulges = Array.from({ length: 5 }, () => ({
    dir: new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(),
    strength: between(r, -0.6, 1),
  }));
  const pos = geometry.attributes.position!;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let k = 1;
    for (const b of bulges) k += Math.max(0, v.dot(b.dir)) ** 2 * b.strength * amount;
    // Flatten the bottom so it sits on the ground.
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.3;
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function RockPiece({
  seed,
  color,
  position,
  scale,
}: {
  seed: number;
  color: string;
  position: [number, number, number];
  scale: [number, number, number];
}) {
  const geometry = useMemo(() => lumpyGeometry(seed, 0.35), [seed]);
  return (
    <mesh geometry={geometry} position={position} scale={scale} castShadow receiveShadow>
      <meshStandardMaterial color={color} roughness={1} flatShading />
    </mesh>
  );
}

function Rock({ config }: { config: DecorationConfig }) {
  const s = config.scale;
  const r = rng(config.seed);
  const variant = config.seed % 4;
  if (variant === 0) {
    // Round boulder.
    return <RockPiece seed={config.seed} color={config.color} position={[0, s * 0.45, 0]} scale={[s * 1.05, s * 0.8, s]} />;
  }
  if (variant === 1) {
    // Low, wide slab.
    return <RockPiece seed={config.seed} color={config.color} position={[0, s * 0.22, 0]} scale={[s * 1.3, s * 0.42, s * 1.05]} />;
  }
  if (variant === 2) {
    // Tall standing stone, leaning a little.
    return (
      <group rotation-z={between(r, -0.15, 0.15)}>
        <RockPiece seed={config.seed} color={config.color} position={[0, s * 0.7, 0]} scale={[s * 0.62, s * 1.1, s * 0.6]} />
      </group>
    );
  }
  // Cluster: one big rock with a couple of pebbly friends.
  return (
    <group>
      <RockPiece seed={config.seed} color={config.color} position={[0, s * 0.4, 0]} scale={[s * 0.85, s * 0.7, s * 0.8]} />
      <RockPiece
        seed={config.seed + 1}
        color={shade(config.color, -0.05)}
        position={[s * 0.85, s * 0.2, s * 0.25]}
        scale={[s * 0.4, s * 0.32, s * 0.38]}
      />
      <RockPiece
        seed={config.seed + 2}
        color={shade(config.color, 0.04)}
        position={[-s * 0.55, s * 0.14, s * 0.6]}
        scale={[s * 0.28, s * 0.22, s * 0.3]}
      />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Plants: four species, each shaped by its seed and swaying gently.
// ---------------------------------------------------------------------------

const STEM = '#5fbfa6';

function Glow({ color, radius, position }: { color: string; radius: number; position: [number, number, number] }) {
  return (
    <mesh position={position} castShadow>
      <sphereGeometry args={[radius, 16, 12]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} roughness={0.5} />
    </mesh>
  );
}

/** Bulb plant: a few curved stems with glowing bulbs. */
function BulbPlant({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const stems = Array.from({ length: 2 + Math.floor(r() * 3) }, (_, i) => ({
    x: i === 0 ? 0 : between(r, -0.2, 0.2),
    z: i === 0 ? 0 : between(r, -0.2, 0.2),
    h: i === 0 ? between(r, 0.6, 0.9) : between(r, 0.3, 0.55),
    tilt: i === 0 ? 0 : between(r, -0.5, 0.5),
    bulb: i === 0 ? 0.17 : between(r, 0.09, 0.13),
  }));
  return (
    <group>
      {stems.map((st, i) => (
        <group key={i} position={[st.x, 0, st.z]} rotation-z={st.tilt}>
          <mesh position-y={st.h / 2} castShadow>
            <capsuleGeometry args={[0.045, st.h, 4, 8]} />
            <meshStandardMaterial color={STEM} roughness={0.8} />
          </mesh>
          <Glow color={config.color} radius={st.bulb} position={[0, st.h + 0.07, 0]} />
        </group>
      ))}
      <mesh position-y={0.05} scale={[0.32, 0.11, 0.32]} receiveShadow>
        <sphereGeometry args={[1, 16, 10]} />
        <meshStandardMaterial color="#6fcfae" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Fan plant: soft rounded leaves opening out from the ground. */
function FanPlant({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const count = 5 + Math.floor(r() * 3);
  const leafColor = shade(config.color, -0.08);
  return (
    <group>
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + between(r, -0.2, 0.2);
        const len = between(r, 0.35, 0.55);
        return (
          <group key={i} rotation-y={angle}>
            <group rotation-x={between(r, 0.45, 0.8)}>
              <mesh position-y={len / 2} scale={[0.12, len / 2, 0.05]} castShadow>
                <sphereGeometry args={[1, 12, 8]} />
                <meshStandardMaterial color={i % 2 ? config.color : leafColor} roughness={0.6} />
              </mesh>
            </group>
          </group>
        );
      })}
      <Glow color="#fff1b8" radius={0.07} position={[0, 0.12, 0]} />
    </group>
  );
}

/** Stalk plant: one tall wobbly stem with stacked bobbles. */
function StalkPlant({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const h = between(r, 0.9, 1.3);
  const bobbles = 2 + Math.floor(r() * 2);
  return (
    <group rotation-z={between(r, -0.12, 0.12)}>
      <mesh position-y={h / 2} castShadow>
        <capsuleGeometry args={[0.05, h, 4, 8]} />
        <meshStandardMaterial color={STEM} roughness={0.8} />
      </mesh>
      {Array.from({ length: bobbles }, (_, i) => (
        <mesh key={i} position-y={h * (0.45 + i * 0.22)} scale={[1, 0.6, 1]} castShadow>
          <sphereGeometry args={[0.12 - i * 0.02, 14, 10]} />
          <meshStandardMaterial color={shade(config.color, -0.05)} roughness={0.6} />
        </mesh>
      ))}
      <Glow color={config.color} radius={0.1} position={[0, h + 0.1, 0]} />
    </group>
  );
}

/** Pod bush: a clump of plump round pods. */
function PodPlant({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const pods = Array.from({ length: 3 + Math.floor(r() * 3) }, () => ({
    x: between(r, -0.22, 0.22),
    z: between(r, -0.22, 0.22),
    s: between(r, 0.12, 0.22),
  }));
  return (
    <group>
      {pods.map((p, i) => (
        <mesh key={i} position={[p.x, p.s * 0.9, p.z]} scale={[1, 1.15, 1]} castShadow receiveShadow>
          <sphereGeometry args={[p.s, 16, 12]} />
          <meshStandardMaterial color={i % 2 ? config.color : shade(config.color, 0.06)} roughness={0.55} />
        </mesh>
      ))}
      <Glow color="#fff1b8" radius={0.05} position={[pods[0]!.x, pods[0]!.s * 2.1, pods[0]!.z]} />
    </group>
  );
}

const PLANTS = [BulbPlant, FanPlant, StalkPlant, PodPlant];

function Plant({ config }: { config: DecorationConfig }) {
  const sway = useRef<Group>(null);
  const phase = config.seed % 100;
  useFrame(() => {
    if (!sway.current) return;
    const t = worldSeconds() + phase;
    sway.current.rotation.z = Math.sin(t * 1.1) * 0.07;
    sway.current.rotation.x = Math.cos(t * 0.9) * 0.05;
  });
  const Species = PLANTS[config.seed % PLANTS.length]!;
  return (
    <group ref={sway} scale={config.scale}>
      <Species config={config} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Crystals and mushrooms
// ---------------------------------------------------------------------------

/** Cluster of rounded, softly glowing crystal nubs; size and count vary. */
function Crystal({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const count = 2 + Math.floor(r() * 4);
  const pieces = Array.from({ length: count }, (_, i) => ({
    x: i === 0 ? 0 : between(r, -0.25, 0.25),
    z: i === 0 ? 0 : between(r, -0.25, 0.25),
    len: i === 0 ? between(r, 0.45, 0.8) : between(r, 0.18, 0.4),
    rad: i === 0 ? between(r, 0.1, 0.14) : between(r, 0.06, 0.1),
    tx: between(r, -0.5, 0.5),
    tz: between(r, -0.5, 0.5),
  }));
  return (
    <group scale={config.scale}>
      {pieces.map((p, i) => (
        <mesh key={i} position={[p.x, p.len / 2, p.z]} rotation={[i === 0 ? p.tx * 0.3 : p.tx, 0, i === 0 ? p.tz * 0.3 : p.tz]} castShadow>
          <capsuleGeometry args={[p.rad, p.len, 4, 6]} />
          <meshStandardMaterial
            color={i % 2 ? shade(config.color, 0.05) : config.color}
            emissive={config.color}
            emissiveIntensity={0.4}
            roughness={0.25}
            metalness={0.05}
          />
        </mesh>
      ))}
    </group>
  );
}

function MushroomCap({ color, height, radius, flat }: { color: string; height: number; radius: number; flat: boolean }) {
  return (
    <group>
      <mesh position-y={height / 2} castShadow>
        <capsuleGeometry args={[radius * 0.28, height, 4, 10]} />
        <meshStandardMaterial color="#fff1e4" roughness={0.9} />
      </mesh>
      <mesh position-y={height + radius * 0.2} scale={[1, flat ? 0.4 : 0.65, 1]} castShadow>
        <sphereGeometry args={[radius, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      {[0, 2.1, 4.2].map((a) => (
        <mesh
          key={a}
          position={[Math.cos(a) * radius * 0.45, height + radius * (flat ? 0.5 : 0.72), Math.sin(a) * radius * 0.45]}
          scale={[1, 0.5, 1]}
        >
          <sphereGeometry args={[radius * 0.14, 8, 6]} />
          <meshStandardMaterial color="#fffaf5" roughness={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** Single mushroom, a family of three, or a wide flat-cap. */
function Mushroom({ config }: { config: DecorationConfig }) {
  const r = rng(config.seed);
  const variant = config.seed % 3;
  if (variant === 1) {
    return (
      <group scale={config.scale}>
        <MushroomCap color={config.color} height={0.35} radius={0.26} flat={false} />
        <group position={[0.28, 0, 0.12]}>
          <MushroomCap color={shade(config.color, 0.06)} height={0.2} radius={0.16} flat={false} />
        </group>
        <group position={[-0.1, 0, 0.3]}>
          <MushroomCap color={shade(config.color, -0.05)} height={0.12} radius={0.1} flat={false} />
        </group>
      </group>
    );
  }
  return (
    <group scale={config.scale}>
      <MushroomCap
        color={config.color}
        height={variant === 2 ? between(r, 0.18, 0.25) : between(r, 0.3, 0.45)}
        radius={variant === 2 ? between(r, 0.34, 0.42) : between(r, 0.24, 0.3)}
        flat={variant === 2}
      />
    </group>
  );
}

export function Decorations() {
  return (
    <group>
      {DECORATIONS.map((config, i) => {
        const [x, , z] = config.position;
        const y = terrainHeight(x, z);
        return (
          <group key={i} position={[x, y - 0.02, z]} rotation-y={config.rotation}>
            {config.kind === 'rock' && <Rock config={config} />}
            {config.kind === 'plant' && <Plant config={config} />}
            {config.kind === 'crystal' && <Crystal config={config} />}
            {config.kind === 'mushroom' && <Mushroom config={config} />}
          </group>
        );
      })}
    </group>
  );
}
