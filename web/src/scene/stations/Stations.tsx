import { useRef, type ComponentType } from 'react';
import type { StationId } from '@groundcrew/shared';
import { LANDING_PAD, STATIONS, type StationConfig } from '../../world/config';
import { Drill } from './Drill';
import { Fabricator } from './Fabricator';
import { LandingPad } from './LandingPad';
import { RadarDish } from './RadarDish';
import { Scanner } from './Scanner';
import type { StationVisualProps } from './parts';

/** Visual component per station. Swap these for GLTF-backed ones later. */
const VISUALS: Record<StationId, ComponentType<StationVisualProps>> = {
  fabricator: Fabricator,
  scanner: Scanner,
  drill: Drill,
  radar: RadarDish,
};

function StationMount({ config }: { config: StationConfig }) {
  const Visual = VISUALS[config.id];
  const activity = useRef(0);
  return (
    <group position={config.position} rotation-y={config.yaw}>
      <Visual accent={config.accent} activity={activity} />
    </group>
  );
}

export function Stations() {
  const padActivity = useRef(0);
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
