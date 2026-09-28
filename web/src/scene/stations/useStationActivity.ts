import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { StationId } from '@groundcrew/shared';
import { useAgentStore, type Agent } from '../../store/agentStore';

/**
 * A 0..1 ref that eases toward 1 while `isActive(agent)` holds for any
 * agent, and back to 0 otherwise. Read via getState() each frame, so the
 * station never re-renders because of it.
 */
export function useActivity(isActive: (agent: Agent) => boolean, rampUp = 3, rampDown = 1.5) {
  const activity = useRef(0);
  useFrame((_, delta) => {
    const agents = useAgentStore.getState().agents;
    let active = false;
    for (const id in agents) {
      const agent = agents[id];
      if (agent && agent.lifecycle === 'active' && isActive(agent)) {
        active = true;
        break;
      }
    }
    const target = active ? 1 : 0;
    const rate = active ? rampUp : rampDown;
    activity.current += (target - activity.current) * (1 - Math.exp(-rate * Math.min(delta, 0.1)));
  });
  return activity;
}

/** How busy a station is: someone is working at it. */
export function useStationActivity(station: StationId) {
  return useActivity((agent) => agent.state === 'working' && agent.station === station);
}

/** How busy the landing pad is: someone is waiting for the user. */
export function usePadActivity() {
  return useActivity((agent) => agent.state === 'waiting', 4, 2);
}
