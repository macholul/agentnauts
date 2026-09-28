import { useEffect } from 'react';
import { useAgentStore } from './agentStore';

/** Drives the store's timers (idle timeout, wandering, stale sessions). */
export function useAgentClock(intervalMs = 250): void {
  useEffect(() => {
    const handle = window.setInterval(() => useAgentStore.getState().tick(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
}
