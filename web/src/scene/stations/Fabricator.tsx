import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import { PALETTE } from '../../world/config';
import { Particles } from '../effects/Particles';
import { AccentMaterial, Antenna, BodyMaterial, Button, DarkMaterial, Foundation, type StationVisualProps } from './parts';

/**
 * Fabricator (file edits / writes): a chunky 3D printer. When busy, the print
 * head zips back and forth, the nozzle glows and a little block grows on the bed.
 */
export function Fabricator({ accent, activity }: StationVisualProps) {
  const carriage = useRef<Group>(null);
  const nozzle = useRef<MeshStandardMaterial>(null);
  const screen = useRef<MeshStandardMaterial>(null);
  const printed = useRef<Mesh>(null);
  const phase = useRef(0);
  const progress = useRef(0.6);

  useFrame(({ clock }, delta) => {
    const a = activity.current ?? 0;
    phase.current += delta * (0.5 + a * 5);
    if (carriage.current) {
      carriage.current.position.x = Math.sin(phase.current) * (0.12 + a * 0.45);
      carriage.current.position.z = Math.cos(phase.current * 0.7) * a * 0.18;
    }
    if (nozzle.current) nozzle.current.emissiveIntensity = 0.3 + a * (2.2 + Math.sin(clock.elapsedTime * 30) * 0.6);
    if (screen.current) screen.current.emissiveIntensity = 0.35 + a * (0.9 + Math.sin(clock.elapsedTime * 6) * 0.25);
    // Print progress loops while working, rests when idle.
    if (a > 0.3) progress.current = (progress.current + delta * 0.35) % 1;
    const p = a > 0.3 ? 0.15 + progress.current * 0.85 : 0.6;
    if (printed.current) {
      const s = printed.current.scale;
      s.y += (p - s.y) * Math.min(1, delta * 8);
      printed.current.position.y = 0.75 + 0.15 * s.y;
      printed.current.rotation.y += delta * a * 0.8;
    }
  });

  return (
    <group>
      <Foundation radius={1.3} />

      {/* Stubby feet */}
      {(
        [
          [-0.75, -0.5],
          [0.75, -0.5],
          [-0.75, 0.5],
          [0.75, 0.5],
        ] as const
      ).map(([x, z], i) => (
        <mesh key={i} position={[x, 0.14, z]} castShadow>
          <cylinderGeometry args={[0.12, 0.14, 0.12, 16]} />
          <DarkMaterial />
        </mesh>
      ))}

      {/* Body */}
      <RoundedBox args={[1.9, 0.52, 1.3]} radius={0.16} smoothness={4} position-y={0.44} castShadow receiveShadow>
        <BodyMaterial />
      </RoundedBox>
      <RoundedBox args={[1.96, 0.12, 1.36]} radius={0.06} smoothness={3} position-y={0.25} castShadow>
        <AccentMaterial color={accent} />
      </RoundedBox>

      {/* Print bed */}
      <RoundedBox args={[1.35, 0.06, 0.95]} radius={0.03} smoothness={2} position-y={0.72} receiveShadow>
        <DarkMaterial />
      </RoundedBox>

      {/* Printed object */}
      <RoundedBox ref={printed} args={[0.28, 0.3, 0.28]} radius={0.06} smoothness={3} position-y={0.84} scale={[1, 0.6, 1]} castShadow>
        <meshStandardMaterial color={PALETTE.mint} emissive={PALETTE.mint} emissiveIntensity={0.25} roughness={0.4} />
      </RoundedBox>

      {/* Gantry */}
      {[-0.86, 0.86].map((x) => (
        <mesh key={x} position={[x, 1.12, -0.05]} castShadow>
          <capsuleGeometry args={[0.07, 0.8, 4, 12]} />
          <AccentMaterial color={accent} />
        </mesh>
      ))}
      <mesh position={[0, 1.55, -0.05]} rotation-z={Math.PI / 2} castShadow>
        <capsuleGeometry args={[0.075, 1.72, 4, 12]} />
        <BodyMaterial />
      </mesh>

      {/* Print head */}
      <group ref={carriage} position={[0, 1.55, -0.05]}>
        <RoundedBox args={[0.36, 0.3, 0.36]} radius={0.08} smoothness={3} castShadow>
          <AccentMaterial color={accent} />
        </RoundedBox>
        <mesh position-y={-0.22} castShadow>
          <capsuleGeometry args={[0.055, 0.12, 4, 10]} />
          <DarkMaterial />
        </mesh>
        <mesh position-y={-0.32}>
          <sphereGeometry args={[0.05, 12, 8]} />
          <meshStandardMaterial ref={nozzle} color="#ffe2b8" emissive={accent} emissiveIntensity={0.3} />
        </mesh>
      </group>

      {/* Front screen and buttons */}
      <RoundedBox args={[0.82, 0.26, 0.05]} radius={0.04} smoothness={2} position={[-0.3, 0.46, 0.65]}>
        <meshStandardMaterial ref={screen} color="#3b3563" emissive="#ffc79a" emissiveIntensity={0.35} roughness={0.3} />
      </RoundedBox>
      <Button position={[0.45, 0.46, 0.65]} color="#ff5d6c" />
      <Button position={[0.72, 0.46, 0.65]} color={PALETTE.teal} />

      {/* Material hopper on the back */}
      <RoundedBox args={[0.5, 0.45, 0.4]} radius={0.12} smoothness={3} position={[0.55, 0.9, -0.5]} castShadow>
        <AccentMaterial color={accent} />
      </RoundedBox>
      <Antenna position={[-0.7, 0.7, -0.45]} height={0.55} color={accent} />

      {/* Sparks while printing */}
      <Particles
        activity={activity}
        color="#ffd27a"
        origin={[0, 1.05, -0.05]}
        spread={0.35}
        velocity={[0, 1.4, 0]}
        jitter={1.1}
        gravity={-5}
        lifetime={0.55}
        size={0.035}
        rate={45}
        count={50}
        glow
      />
    </group>
  );
}
