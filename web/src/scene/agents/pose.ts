/**
 * The contract between an agent's behavior (AgentActor) and its visual
 * (Astronaut). The actor writes a pose every frame; the visual reads it and
 * animates however it likes. A future GLTF astronaut only needs to map these
 * modes to animation clips.
 */
import type { StationId } from '@groundcrew/shared';

export type PoseMode = 'idle' | 'walk' | 'work' | 'wait' | 'fly';

export interface AstronautPose {
  mode: PoseMode;
  /** 0..1 how fast we're moving relative to full walking speed. */
  speed: number;
  /** Head turn (radians) for looking around while idle. */
  look: number;
  /** Station being worked at, so the visual can pick a matching motion. */
  station: StationId | null;
  /** 0..1 jetpack thrust (arriving / leaving). */
  thrust: number;
  /** Landing squash impulse, decays to 0. */
  squash: number;
}

export function createPose(): AstronautPose {
  return { mode: 'idle', speed: 0, look: 0, station: null, thrust: 0, squash: 0 };
}
