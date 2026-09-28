/**
 * Small shared building blocks for the toy-like station machines.
 * Everything here is placeholder geometry meant to be swapped for GLTF later.
 */
import type { RefObject } from 'react';
import { PALETTE } from '../../world/config';

/** 0..1 "how busy is this station" value, smoothed per frame. */
export type ActivityRef = RefObject<number>;

export interface StationVisualProps {
  accent: string;
  activity: ActivityRef;
}

export function BodyMaterial() {
  return <meshStandardMaterial color={PALETTE.machineBody} roughness={0.55} metalness={0.02} />;
}

export function DarkMaterial() {
  return <meshStandardMaterial color={PALETTE.machineDark} roughness={0.6} metalness={0.05} />;
}

export function AccentMaterial({ color }: { color: string }) {
  return <meshStandardMaterial color={color} roughness={0.45} metalness={0.02} />;
}

/** Rounded base plate every machine sits on. */
export function Foundation({ radius }: { radius: number }) {
  return (
    <group>
      <mesh position-y={0.05} receiveShadow castShadow>
        <cylinderGeometry args={[radius, radius + 0.08, 0.1, 40]} />
        <meshStandardMaterial color="#efdcea" roughness={0.85} />
      </mesh>
      <mesh position-y={0.1} rotation-x={Math.PI / 2} receiveShadow>
        <torusGeometry args={[radius - 0.02, 0.05, 8, 40]} />
        <meshStandardMaterial color="#e3cfe2" roughness={0.85} />
      </mesh>
    </group>
  );
}

/** A chunky round push-button. */
export function Button({ position, color }: { position: [number, number, number]; color: string }) {
  return (
    <group position={position} rotation-x={Math.PI / 2}>
      <mesh castShadow>
        <cylinderGeometry args={[0.1, 0.11, 0.05, 20]} />
        <DarkMaterial />
      </mesh>
      <mesh position-y={0.035}>
        <sphereGeometry args={[0.075, 16, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} roughness={0.35} />
      </mesh>
    </group>
  );
}

/** Thin stick antenna with a glowing ball on top. */
export function Antenna({
  position,
  height = 0.5,
  color,
}: {
  position: [number, number, number];
  height?: number;
  color: string;
}) {
  return (
    <group position={position}>
      <mesh position-y={height / 2} castShadow>
        <capsuleGeometry args={[0.025, height, 4, 8]} />
        <DarkMaterial />
      </mesh>
      <mesh position-y={height + 0.05}>
        <sphereGeometry args={[0.06, 14, 10]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} roughness={0.3} />
      </mesh>
    </group>
  );
}
