import { useEffect } from 'react';
import { BridgeSource } from './bridge';
import { attachSource } from './sourceManager';
import { SimulatorSource } from './simulator';
import { useSourceStore } from './sourceStore';

/** Starts and stops event sources for the app's lifetime. */
export function useEventSources(): void {
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);

  // Real Claude Code events via the local event bridge. Always on.
  useEffect(() => attachSource(new BridgeSource()), []);

  // Fake agents, toggled from the HUD. Turning it off sends them home.
  useEffect(() => {
    if (!simulatorEnabled) {
      useSourceStore.getState().upsertSource({ id: 'simulator', label: 'Simulator', state: 'stopped' });
      return;
    }
    return attachSource(new SimulatorSource(), { clearOnDetach: true });
  }, [simulatorEnabled]);
}
