import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { AdditiveBlending, type Group, type Mesh, type MeshBasicMaterial, type MeshStandardMaterial } from 'three';
import { PALETTE } from '../../world/config';
import { Particles } from '../effects/Particles';
import { AccentMaterial, BodyMaterial, Button, DarkMaterial, Foundation, type StationVisualProps } from './parts';

/**
 * Scanner (read / search files): an arch with a scan head beaming down at a
 * floating data cube. When busy, the beam brightens and the rings spin fast.
 */
export function Scanner({ accent, activity }: StationVisualProps) {
  const cube = useRef<Mesh>(null);
  const ring = useRef<Group>(null);
  const beam = useRef<MeshBasicMaterial>(null);
  const beamMesh = useRef<Mesh>(null);
  const platformGlow = useRef<MeshStandardMaterial>(null);
  const head = useRef<Group>(null);

  useFrame(({ clock }, delta) => {
    const a = activity.current ?? 0;
    const t = clock.elapsedTime;
    if (cube.current) {
      cube.current.position.y = 0.95 + Math.sin(t * (1.5 + a * 2)) * 0.06;
      cube.current.rotation.y += delta * (0.4 + a * 3);
      cube.current.rotation.x += delta * (0.2 + a * 1.5);
    }
    if (ring.current) {
      ring.current.rotation.z += delta * (0.6 + a * 6);
      ring.current.rotation.x = 1.2 + Math.sin(t * 0.8) * 0.2;
    }
    if (beam.current) beam.current.opacity = 0.04 + a * (0.3 + Math.sin(t * 12) * 0.08);
    if (beamMesh.current) beamMesh.current.scale.setScalar(0.9 + a * 0.1 + Math.sin(t * 4) * 0.03 * a);
    if (platformGlow.current) platformGlow.current.emissiveIntensity = 0.4 + a * (1.4 + Math.sin(t * 8) * 0.4);
    if (head.current) head.current.rotation.y = Math.sin(t * (0.5 + a * 3)) * (0.2 + a * 0.4);
  });

  return (
    <group>
      <Foundation radius={1.15} />

      {/* Pedestal */}
      <mesh position-y={0.36} castShadow receiveShadow>
        <cylinderGeometry args={[0.66, 0.8, 0.5, 40]} />
        <BodyMaterial />
      </mesh>
      <mesh position-y={0.2} rotation-x={Math.PI / 2} castShadow>
        <torusGeometry args={[0.77, 0.07, 12, 40]} />
        <AccentMaterial color={accent} />
      </mesh>

      {/* Platform with glowing ring */}
      <mesh position-y={0.64} receiveShadow>
        <cylinderGeometry args={[0.62, 0.62, 0.08, 40]} />
        <DarkMaterial />
      </mesh>
      <mesh position-y={0.69} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.48, 0.035, 8, 40]} />
        <meshStandardMaterial ref={platformGlow} color={accent} emissive={accent} emissiveIntensity={0.4} />
      </mesh>

      {/* Arch */}
      <mesh position-y={0.62} castShadow>
        <torusGeometry args={[0.92, 0.1, 14, 40, Math.PI]} />
        <BodyMaterial />
      </mesh>
      {[-0.92, 0.92].map((x) => (
        <mesh key={x} position={[x, 0.66, 0]} castShadow>
          <cylinderGeometry args={[0.15, 0.17, 0.16, 20]} />
          <AccentMaterial color={accent} />
        </mesh>
      ))}

      {/* Scan head */}
      <group ref={head} position-y={1.52}>
        <mesh castShadow>
          <sphereGeometry args={[0.22, 24, 16]} />
          <AccentMaterial color={accent} />
        </mesh>
        <mesh position-y={-0.18}>
          <cylinderGeometry args={[0.1, 0.12, 0.1, 20]} />
          <meshStandardMaterial color={PALETTE.glass} roughness={0.15} metalness={0.3} />
        </mesh>
        <mesh position={[0, 0.2, 0]}>
          <sphereGeometry args={[0.06, 12, 8]} />
          <meshStandardMaterial color="#ffffff" emissive={accent} emissiveIntensity={1.2} />
        </mesh>
      </group>

      {/* Beam */}
      <mesh ref={beamMesh} position-y={1.02}>
        <cylinderGeometry args={[0.07, 0.5, 0.76, 32, 1, true]} />
        <meshBasicMaterial
          ref={beam}
          color={accent}
          transparent
          opacity={0.04}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* Floating data cube and its orbit ring */}
      <RoundedBox ref={cube} args={[0.26, 0.26, 0.26]} radius={0.06} smoothness={3} position-y={0.95} castShadow>
        <meshStandardMaterial color={PALETTE.mint} emissive={accent} emissiveIntensity={0.45} roughness={0.3} />
      </RoundedBox>
      <group ref={ring} position-y={0.95}>
        <mesh>
          <torusGeometry args={[0.3, 0.018, 8, 40]} />
          <meshStandardMaterial color="#ffffff" emissive={accent} emissiveIntensity={0.6} />
        </mesh>
      </group>

      {/* Side console */}
      <group position={[0.95, 0, 0.55]} rotation-y={-0.5}>
        <RoundedBox args={[0.42, 0.5, 0.32]} radius={0.1} smoothness={3} position-y={0.35} castShadow>
          <BodyMaterial />
        </RoundedBox>
        <RoundedBox args={[0.3, 0.18, 0.04]} radius={0.03} smoothness={2} position={[0, 0.46, 0.16]} rotation-x={-0.3}>
          <meshStandardMaterial color="#2f3a5c" emissive={accent} emissiveIntensity={0.5} />
        </RoundedBox>
        <Button position={[0, 0.25, 0.17]} color="#ffd166" />
      </group>

      {/* Data bits drifting up out of the scan */}
      <Particles
        activity={activity}
        color={accent}
        origin={[0, 0.75, 0]}
        spread={0.35}
        velocity={[0, 0.55, 0]}
        jitter={0.25}
        gravity={0.3}
        lifetime={1.3}
        size={0.032}
        rate={18}
        count={30}
        glow
      />
    </group>
  );
}
