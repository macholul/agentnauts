import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import { DECORATIONS, type DecorationConfig } from '../../world/config';
import { terrainHeight } from '../../world/terrain';

function Rock({ config }: { config: DecorationConfig }) {
  return (
    <mesh scale={[config.scale * 1.1, config.scale * 0.82, config.scale]} position-y={config.scale * 0.42} castShadow receiveShadow>
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial color={config.color} roughness={1} flatShading />
    </mesh>
  );
}

/** Bulb-topped alien plant that sways a little. */
function Plant({ config, index }: { config: DecorationConfig; index: number }) {
  const sway = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (sway.current) {
      const t = clock.elapsedTime + index * 1.3;
      sway.current.rotation.z = Math.sin(t * 1.1) * 0.08;
      sway.current.rotation.x = Math.cos(t * 0.9) * 0.06;
    }
  });
  const stems: [number, number, number, number][] = [
    // x, z, height, tilt
    [0, 0, 0.75, 0],
    [0.18, 0.1, 0.5, 0.35],
    [-0.16, 0.08, 0.42, -0.4],
  ];
  return (
    <group ref={sway} scale={config.scale}>
      {stems.map(([x, z, h, tilt], i) => (
        <group key={i} position={[x, 0, z]} rotation-z={tilt}>
          <mesh position-y={h / 2} castShadow>
            <capsuleGeometry args={[0.045, h, 4, 8]} />
            <meshStandardMaterial color="#5fbfa6" roughness={0.8} />
          </mesh>
          <mesh position-y={h + 0.08} castShadow>
            <sphereGeometry args={[i === 0 ? 0.17 : 0.12, 16, 12]} />
            <meshStandardMaterial color={config.color} emissive={config.color} emissiveIntensity={0.35} roughness={0.5} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 0.06, 0]} scale={[0.35, 0.12, 0.35]} receiveShadow>
        <sphereGeometry args={[1, 16, 10]} />
        <meshStandardMaterial color="#6fcfae" roughness={0.9} />
      </mesh>
    </group>
  );
}

/** Cluster of rounded, softly glowing crystal nubs. */
function Crystal({ config }: { config: DecorationConfig }) {
  const pieces: [number, number, number, number, number][] = [
    // x, z, length, tiltX, tiltZ
    [0, 0, 0.55, 0, 0],
    [0.2, 0.05, 0.35, 0.2, -0.45],
    [-0.18, 0.1, 0.3, -0.3, 0.5],
    [0.02, -0.2, 0.28, -0.5, 0.1],
  ];
  return (
    <group scale={config.scale}>
      {pieces.map(([x, z, len, tx, tz], i) => (
        <mesh key={i} position={[x, len / 2, z]} rotation={[tx, 0, tz]} castShadow>
          <capsuleGeometry args={[0.1, len, 4, 6]} />
          <meshStandardMaterial
            color={config.color}
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

/** Round-capped mushroom with cute spots. */
function Mushroom({ config }: { config: DecorationConfig }) {
  const spots: [number, number, number][] = [
    [0.12, 0.62, 0.14],
    [-0.15, 0.6, 0.08],
    [0.02, 0.66, -0.16],
    [-0.05, 0.7, 0.02],
  ];
  return (
    <group scale={config.scale}>
      <mesh position-y={0.25} castShadow>
        <capsuleGeometry args={[0.08, 0.35, 4, 10]} />
        <meshStandardMaterial color="#fff1e4" roughness={0.9} />
      </mesh>
      <mesh position-y={0.52} scale={[1, 0.62, 1]} castShadow>
        <sphereGeometry args={[0.28, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={config.color} roughness={0.6} />
      </mesh>
      {spots.map((p, i) => (
        <mesh key={i} position={p} scale={[1, 0.5, 1]}>
          <sphereGeometry args={[0.04, 8, 6]} />
          <meshStandardMaterial color="#fffaf5" roughness={0.6} />
        </mesh>
      ))}
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
            {config.kind === 'plant' && <Plant config={config} index={i} />}
            {config.kind === 'crystal' && <Crystal config={config} />}
            {config.kind === 'mushroom' && <Mushroom config={config} />}
          </group>
        );
      })}
    </group>
  );
}
