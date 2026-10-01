import { useEffect } from 'react';
import { cleanName } from '@agentnauts/shared';
import { crewId, useAgentStore } from '../store/agentStore';
import { BridgeSource } from './bridge';
import { RoomSource } from './room';
import { myRoom, myStatus } from './roomsApi';
import { refreshAgents, shareInRoom } from './sharing';
import { attachSource } from './sourceManager';
import { SimulatorSource } from './simulator';
import { readPairing, useSourceStore } from './sourceStore';
import { getSupabase, useAuthStore } from './supabase';

/** Local mode: also read events straight from a daemon on this machine. */
const LOCAL_BRIDGE = import.meta.env.VITE_LOCAL_BRIDGE === '1';

const hasAgent = (sessionId: string, subagentId?: string) =>
  Boolean(useAgentStore.getState().agents[subagentId ? crewId(sessionId, subagentId) : sessionId]);

/** Starts and stops event sources for the app's lifetime. */
export function useEventSources(): void {
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);
  const room = useSourceStore((s) => s.room);
  const personalRoom = useSourceStore((s) => s.personalRoom);
  const name = useSourceStore((s) => s.name);
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;

  // Restore a saved sign-in, if any.
  useEffect(() => {
    getSupabase();
  }, []);

  useEffect(() => (LOCAL_BRIDGE ? attachSource(new BridgeSource()) : undefined), []);

  // A pairing link opened in a tab that already shows the app only changes
  // the fragment; the page doesn't reload.
  useEffect(() => {
    const onHashChange = () => {
      const pairing = readPairing();
      if (pairing) useSourceStore.getState().setPairing(pairing);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Fake agents, toggled from the HUD. Turning it off sends them home.
  useEffect(() => {
    if (!simulatorEnabled) {
      useSourceStore.getState().upsertSource({ id: 'simulator', label: 'Simulator', state: 'stopped' });
      return;
    }
    return attachSource(new SimulatorSource(), { clearOnDetach: true });
  }, [simulatorEnabled]);

  // Signed in: find (or create) your personal room, and keep the list of
  // your computers fresh. Keyed on the user id: the auth client reports the
  // same user again on every token refresh.
  useEffect(() => {
    const store = useSourceStore.getState();
    if (!userId) {
      store.setPersonalRoom(null);
      store.setAgents([]);
      return;
    }
    const email = useAuthStore.getState().user?.email ?? '';
    if (!store.name) store.setName(cleanName(email.split('@')[0] ?? '') || 'me');
    let cancelled = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        if (!useSourceStore.getState().personalRoom) {
          const mine = await myRoom(useSourceStore.getState().name);
          if (!cancelled) useSourceStore.getState().setPersonalRoom(mine);
        }
        if (!cancelled) await refreshAgents();
      } catch {
        // Offline: try again next time.
      } finally {
        loading = false;
      }
    };
    void load();
    const handle = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [userId]);

  // Your own computers' agents, through your personal room.
  const personalId = personalRoom?.id;
  useEffect(() => {
    const current = useSourceStore.getState().personalRoom;
    if (!userId || !current) {
      useSourceStore.getState().upsertSource({ id: 'personal', label: 'Your computers', state: 'stopped' });
      return;
    }
    return attachSource(new RoomSource(current, { id: 'personal', name: '', userId, hasAgent }), { clearOnDetach: true });
  }, [userId, personalId]);

  // Everyone else's agents from the shared room, once the owner let you in.
  // Leaving sends them home.
  const member = Boolean(user) && room?.status === 'member';
  const roomId = room?.id;
  useEffect(() => {
    const current = useSourceStore.getState().room;
    if (!member || !userId || !current || !name) {
      useSourceStore.getState().upsertSource({ id: 'room', label: 'Room', state: 'stopped' });
      return;
    }
    return attachSource(new RoomSource(current, { id: 'room', name, userId, hasAgent }), { clearOnDetach: true });
  }, [member, userId, roomId, name]);

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
        else if (status !== current.status) {
          store.setRoom({ ...current, status });
          // You asked to join and the owner let you in: your agents are shared from here on.
          if (status === 'member') void shareInRoom(roomId, store.shareDetails).catch(() => {});
        }
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
}
