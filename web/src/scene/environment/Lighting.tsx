import { Environment, Lightformer } from '@react-three/drei';
import { PALETTE } from '../../world/config';

/**
 * Soft, warm key light with lavender fill so shadows are never pure black.
 * A tiny baked environment (no network fetch) gives glossy parts such as
 * helmet visors something pastel to reflect.
 */
export function Lighting() {
  return (
    <>
      <hemisphereLight args={['#fff1e3', PALETTE.shadowTint, 1.1]} />
      <ambientLight color="#c9b8ee" intensity={0.35} />
      <directionalLight
        color={PALETTE.sunlight}
        intensity={2.8}
        position={[-8, 26, 16]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={4}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-camera-near={1}
        shadow-camera-far={80}
      />
      {/* Cool rim light from behind for chunky silhouettes. */}
      <directionalLight color="#b7c8ff" intensity={0.6} position={[10, 6, -12]} />

      <Environment resolution={64} frames={1} environmentIntensity={0.45}>
        <color attach="background" args={[PALETTE.skyMid]} />
        <Lightformer form="rect" intensity={2.2} color="#fff3e6" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} />
        <Lightformer form="rect" intensity={1.2} color={PALETTE.skyHorizon} position={[6, 1, 4]} target={[0, 0, 0]} scale={[8, 3, 1]} />
        <Lightformer form="rect" intensity={1.0} color={PALETTE.skyZenith} position={[-6, 2, -4]} target={[0, 0, 0]} scale={[8, 4, 1]} />
        <Lightformer form="rect" intensity={0.8} color={PALETTE.shadowTint} position={[0, -5, 0]} rotation-x={-Math.PI / 2} scale={[10, 10, 1]} />
      </Environment>
    </>
  );
}
