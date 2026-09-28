import { useRef, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { AdditiveBlending, Quaternion, Vector3, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { PALETTE } from '../../world/config';
import type { AgentRole } from '../../store/agentStore';
import type { AstronautPose } from './pose';

export interface AstronautProps {
  color: string;
  role: AgentRole;
  pose: RefObject<AstronautPose>;
  /** Per-agent random offset so a crowd doesn't move in lockstep. */
  seed: number;
}

const SUIT = '#fbf6f0';
const BOOT = '#6e6690';
const VISOR_ARC = 1.9;
const VISOR_THETA_START = 1.0;
const VISOR_THETA_LENGTH = 1.05;
const HELMET_CENTER = new Vector3(0, 0.26, 0);

/** Flat highlight decals sitting on the visor surface, facing outward. */
const VISOR_GLINTS = (
  [
    { dir: [-0.42, 0.34, 0.84], scale: [0.055, 0.032, 1] },
    { dir: [-0.2, 0.17, 0.96], scale: [0.018, 0.018, 1] },
  ] as const
).map(({ dir, scale }) => {
  const normal = new Vector3(...dir).normalize();
  const position = normal.clone().multiply(new Vector3(0.306, 0.306, 0.306 * 1.05)).add(HELMET_CENTER);
  const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal);
  // Tilt the ellipse to follow the visor's curve.
  quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.55));
  return { position, quaternion, scale: [...scale] as [number, number, number] };
});

/** Soft fabric: matte with a gentle lavender sheen at glancing angles. */
function SuitMaterial() {
  return <meshPhysicalMaterial color={SUIT} roughness={0.7} sheen={0.8} sheenRoughness={0.5} sheenColor="#d9c8ff" />;
}

interface LimbTargets {
  legL: number;
  legR: number;
  armLX: number;
  armRX: number;
  armLZ: number;
  armRZ: number;
  headX: number;
  headY: number;
  bob: number;
  roll: number;
}

/** Move `current` toward `target` smoothly and frame-rate independently. */
function damp(current: number, target: number, lambda: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * delta));
}

/**
 * A stubby, cute astronaut built from primitives: big round helmet with a
 * glossy visor, small body, short limbs, chunky backpack. All motion comes
 * from the pose ref, so this component can be swapped for a GLTF model.
 */
export function Astronaut({ color, role, pose, seed }: AstronautProps) {
  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const flames = useRef<Group>(null);
  const flameL = useRef<Mesh>(null);
  const flameR = useRef<Mesh>(null);
  const beacon = useRef<MeshStandardMaterial>(null);
  const phase = useRef(seed * 10);

  useFrame(({ clock }, rawDelta) => {
    const p = pose.current;
    if (!p) return;
    const delta = Math.min(rawDelta, 0.1);
    const t = clock.elapsedTime + seed * 7;
    const target: LimbTargets = {
      legL: 0,
      legR: 0,
      armLX: 0,
      armRX: 0,
      armLZ: -0.15,
      armRZ: 0.15,
      headX: 0,
      headY: 0,
      bob: 0,
      roll: 0,
    };

    switch (p.mode) {
      case 'walk': {
        const s = Math.max(0.35, p.speed);
        phase.current += delta * 10 * s;
        const swing = Math.sin(phase.current);
        target.legL = swing * 0.75 * s;
        target.legR = -swing * 0.75 * s;
        target.armLX = -swing * 0.65 * s;
        target.armRX = swing * 0.65 * s;
        target.bob = Math.abs(Math.cos(phase.current)) * 0.06 * s;
        target.roll = swing * 0.05 * s;
        break;
      }
      case 'work': {
        phase.current += delta * 7;
        const w = phase.current;
        switch (p.station) {
          case 'drill':
            // Hold on tight: arms forward, everything shakes.
            target.armLX = -0.95 + Math.sin(w * 6) * 0.08;
            target.armRX = -0.95 + Math.cos(w * 6) * 0.08;
            target.armLZ = -0.35;
            target.armRZ = 0.35;
            target.bob = Math.abs(Math.sin(w * 3)) * 0.035;
            target.roll = Math.sin(w * 11) * 0.02;
            target.headX = 0.1;
            break;
          case 'scanner':
            // Hold a hand up to the scanner, peer at the results.
            target.armRX = -1.55 + Math.sin(w * 0.8) * 0.12;
            target.armRZ = 0.25;
            target.armLX = -0.45 + Math.sin(w * 1.6) * 0.1;
            target.headX = 0.05;
            target.headY = Math.sin(w * 0.6) * 0.3;
            target.bob = Math.sin(w) * 0.012;
            break;
          case 'radar':
            // Look up at the sky and point.
            target.headX = -0.35;
            target.armRX = -2.5 + Math.sin(w * 0.9) * 0.15;
            target.armRZ = 0.35;
            target.armLX = -0.2;
            target.headY = Math.sin(w * 0.5) * 0.25;
            target.bob = Math.sin(w * 0.8) * 0.012;
            break;
          default:
            // Fabricator and anything else: busy tinkering with both hands.
            target.armLX = -1.15 + Math.sin(w * 1.6) * 0.3;
            target.armRX = -1.15 + Math.cos(w * 1.6) * 0.3;
            target.armLZ = -0.2;
            target.armRZ = 0.2;
            target.headX = 0.22;
            target.bob = Math.abs(Math.sin(w * 1.6)) * 0.02;
        }
        break;
      }
      case 'wait': {
        // Shift weight side to side and wave every few seconds.
        target.roll = Math.sin(t * 1.8) * 0.06;
        target.bob = Math.abs(Math.sin(t * 1.8)) * 0.015;
        target.headX = -0.12;
        const waving = t % 3.5 < 1.3;
        if (waving) {
          target.armRZ = 2.6 + Math.sin(t * 14) * 0.35;
          target.armRX = -0.2;
        }
        target.armLZ = -0.25;
        break;
      }
      case 'fly': {
        target.legL = 0.35;
        target.legR = 0.25;
        target.armLZ = -0.8;
        target.armRZ = 0.8;
        target.armLX = -0.3;
        target.armRX = -0.3;
        target.headX = -0.1;
        break;
      }
      case 'idle':
      default: {
        target.bob = Math.sin(t * 2) * 0.008;
        target.armLX = Math.sin(t * 0.9) * 0.06;
        target.armRX = -Math.sin(t * 0.9) * 0.06;
        target.headY = p.look;
        target.headX = Math.sin(t * 0.7) * 0.05;
      }
    }

    const k = p.mode === 'walk' ? 18 : 10;
    if (legL.current) legL.current.rotation.x = damp(legL.current.rotation.x, target.legL, k, delta);
    if (legR.current) legR.current.rotation.x = damp(legR.current.rotation.x, target.legR, k, delta);
    if (armL.current) {
      armL.current.rotation.x = damp(armL.current.rotation.x, target.armLX, k, delta);
      armL.current.rotation.z = damp(armL.current.rotation.z, target.armLZ, k, delta);
    }
    if (armR.current) {
      armR.current.rotation.x = damp(armR.current.rotation.x, target.armRX, k, delta);
      armR.current.rotation.z = damp(armR.current.rotation.z, target.armRZ, k, delta);
    }
    if (head.current) {
      head.current.rotation.x = damp(head.current.rotation.x, target.headX, 6, delta);
      head.current.rotation.y = damp(head.current.rotation.y, target.headY, 4, delta);
    }
    if (body.current) {
      body.current.position.y = damp(body.current.position.y, target.bob, 20, delta);
      body.current.rotation.z = damp(body.current.rotation.z, target.roll, 12, delta);
      const sq = p.squash;
      body.current.scale.set(1 + sq * 0.18, 1 - sq * 0.28, 1 + sq * 0.18);
    }
    if (flames.current) {
      flames.current.visible = p.thrust > 0.02;
      const flicker = 0.8 + Math.sin(t * 40) * 0.12 + Math.sin(t * 67) * 0.08;
      const len = (0.4 + p.thrust * 1.2) * flicker;
      flameL.current?.scale.set(0.8, len, 0.8);
      flameR.current?.scale.set(0.8, len * 0.95, 0.8);
    }
    if (beacon.current) beacon.current.emissiveIntensity = Math.sin(t * 4) > 0.3 ? 2.2 : 0.3;
  });

  return (
    <group ref={body}>
      {/* Legs */}
      {(
        [
          [legL, -0.1],
          [legR, 0.1],
        ] as const
      ).map(([ref, x]) => (
        <group key={x} ref={ref} position={[x, 0.25, 0]}>
          <mesh position-y={-0.09} castShadow>
            <capsuleGeometry args={[0.075, 0.09, 4, 12]} />
            <SuitMaterial />
          </mesh>
          <mesh position={[0, -0.19, 0.025]} scale={[1, 0.7, 1.3]} castShadow>
            <sphereGeometry args={[0.09, 16, 12]} />
            <meshStandardMaterial color={BOOT} roughness={0.7} />
          </mesh>
          <mesh position-y={-0.135} rotation-x={Math.PI / 2}>
            <torusGeometry args={[0.072, 0.022, 8, 18]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
        </group>
      ))}

      {/* Torso */}
      <mesh position-y={0.43} castShadow>
        <capsuleGeometry args={[0.19, 0.1, 6, 18]} />
        <SuitMaterial />
      </mesh>
      <mesh position-y={0.34} rotation-x={Math.PI / 2}>
        <torusGeometry args={[0.185, 0.035, 8, 24]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      <RoundedBox args={[0.08, 0.05, 0.03]} radius={0.012} smoothness={2} position={[0, 0.34, 0.215]}>
        <meshStandardMaterial color="#fff4dc" roughness={0.35} metalness={0.2} />
      </RoundedBox>
      <RoundedBox args={[0.17, 0.1, 0.04]} radius={0.02} smoothness={2} position={[0, 0.47, 0.175]}>
        <meshStandardMaterial color={PALETTE.machineDark} roughness={0.5} />
      </RoundedBox>
      {[-0.04, 0.04].map((x) => (
        <mesh key={x} position={[x, 0.47, 0.198]}>
          <sphereGeometry args={[0.018, 8, 6]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} />
        </mesh>
      ))}

      {/* Arms */}
      {(
        [
          [armL, -0.22, -0.15],
          [armR, 0.22, 0.15],
        ] as const
      ).map(([ref, x, z]) => (
        <group key={x} ref={ref} position={[x, 0.54, 0]} rotation-z={z}>
          <mesh position-y={0.005} scale={[1, 0.7, 1]} castShadow>
            <sphereGeometry args={[0.078, 14, 10]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
          <mesh position-y={-0.1} castShadow>
            <capsuleGeometry args={[0.058, 0.12, 4, 12]} />
            <SuitMaterial />
          </mesh>
          <mesh position-y={-0.21} castShadow>
            <sphereGeometry args={[0.068, 14, 10]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
        </group>
      ))}

      {/* Backpack */}
      <RoundedBox args={[0.3, 0.32, 0.16]} radius={0.06} smoothness={3} position={[0, 0.47, -0.2]} castShadow>
        <meshStandardMaterial color={color} roughness={0.5} />
      </RoundedBox>
      <RoundedBox args={[0.2, 0.08, 0.04]} radius={0.02} smoothness={2} position={[0, 0.55, -0.285]}>
        <SuitMaterial />
      </RoundedBox>
      {[-0.17, 0.17].map((x) => (
        <mesh key={x} position={[x, 0.47, -0.22]} castShadow>
          <capsuleGeometry args={[0.045, 0.18, 4, 10]} />
          <SuitMaterial />
        </mesh>
      ))}
      {[-0.08, 0.08].map((x) => (
        <mesh key={x} position={[x, 0.29, -0.22]}>
          <cylinderGeometry args={[0.04, 0.05, 0.06, 12]} />
          <meshStandardMaterial color={PALETTE.machineDark} roughness={0.5} />
        </mesh>
      ))}
      <group ref={flames} position-y={0.24} visible={false}>
        {(
          [
            [flameL, -0.08],
            [flameR, 0.08],
          ] as const
        ).map(([ref, x]) => (
          <mesh key={x} ref={ref} position={[x, 0, -0.22]}>
            <sphereGeometry args={[0.045, 10, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]} />
            <meshBasicMaterial color="#ffb347" transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
          </mesh>
        ))}
      </group>
      {role === 'commander' && (
        <group position={[0.1, 0.62, -0.23]}>
          <mesh position-y={0.11}>
            <capsuleGeometry args={[0.014, 0.22, 4, 6]} />
            <meshStandardMaterial color={PALETTE.machineDark} />
          </mesh>
          <mesh position-y={0.25}>
            <sphereGeometry args={[0.035, 10, 8]} />
            <meshStandardMaterial ref={beacon} color={color} emissive={color} emissiveIntensity={1} />
          </mesh>
        </group>
      )}

      {/* Helmet */}
      <group ref={head} position-y={0.62}>
        <mesh position-y={0.26} castShadow>
          <sphereGeometry args={[0.3, 32, 24]} />
          <meshStandardMaterial color={SUIT} roughness={0.35} />
        </mesh>
        <mesh position-y={0.26} scale={[1.0, 1.0, 1.05]}>
          <sphereGeometry
            args={[0.302, 32, 16, Math.PI / 2 - VISOR_ARC / 2, VISOR_ARC, VISOR_THETA_START, VISOR_THETA_LENGTH]}
          />
          <meshStandardMaterial color={PALETTE.glass} roughness={0.08} metalness={0.55} envMapIntensity={2.2} />
        </mesh>
        {/* Cartoon glints on the visor */}
        {VISOR_GLINTS.map((g, i) => (
          <mesh key={i} position={g.position} quaternion={g.quaternion} scale={g.scale}>
            <circleGeometry args={[1, 20]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={0.85} toneMapped={false} />
          </mesh>
        ))}
        <mesh position-y={0.04} rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.16, 0.04, 8, 24]} />
          <meshStandardMaterial color={color} roughness={0.5} />
        </mesh>
        {/* Little helmet lamp */}
        <group position={[0, 0.54, 0.1]} rotation-x={0.35}>
          <mesh>
            <capsuleGeometry args={[0.035, 0.05, 4, 10]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.02, 0.03]}>
            <sphereGeometry args={[0.022, 10, 8]} />
            <meshStandardMaterial color="#fffbe8" emissive="#fff1c2" emissiveIntensity={1.4} />
          </mesh>
        </group>
        {[-0.3, 0.3].map((x) => (
          <mesh key={x} position={[x, 0.26, 0]} rotation-z={Math.PI / 2}>
            <cylinderGeometry args={[0.06, 0.06, 0.05, 16]} />
            <meshStandardMaterial color={color} roughness={0.5} />
          </mesh>
        ))}
      </group>
    </group>
  );
}
