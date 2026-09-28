import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, Color, InstancedMesh, Object3D, Vector3 } from 'three';
import type { ActivityRef } from '../stations/parts';

export interface ParticlesProps {
  /** 0..1 ref controlling the emission rate. */
  activity: ActivityRef;
  /** Max particles alive at once. */
  count?: number;
  /** Particles per second at full activity. */
  rate?: number;
  color: string;
  /** Local emission point. */
  origin?: [number, number, number];
  /** Random offset around the origin. */
  spread?: number;
  /** Base velocity plus a random cone of `jitter`. */
  velocity?: [number, number, number];
  jitter?: number;
  gravity?: number;
  lifetime?: number;
  size?: number;
  /** Glowing (additive) sparks vs. soft opaque puffs. */
  glow?: boolean;
  /** Puffs grow as they age instead of shrinking. */
  grow?: boolean;
}

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  position: Vector3;
  velocity: Vector3;
}

/**
 * Cheap instanced particle emitter for station reactions (sparks, dust,
 * data bits). Emission scales with the activity ref; no React re-renders.
 */
export function Particles({
  activity,
  count = 40,
  rate = 20,
  color,
  origin = [0, 0, 0],
  spread = 0.05,
  velocity = [0, 1, 0],
  jitter = 0.6,
  gravity = -2,
  lifetime = 0.8,
  size = 0.05,
  glow = false,
  grow = false,
}: ParticlesProps) {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const particles = useMemo<Particle[]>(
    () =>
      Array.from({ length: count }, () => ({
        alive: false,
        age: 0,
        life: 1,
        position: new Vector3(),
        velocity: new Vector3(),
      })),
    [count],
  );
  const budget = useRef(0);
  const tint = useMemo(() => new Color(color), [color]);

  useFrame((_, rawDelta) => {
    const m = mesh.current;
    if (!m) return;
    const dt = Math.min(rawDelta, 0.1);
    const a = activity.current ?? 0;

    budget.current += a > 0.15 ? rate * a * dt : 0;
    for (const p of particles) {
      if (budget.current < 1) break;
      if (p.alive) continue;
      budget.current -= 1;
      p.alive = true;
      p.age = 0;
      p.life = lifetime * (0.7 + Math.random() * 0.6);
      p.position.set(
        origin[0] + (Math.random() - 0.5) * spread * 2,
        origin[1] + (Math.random() - 0.5) * spread,
        origin[2] + (Math.random() - 0.5) * spread * 2,
      );
      p.velocity.set(
        velocity[0] + (Math.random() - 0.5) * jitter * 2,
        velocity[1] + Math.random() * jitter,
        velocity[2] + (Math.random() - 0.5) * jitter * 2,
      );
    }
    budget.current = Math.min(budget.current, 2);

    let visible = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      if (p.alive) {
        p.age += dt;
        if (p.age >= p.life) p.alive = false;
      }
      if (!p.alive) {
        dummy.scale.setScalar(0);
      } else {
        visible++;
        p.velocity.y += gravity * dt;
        p.position.addScaledVector(p.velocity, dt);
        const k = p.age / p.life;
        const s = grow ? size * (0.6 + k * 1.4) * (1 - k * k) : size * (1 - k);
        dummy.position.copy(p.position);
        dummy.scale.setScalar(Math.max(0, s));
      }
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.visible = visible > 0;
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false} visible={false}>
      <sphereGeometry args={[1, 8, 6]} />
      {glow ? (
        <meshBasicMaterial color={tint} transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      ) : (
        <meshStandardMaterial color={tint} roughness={1} transparent opacity={0.85} depthWrite={false} />
      )}
    </instancedMesh>
  );
}
