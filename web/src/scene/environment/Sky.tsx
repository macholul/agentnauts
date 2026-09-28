import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BackSide, Color, InstancedMesh, Object3D, type Group } from 'three';
import { PALETTE } from '../../world/config';

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragment = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 low;
  uniform vec3 mid;
  uniform vec3 nadir;
  varying vec3 vDir;
  void main() {
    float h = normalize(vDir).y;
    vec3 col;
    if (h >= 0.0) {
      col = mix(horizon, zenith, smoothstep(0.0, 0.6, h));
    } else {
      col = mix(horizon, low, smoothstep(0.0, -0.28, h));
      col = mix(col, mid, smoothstep(-0.28, -0.55, h));
      col = mix(col, nadir, smoothstep(-0.55, -0.95, h));
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Big gradient dome: peachy horizon glow fading through pink to periwinkle below. */
function SkyDome() {
  const uniforms = useMemo(
    () => ({
      zenith: { value: new Color(PALETTE.skyZenith) },
      horizon: { value: new Color(PALETTE.skyHorizon) },
      low: { value: new Color(PALETTE.skyLow) },
      mid: { value: new Color(PALETTE.skyMid) },
      nadir: { value: new Color(PALETTE.skyNadir) },
    }),
    [],
  );
  return (
    <mesh renderOrder={-1}>
      <sphereGeometry args={[400, 32, 24]} />
      <shaderMaterial
        side={BackSide}
        depthWrite={false}
        fog={false}
        toneMapped={false}
        uniforms={uniforms}
        vertexShader={skyVertex}
        fragmentShader={skyFragment}
      />
    </mesh>
  );
}

/** A soft ringed planet hanging in the sky, purely decorative. */
function Planet() {
  const ring = useRef<Group>(null);
  useFrame((_, delta) => {
    if (ring.current) ring.current.rotation.z += delta * 0.01;
  });
  return (
    <group position={[-210, -35, 40]}>
      <mesh>
        <sphereGeometry args={[26, 48, 32]} />
        <meshStandardMaterial color="#a8e3d8" emissive="#7fc9c4" emissiveIntensity={0.35} roughness={1} fog={false} />
      </mesh>
      <group ref={ring} rotation={[1.2, 0.3, 0]}>
        <mesh>
          <torusGeometry args={[42, 2.6, 8, 96]} />
          <meshStandardMaterial color="#f4d9f0" emissive="#e8c2e6" emissiveIntensity={0.4} roughness={1} fog={false} />
        </mesh>
      </group>
      <mesh position={[48, 30, -40]}>
        <sphereGeometry args={[5, 32, 24]} />
        <meshStandardMaterial color="#ffd6a8" emissive="#ffc690" emissiveIntensity={0.35} roughness={1} fog={false} />
      </mesh>
    </group>
  );
}

interface Cloud {
  x: number;
  y: number;
  z: number;
  scale: number;
  speed: number;
}

const CLOUDS: Cloud[] = [
  { x: -60, y: -40, z: -40, scale: 7, speed: 0.4 },
  { x: 10, y: -48, z: -75, scale: 9, speed: 0.3 },
  { x: 60, y: -36, z: -60, scale: 6.5, speed: 0.5 },
  { x: -95, y: -50, z: 10, scale: 10, speed: 0.25 },
  { x: -40, y: -58, z: -100, scale: 11, speed: 0.35 },
  { x: 90, y: -52, z: -95, scale: 9, speed: 0.3 },
  { x: -120, y: -44, z: -70, scale: 9, speed: 0.2 },
  { x: 30, y: -62, z: -130, scale: 12, speed: 0.3 },
  { x: 110, y: -56, z: -20, scale: 10, speed: 0.25 },
];

// Each cloud is a cluster of puffs (offsets in cloud-local units).
const PUFFS: [number, number, number, number][] = [
  [0, 0, 0, 1],
  [1.1, -0.1, 0.2, 0.8],
  [-1.0, -0.15, -0.1, 0.75],
  [0.4, 0.45, -0.3, 0.7],
  [-0.3, 0.35, 0.4, 0.6],
];

/** Puffy pastel clouds drifting far below the chunk, one instanced mesh. */
function Clouds() {
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const count = CLOUDS.length * PUFFS.length;

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    let i = 0;
    for (const cloud of CLOUDS) {
      // Drift slowly and wrap around.
      const x = ((cloud.x + t * cloud.speed + 160) % 320) - 160;
      for (const [px, py, pz, ps] of PUFFS) {
        dummy.position.set(x + px * cloud.scale, cloud.y + py * cloud.scale, cloud.z + pz * cloud.scale);
        dummy.scale.setScalar(ps * cloud.scale);
        dummy.updateMatrix();
        m.setMatrixAt(i++, dummy.matrix);
      }
    }
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[1, 20, 14]} />
      <meshStandardMaterial color="#fff4f6" emissive="#f2d9ef" emissiveIntensity={0.45} roughness={1} />
    </instancedMesh>
  );
}

/** Tiny floating rocks orbiting the chunk slowly. */
function FloatingRocks() {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    g.rotation.y = Math.sin(clock.elapsedTime * 0.03) * 0.4;
    g.children.forEach((child, i) => {
      child.position.y = -1.5 + Math.sin(clock.elapsedTime * 0.5 + i * 1.7) * 0.35 + (i % 3) * 0.9;
      child.rotation.x = clock.elapsedTime * 0.1 * (i + 1);
    });
  });
  // Kept behind the chunk (as seen from the default camera) so they never
  // pass right in front of the lens.
  const rocks = [
    { angle: 3.4, r: 11.5, s: 0.36, color: '#e7a9c0' },
    { angle: 3.9, r: 13, s: 0.26, color: '#b9a4e3' },
    { angle: 4.5, r: 11.8, s: 0.42, color: '#f2b49f' },
    { angle: 5.1, r: 13.5, s: 0.3, color: '#c9a3d6' },
    { angle: 2.7, r: 12.5, s: 0.24, color: '#e7a9c0' },
];
  return (
    <group ref={group}>
      {rocks.map((rock, i) => (
        <mesh key={i} position={[Math.cos(rock.angle) * rock.r, 0, Math.sin(rock.angle) * rock.r]} scale={rock.s} castShadow>
          <icosahedronGeometry args={[1, 2]} />
          <meshStandardMaterial color={rock.color} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

export function Sky() {
  return (
    <>
      <SkyDome />
      <Planet />
      <Clouds />
      <FloatingRocks />
    </>
  );
}
