/**
 * Small shared building blocks for the toy-like station machines.
 * Everything here is placeholder geometry meant to be swapped for GLTF later.
 */
import type { RefObject } from 'react';
import { PALETTE } from '../../world/config';
import { panelTexture } from '../textures';

/** 0..1 "how busy is this station" value, smoothed per frame. */
export type ActivityRef = RefObject<number>;

export interface StationVisualProps {
  accent: string;
  activity: ActivityRef;
}

/** `textured` adds soft panel seams and rivets (for rounded boxes, whose UVs map one panel per face). */
export function BodyMaterial({ textured = false }: { textured?: boolean }) {
  return (
    <meshStandardMaterial
      color={PALETTE.machineBody}
      map={textured ? panelTexture() : null}
      roughness={0.55}
      metalness={0.02}
    />
  );
}

export function DarkMaterial() {
  return <meshStandardMaterial color={PALETTE.machineDark} roughness={0.6} metalness={0.05} />;
}

export function AccentMaterial({ color, textured = false }: { color: string; textured?: boolean }) {
  return <meshStandardMaterial color={color} map={textured ? panelTexture() : null} roughness={0.45} metalness={0.02} />;
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
      {/* Bolts around the plate */}
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(angle) * (radius - 0.16), 0.105, Math.sin(angle) * (radius - 0.16)]} scale={[1, 0.5, 1]}>
            <sphereGeometry args={[0.035, 10, 6]} />
            <meshStandardMaterial color="#cdb8d6" roughness={0.5} />
          </mesh>
        );
      })}
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
