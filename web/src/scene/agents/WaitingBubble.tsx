import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, MeshStandardMaterial } from 'three';

const BUBBLE = '#ffb020';

/** Floating "!" above an astronaut that needs the user. Pops in and out. */
export function WaitingBubble({ visible }: { visible: boolean }) {
  const group = useRef<Group>(null);
  const ring = useRef<Group>(null);
  const ringMat = useRef<MeshStandardMaterial>(null);
  const amount = useRef(0);

  useFrame(({ clock }, delta) => {
    const g = group.current;
    if (!g) return;
    const target = visible ? 1 : 0;
    amount.current += (target - amount.current) * (1 - Math.exp(-10 * delta));
    const a = amount.current;
    g.visible = a > 0.01;
    if (!g.visible) return;
    const t = clock.elapsedTime;
    // Overshoot a little when popping in.
    const pop = a * (1 + Math.sin(a * Math.PI) * 0.25) * 1.35;
    g.scale.setScalar(pop);
    // Sits above the name label so the DOM label never covers it.
    g.position.y = 2.05 + Math.sin(t * 3) * 0.06;
    g.rotation.y = Math.sin(t * 1.3) * 0.5;
    if (ring.current) {
      const phase = (t * 0.9) % 1;
      ring.current.scale.setScalar(0.6 + phase * 0.9);
      if (ringMat.current) ringMat.current.opacity = (1 - phase) * 0.7;
    }
  });

  return (
    <group ref={group} visible={false}>
      <mesh position-y={0.12}>
        <capsuleGeometry args={[0.065, 0.17, 6, 12]} />
        <meshStandardMaterial color={BUBBLE} emissive={BUBBLE} emissiveIntensity={0.8} roughness={0.3} />
      </mesh>
      <mesh position-y={-0.12}>
        <sphereGeometry args={[0.07, 14, 10]} />
        <meshStandardMaterial color={BUBBLE} emissive={BUBBLE} emissiveIntensity={0.8} roughness={0.3} />
      </mesh>
      <group ref={ring} position-y={-0.22}>
        <mesh rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.2, 0.018, 6, 28]} />
          <meshStandardMaterial ref={ringMat} color={BUBBLE} emissive={BUBBLE} emissiveIntensity={1} transparent opacity={0.6} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}
