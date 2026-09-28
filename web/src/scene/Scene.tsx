import { Canvas } from '@react-three/fiber';
import { NeutralToneMapping } from 'three';
import { CAMERA, PALETTE } from '../world/config';
import { CameraRig } from './CameraRig';
import { Lighting } from './environment/Lighting';
import { Sky } from './environment/Sky';
import { Decorations } from './terrain/Decorations';
import { TerrainChunk } from './terrain/TerrainChunk';
import { Stations } from './stations/Stations';

/**
 * The 3D world. It only reads from the agent store; it never knows where
 * events come from.
 */
export function Scene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: CAMERA.fov, near: 0.5, far: 1200, position: [20, 18, 20] }}
      gl={{ antialias: true, toneMapping: NeutralToneMapping, toneMappingExposure: 1.0 }}
    >
      <fog attach="fog" args={[PALETTE.skyLow, 70, 260]} />
      <CameraRig />
      <Lighting />
      <Sky />
      <TerrainChunk />
      <Decorations />
      <Stations />
    </Canvas>
  );
}
