import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import {
  AdditiveBlending,
  DoubleSide,
  Quaternion,
  Vector3,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
} from 'three';
import { AccentMaterial, Antenna, BodyMaterial, Button, DarkMaterial, Foundation, type StationVisualProps } from './parts';

const DISH_RADIUS = 0.95;
const DISH_ANGLE = 0.78;
const RIM_RADIUS = DISH_RADIUS * Math.sin(DISH_ANGLE);
const RIM_Y = DISH_RADIUS - DISH_RADIUS * Math.cos(DISH_ANGLE);
const FEED_TIP = new Vector3(0, 0.7, 0);
const WAVES = 3;

/**
 * Radar dish (web search / fetch): a big bowl on a turret. When busy it
 * sweeps the sky, the feed tip blinks and signal rings pulse outward.
 */
export function RadarDish({ accent, activity }: StationVisualProps) {
  const turret = useRef<Group>(null);
  const dish = useRef<Group>(null);
  const tip = useRef<MeshStandardMaterial>(null);
  const waves = useRef<(Mesh | null)[]>([]);
  const waveMats = useRef<(MeshBasicMaterial | null)[]>([]);
  const sweep = useRef(0);

  const struts = useMemo(
    () =>
      [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((phi) => {
        const base = new Vector3(Math.cos(phi) * RIM_RADIUS * 0.92, RIM_Y, Math.sin(phi) * RIM_RADIUS * 0.92);
        const dir = FEED_TIP.clone().sub(base);
        const length = dir.length();
        const mid = base.clone().add(FEED_TIP).multiplyScalar(0.5);
        const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
        return { mid, length, quaternion };
      }),
    [],
  );

  useFrame(({ clock }, delta) => {
    const a = activity.current ?? 0;
    const t = clock.elapsedTime;
    sweep.current += delta * (0.15 + a * 1.6);
    if (turret.current) turret.current.rotation.y = Math.sin(sweep.current) * (0.5 + a * 0.6);
    if (dish.current) dish.current.rotation.x = 0.75 + Math.sin(t * 0.6 + a) * 0.08 + a * Math.sin(t * 2.3) * 0.12;
    if (tip.current) tip.current.emissiveIntensity = 0.5 + a * (Math.sin(t * 10) > 0 ? 2.5 : 0.6);
    for (let i = 0; i < WAVES; i++) {
      const mesh = waves.current[i];
      const mat = waveMats.current[i];
      if (!mesh || !mat) continue;
      const phase = (t * 0.8 + i / WAVES) % 1;
      mesh.position.y = FEED_TIP.y + 0.1 + phase * 1.3;
      mesh.scale.setScalar(0.3 + phase * 1.6);
      mat.opacity = (1 - phase) * 0.55 * a;
      mesh.visible = a > 0.02;
    }
  });

  return (
    <group>
      <Foundation radius={1.2} />

      {/* Pedestal */}
      <mesh position-y={0.4} castShadow receiveShadow>
        <cylinderGeometry args={[0.4, 0.58, 0.6, 32]} />
        <BodyMaterial />
      </mesh>
      <mesh position-y={0.25} rotation-x={Math.PI / 2} castShadow>
        <torusGeometry args={[0.54, 0.06, 10, 32]} />
        <AccentMaterial color={accent} />
      </mesh>

      {/* Turret + tilting dish */}
      <group ref={turret} position-y={0.7}>
        <mesh position-y={0.08} castShadow>
          <cylinderGeometry args={[0.34, 0.38, 0.22, 28]} />
          <AccentMaterial color={accent} />
        </mesh>
        <mesh position-y={0.3} castShadow>
          <capsuleGeometry args={[0.1, 0.25, 4, 12]} />
          <DarkMaterial />
        </mesh>
        <group ref={dish} position-y={0.45} rotation-x={0.75}>
          <mesh position-y={DISH_RADIUS} rotation-x={Math.PI} castShadow receiveShadow>
            <sphereGeometry args={[DISH_RADIUS, 40, 10, 0, Math.PI * 2, 0, DISH_ANGLE]} />
            <meshStandardMaterial color="#fbf3ea" roughness={0.5} side={DoubleSide} />
          </mesh>
          <mesh position-y={RIM_Y} rotation-x={Math.PI / 2} castShadow>
            <torusGeometry args={[RIM_RADIUS, 0.055, 10, 40]} />
            <AccentMaterial color={accent} />
          </mesh>
          <mesh position-y={0.02}>
            <sphereGeometry args={[0.17, 16, 12]} />
            <DarkMaterial />
          </mesh>
          {struts.map((s, i) => (
            <mesh key={i} position={s.mid} quaternion={s.quaternion}>
              <capsuleGeometry args={[0.018, s.length, 4, 6]} />
              <DarkMaterial />
            </mesh>
          ))}
          <mesh position-y={0.36}>
            <capsuleGeometry args={[0.03, 0.62, 4, 8]} />
            <DarkMaterial />
          </mesh>
          <mesh position={FEED_TIP}>
            <sphereGeometry args={[0.085, 16, 12]} />
            <meshStandardMaterial ref={tip} color="#ffffff" emissive={accent} emissiveIntensity={0.5} />
          </mesh>
          {Array.from({ length: WAVES }, (_, i) => (
            <mesh
              key={i}
              ref={(m) => {
                waves.current[i] = m;
              }}
              rotation-x={Math.PI / 2}
              visible={false}
            >
              <torusGeometry args={[0.3, 0.02, 6, 36]} />
              <meshBasicMaterial
                ref={(m) => {
                  waveMats.current[i] = m;
                }}
                color={accent}
                transparent
                opacity={0}
                depthWrite={false}
                blending={AdditiveBlending}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      </group>

      {/* Control box */}
      <group position={[0.85, 0, 0.45]} rotation-y={-0.6}>
        <RoundedBox args={[0.46, 0.44, 0.36]} radius={0.1} smoothness={3} position-y={0.32} castShadow>
          <BodyMaterial />
        </RoundedBox>
        <RoundedBox args={[0.32, 0.14, 0.04]} radius={0.03} smoothness={2} position={[0, 0.42, 0.18]}>
          <meshStandardMaterial color="#2f3a5c" emissive={accent} emissiveIntensity={0.45} />
        </RoundedBox>
        <Button position={[-0.08, 0.24, 0.19]} color="#ffd166" />
        <Button position={[0.12, 0.24, 0.19]} color="#7ee0c3" />
        <Antenna position={[0.12, 0.54, -0.05]} height={0.35} color={accent} />
      </group>
    </group>
  );
}
