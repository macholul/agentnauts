import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { Quaternion, Vector3, type Group, type MeshStandardMaterial } from 'three';
import { PALETTE } from '../../world/config';
import { AccentMaterial, BodyMaterial, Button, DarkMaterial, Foundation, type StationVisualProps } from './parts';

const APEX = new Vector3(0, 2.0, 0);
const LEG_BASE_RADIUS = 0.58;
const LEG_BASE_Y = 0.38;

/**
 * Drill (bash commands): a tripod rig with a chunky screw bit. When busy the
 * bit spins and pumps, the rig shudders and the warning light blinks.
 */
export function Drill({ accent, activity }: StationVisualProps) {
  const bit = useRef<Group>(null);
  const rig = useRef<Group>(null);
  const warn = useRef<MeshStandardMaterial>(null);

  const legs = useMemo(
    () =>
      [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3].map((phi) => {
        const base = new Vector3(Math.cos(phi) * LEG_BASE_RADIUS, LEG_BASE_Y, Math.sin(phi) * LEG_BASE_RADIUS);
        const dir = APEX.clone().sub(base);
        const length = dir.length();
        const mid = base.clone().add(APEX).multiplyScalar(0.5);
        const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
        return { mid, length, quaternion };
      }),
    [],
  );

  useFrame(({ clock }, delta) => {
    const a = activity.current ?? 0;
    const t = clock.elapsedTime;
    if (bit.current) {
      bit.current.rotation.y += delta * (0.4 + a * 14);
      bit.current.position.y = -a * (0.12 + Math.abs(Math.sin(t * 5)) * 0.1);
    }
    if (rig.current) {
      rig.current.position.x = Math.sin(t * 47) * 0.012 * a;
      rig.current.position.z = Math.cos(t * 53) * 0.012 * a;
    }
    if (warn.current) {
      const blink = Math.sin(t * 8) > 0 ? 1 : 0.15;
      warn.current.emissiveIntensity = 0.25 + a * blink * 2.2;
    }
  });

  return (
    <group>
      <Foundation radius={1.15} />
      <group ref={rig}>
        {/* Base platform with hazard band */}
        <RoundedBox args={[1.4, 0.26, 1.4]} radius={0.1} smoothness={3} position-y={0.26} castShadow receiveShadow>
          <BodyMaterial />
        </RoundedBox>
        <RoundedBox args={[1.46, 0.1, 1.46]} radius={0.05} smoothness={2} position-y={0.16} castShadow>
          <AccentMaterial color={accent} />
        </RoundedBox>
        {[-0.5, -0.27, -0.04].map((x) => (
          <RoundedBox key={x} args={[0.1, 0.12, 0.03]} radius={0.015} smoothness={2} position={[x, 0.29, 0.705]} rotation-z={0.6}>
            <DarkMaterial />
          </RoundedBox>
        ))}
        <mesh position-y={0.39} rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.2, 0.06, 10, 28]} />
          <DarkMaterial />
        </mesh>

        {/* Tripod */}
        {legs.map((leg, i) => (
          <mesh key={i} position={leg.mid} quaternion={leg.quaternion} castShadow>
            <capsuleGeometry args={[0.075, leg.length, 4, 12]} />
            <AccentMaterial color={accent} />
          </mesh>
        ))}

        {/* Motor housing and warning light */}
        <RoundedBox args={[0.6, 0.48, 0.6]} radius={0.14} smoothness={4} position-y={2.02} castShadow>
          <AccentMaterial color={accent} />
        </RoundedBox>
        <mesh position-y={2.3}>
          <cylinderGeometry args={[0.2, 0.24, 0.1, 20]} />
          <DarkMaterial />
        </mesh>
        <mesh position-y={2.42}>
          <sphereGeometry args={[0.11, 16, 12]} />
          <meshStandardMaterial ref={warn} color="#ff9b54" emissive="#ff7a2f" emissiveIntensity={0.25} roughness={0.3} />
        </mesh>

        {/* Spinning shaft and screw bit */}
        <group ref={bit}>
          <mesh position-y={1.2}>
            <cylinderGeometry args={[0.06, 0.06, 1.4, 12]} />
            <meshStandardMaterial color="#d6cce6" roughness={0.35} metalness={0.3} />
          </mesh>
          {[0.58, 0.74, 0.9, 1.06].map((y, i) => (
            <mesh key={y} position-y={y} rotation={[Math.PI / 2 + 0.25, 0, i * 0.8]} castShadow>
              <torusGeometry args={[0.2 - i * 0.02, 0.045, 8, 20]} />
              <meshStandardMaterial color="#8b80a8" roughness={0.4} metalness={0.25} />
            </mesh>
          ))}
          <mesh position-y={0.46}>
            <sphereGeometry args={[0.1, 14, 10]} />
            <meshStandardMaterial color="#8b80a8" roughness={0.4} metalness={0.25} />
          </mesh>
        </group>

        {/* Fuel tank, exhaust and controls */}
        <mesh position={[0.5, 0.6, -0.42]} rotation-z={Math.PI / 2} castShadow>
          <capsuleGeometry args={[0.15, 0.36, 6, 16]} />
          <meshStandardMaterial color={PALETTE.teal} roughness={0.45} />
        </mesh>
        <mesh position={[-0.52, 0.72, -0.5]} castShadow>
          <capsuleGeometry args={[0.07, 0.42, 4, 12]} />
          <DarkMaterial />
        </mesh>
        <Button position={[0.38, 0.28, 0.72]} color="#ff5d6c" />
      </group>
    </group>
  );
}
