import { useEffect } from 'react';
import { attachSource } from './sourceManager';
import { SimulatorSource } from './simulator';
import { useSourceStore } from './sourceStore';

/** Starts and stops event sources for the app's lifetime. */
export function useEventSources(): void {
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);

  // Fake agents, toggled from the HUD. Turning it off sends them home.
  useEffect(() => {
    if (!simulatorEnabled) {
      useSourceStore.getState().upsertSource({ id: 'simulator', label: 'Simulator', state: 'stopped' });
      return;
    }
    return attachSource(new SimulatorSource(), { clearOnDetach: true });
  }, [simulatorEnabled]);
}
