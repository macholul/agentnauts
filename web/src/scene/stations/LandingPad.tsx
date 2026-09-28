import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import { Color, type Group, type MeshStandardMaterial } from 'three';
import { LANDING_PAD, PAD_SCALE, PALETTE } from '../../world/config';
import type { ActivityRef } from './parts';

const LIGHTS = 12;
const CALM = new Color(PALETTE.teal);
const ALERT = new Color('#ffb020');

/**
 * Landing pad near the middle of the base. Astronauts wait here when their
 * agent needs the user; the rim lights switch to a blinking amber when anyone
 * is waiting. Crew astronauts also touch down here.
 */
export function LandingPad({ activity }: { activity: ActivityRef }) {
  const lights = useRef<(MeshStandardMaterial | null)[]>([]);
  const flag = useRef<Group>(null);
  const color = useRef(new Color());

  useFrame(({ clock }) => {
    const a = activity.current ?? 0;
    const t = clock.elapsedTime;
    color.current.copy(CALM).lerp(ALERT, a);
    for (let i = 0; i < LIGHTS; i++) {
      const mat = lights.current[i];
      if (!mat) continue;
      // Idle: slow chase. Waiting: everything blinks together.
      const chase = 0.5 + 0.5 * Math.sin(t * 2 - (i / LIGHTS) * Math.PI * 2);
      const blink = Math.sin(t * 7) > 0 ? 1 : 0.1;
      mat.emissive.copy(color.current);
      mat.color.copy(color.current);
      mat.emissiveIntensity = (0.3 + chase * 0.6) * (1 - a) + blink * 2.2 * a;
    }
    if (flag.current) flag.current.rotation.y = Math.sin(t * 1.7) * 0.25 + 0.2;
  });

  // Drawn inside a group scaled by PAD_SCALE.
  const radius = LANDING_PAD.radius / PAD_SCALE;
  const deckHeight = LANDING_PAD.deckHeight / PAD_SCALE;

  return (
    <group>
      {/* Deck with a soft rounded rim */}
      <mesh position-y={deckHeight / 2} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius + 0.05, deckHeight, 48]} />
        <meshStandardMaterial color="#efe8f7" roughness={0.7} />
      </mesh>
      <mesh position-y={deckHeight - 0.02} rotation-x={Math.PI / 2} castShadow receiveShadow>
        <torusGeometry args={[radius - 0.02, 0.07, 10, 48]} />
        <meshStandardMaterial color="#ddd3ea" roughness={0.7} />
      </mesh>

      {/* Markings */}
      <mesh position-y={deckHeight + 0.004} rotation-x={-Math.PI / 2} receiveShadow>
        <ringGeometry args={[0.92, 1.08, 48]} />
        <meshStandardMaterial color={PALETTE.teal} roughness={0.6} />
      </mesh>
      <mesh position-y={deckHeight + 0.004} rotation-x={-Math.PI / 2} receiveShadow>
        <circleGeometry args={[0.28, 32]} />
        <meshStandardMaterial color="#ffb38a" roughness={0.6} />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh
          key={i}
          position={[Math.cos((i * Math.PI) / 2) * 0.62, deckHeight + 0.004, Math.sin((i * Math.PI) / 2) * 0.62]}
          rotation={[-Math.PI / 2, 0, -(i * Math.PI) / 2]}
          receiveShadow
        >
          <planeGeometry args={[0.28, 0.1]} />
          <meshStandardMaterial color="#c9b8e8" roughness={0.6} />
        </mesh>
      ))}

      {/* Rim lights */}
      {Array.from({ length: LIGHTS }, (_, i) => {
        const angle = (i / LIGHTS) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(angle) * (radius - 0.02), deckHeight + 0.06, Math.sin(angle) * (radius - 0.02)]}>
            <sphereGeometry args={[0.065, 12, 8]} />
            <meshStandardMaterial
              ref={(m) => {
                lights.current[i] = m;
              }}
              color={PALETTE.teal}
              emissive={PALETTE.teal}
              emissiveIntensity={0.6}
              roughness={0.3}
            />
          </mesh>
        );
      })}

      {/* Beacon with a little flag */}
      <group position={[-radius * 0.72, 0, -radius * 0.72]}>
        <mesh position-y={0.55} castShadow>
          <capsuleGeometry args={[0.035, 1.0, 4, 8]} />
          <meshStandardMaterial color={PALETTE.machineDark} roughness={0.6} />
        </mesh>
        <group ref={flag} position-y={0.95}>
          <RoundedBox args={[0.42, 0.26, 0.03]} radius={0.012} smoothness={2} position-x={0.22} castShadow>
            <meshStandardMaterial color="#ff8fb1" roughness={0.6} />
          </RoundedBox>
        </group>
      </group>
    </group>
  );
}
