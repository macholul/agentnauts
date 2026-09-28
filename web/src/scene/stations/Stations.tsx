import { useRef, type ComponentType } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, type MeshBasicMaterial } from 'three';
import type { StationId } from '@groundcrew/shared';
import { LANDING_PAD, STATIONS, type StationConfig } from '../../world/config';
import { Drill } from './Drill';
import { Fabricator } from './Fabricator';
import { LandingPad } from './LandingPad';
import { RadarDish } from './RadarDish';
import { Scanner } from './Scanner';
import type { ActivityRef, StationVisualProps } from './parts';
import { usePadActivity, useStationActivity } from './useStationActivity';

/** Visual component per station. Swap these for GLTF-backed ones later. */
const VISUALS: Record<StationId, ComponentType<StationVisualProps>> = {
  fabricator: Fabricator,
  scanner: Scanner,
  drill: Drill,
  radar: RadarDish,
};

/** Soft pulsing glow on the ground around a busy station. */
function GroundGlow({ radius, color, activity }: { radius: number; color: string; activity: ActivityRef }) {
  const material = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const a = activity.current ?? 0;
    if (material.current) material.current.opacity = a * (0.45 + Math.sin(clock.elapsedTime * 4) * 0.12);
  });
  return (
    <mesh position-y={0.115} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[radius - 0.05, radius + 0.35, 48]} />
      <meshBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={0}
        depthWrite={false}
        blending={AdditiveBlending}
        toneMapped={false}
      />
    </mesh>
  );
}

function StationMount({ config }: { config: StationConfig }) {
  const Visual = VISUALS[config.id];
  const activity = useStationActivity(config.id);
  return (
    <group position={config.position} rotation-y={config.yaw}>
      <Visual accent={config.accent} activity={activity} />
      <GroundGlow radius={config.footprint} color={config.accent} activity={activity} />
    </group>
  );
}

export function Stations() {
  const padActivity = usePadActivity();
  return (
    <>
      {Object.values(STATIONS).map((config) => (
        <StationMount key={config.id} config={config} />
      ))}
      <group position={LANDING_PAD.position}>
        <LandingPad activity={padActivity} />
      </group>
    </>
  );
}
