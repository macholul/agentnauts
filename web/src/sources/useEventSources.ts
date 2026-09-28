import { useEffect } from 'react';
import { BridgeSource, setBridgeRoom } from './bridge';
import { RoomSource, supabaseSettings } from './room';
import { attachSource } from './sourceManager';
import { SimulatorSource } from './simulator';
import { useSourceStore } from './sourceStore';

/** Starts and stops event sources for the app's lifetime. */
export function useEventSources(): void {
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);
  const room = useSourceStore((s) => s.room);
  const name = useSourceStore((s) => s.name);

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

  // Multiplayer: everyone else's agents from the shared room. Leaving sends them home.
  useEffect(() => {
    const settings = supabaseSettings();
    if (!settings || !room || !name) {
      useSourceStore.getState().upsertSource({ id: 'room', label: 'Room', state: 'stopped' });
      return;
    }
    return attachSource(new RoomSource(settings, room, name), { clearOnDetach: true });
  }, [room, name]);

  // Keep the local bridge in line with what you chose in this page: share
  // to the room only after you joined (or confirmed resuming) it here, and
  // stop when you stop.
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const sharingWanted = useSourceStore((s) => s.sharingWanted);
  useEffect(() => {
    if (!bridgeConnected || !bridge?.cloud) return;
    const wanted = sharingWanted && room && name ? { room, name, shareDetails } : null;
    if (wanted) {
      const inSync =
        bridge.room === wanted.room && bridge.name === wanted.name && (bridge.shareDetails ?? false) === wanted.shareDetails;
      if (!inSync) void setBridgeRoom(wanted);
    } else if (bridge.room) {
      void setBridgeRoom(null);
    }
  }, [bridgeConnected, bridge, room, name, shareDetails, sharingWanted]);
}
