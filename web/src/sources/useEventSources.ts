import { useEffect } from 'react';
import { BridgeSource, sendBridgeToken, setBridgeRoom } from './bridge';
import { RoomSource } from './room';
import { myStatus } from './roomsApi';
import { attachSource } from './sourceManager';
import { SimulatorSource } from './simulator';
import { useSourceStore } from './sourceStore';
import { getSupabase, useAuthStore } from './supabase';

/** Starts and stops event sources for the app's lifetime. */
export function useEventSources(): void {
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);
  const room = useSourceStore((s) => s.room);
  const name = useSourceStore((s) => s.name);
  const user = useAuthStore((s) => s.user);
  const accessToken = useAuthStore((s) => s.accessToken);

  // Restore a saved sign-in, if any.
  useEffect(() => {
    getSupabase();
  }, []);

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

  // Multiplayer: everyone else's agents from the private room, once you're
  // signed in and the owner let you in. Leaving sends them home.
  const member = Boolean(user) && room?.status === 'member';
  const roomId = room?.id;
  useEffect(() => {
    const current = useSourceStore.getState().room;
    if (!member || !current || !name) {
      useSourceStore.getState().upsertSource({ id: 'room', label: 'Room', state: 'stopped' });
      return;
    }
    return attachSource(new RoomSource(current, name), { clearOnDetach: true });
  }, [member, roomId, name]);

  // Membership: notice when the owner lets you in, or removes you.
  useEffect(() => {
    if (!user || !roomId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await myStatus(roomId, user.id);
        if (cancelled) return;
        const store = useSourceStore.getState();
        const current = store.room;
        if (!current || current.id !== roomId) return;
        if (status === null) store.setRoom(null);
        else if (status !== current.status) store.setRoom({ ...current, status }, { share: status === 'member' });
      } catch {
        // Offline or signed out: try again next time.
      }
    };
    void check();
    const handle = window.setInterval(check, room?.status === 'pending' ? 4000 : 20000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [user, roomId, room?.status]);

  // Keep the local bridge in line with what you chose in this page: share
  // only after you joined (or confirmed resuming) here, stop when you stop,
  // and keep its short-lived access token fresh.
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const sharingWanted = useSourceStore((s) => s.sharingWanted);
  useEffect(() => {
    if (!bridgeConnected || !bridge?.cloud) return;
    const wanted =
      sharingWanted && member && room && name && accessToken
        ? { roomId: room.id, code: room.code, roomName: room.name, name, shareDetails, accessToken }
        : null;
    if (wanted) {
      const shared = bridge.room;
      const inSync = shared?.roomId === wanted.roomId && shared.name === wanted.name && shared.shareDetails === wanted.shareDetails;
      if (!inSync) void setBridgeRoom(wanted);
      else void sendBridgeToken(accessToken!);
    } else if (bridge.room) {
      void setBridgeRoom(null);
    }
  }, [bridgeConnected, bridge, member, room, name, shareDetails, sharingWanted, accessToken]);
}
