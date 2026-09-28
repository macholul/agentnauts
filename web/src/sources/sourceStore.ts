/**
 * Plain-data view of the event sources for the HUD: status, counters and the
 * simulator toggle. The sources themselves live in sourceManager.ts.
 */
import { create } from 'zustand';
import { cleanName, isValidRoomCode } from '@groundcrew/shared';
import type { SourceState } from './types';

export interface SourceInfo {
  id: string;
  label: string;
  state: SourceState;
  detail: string | null;
  eventCount: number;
  lastEventAt: number | null;
}

const SIMULATOR_KEY = 'groundcrew.simulator';
const ROOM_KEY = 'groundcrew.room';
const NAME_KEY = 'groundcrew.name';
const DETAILS_KEY = 'groundcrew.shareDetails';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: settings last for this page load only.
  }
}

/** A `?room=` link wins over the remembered room. */
function readRoomPreference(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('room');
  if (fromUrl && isValidRoomCode(fromUrl)) return fromUrl;
  const stored = readStorage(ROOM_KEY);
  return stored && isValidRoomCode(stored) ? stored : null;
}

/** The local bridge's multiplayer state, from its hello message. */
export interface BridgeIdentity {
  /** Bridge was built with a Supabase project configured. */
  cloud: boolean;
  room?: string;
  name?: string;
  shareDetails?: boolean;
}

/** Someone else in the room, from Supabase presence. */
export interface Roommate {
  name: string;
  /** Presence key; unique per open browser tab. */
  key: string;
}

function readSimulatorPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(SIMULATOR_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  // On by default while developing, off in production builds.
  return import.meta.env.DEV;
}

interface SourceStoreState {
  sources: Record<string, SourceInfo>;
  simulatorEnabled: boolean;
  setSimulatorEnabled: (enabled: boolean) => void;
  upsertSource: (info: Pick<SourceInfo, 'id' | 'label'> & Partial<SourceInfo>) => void;
  countEvent: (id: string, at: number) => void;

  /** Multiplayer room this browser is watching (null = not in a room). */
  room: string | null;
  /** Display name shown to others in the room. */
  name: string;
  roommates: Roommate[];
  /** Also share file names / commands / queries with the room. */
  shareDetails: boolean;
  /** What the local bridge reported in its hello message. */
  bridgeIdentity: BridgeIdentity | null;
  joinRoom: (room: string, name: string) => void;
  leaveRoom: () => void;
  setShareDetails: (share: boolean) => void;
  setRoommates: (roommates: Roommate[]) => void;
  setBridgeIdentity: (identity: BridgeIdentity) => void;
}

export const useSourceStore = create<SourceStoreState>()((set) => ({
  sources: {},
  simulatorEnabled: readSimulatorPreference(),
  room: readRoomPreference(),
  name: cleanName(readStorage(NAME_KEY) ?? ''),
  roommates: [],
  shareDetails: readStorage(DETAILS_KEY) === 'on',
  bridgeIdentity: null,

  joinRoom: (room, name) => {
    if (!isValidRoomCode(room)) return;
    const clean = cleanName(name);
    writeStorage(ROOM_KEY, room);
    writeStorage(NAME_KEY, clean);
    set({ room, name: clean });
  },

  leaveRoom: () => {
    writeStorage(ROOM_KEY, null);
    set({ room: null, roommates: [] });
  },

  setShareDetails: (share) => {
    writeStorage(DETAILS_KEY, share ? 'on' : 'off');
    set({ shareDetails: share });
  },

  setRoommates: (roommates) => set({ roommates }),

  setBridgeIdentity: (identity) =>
    set((s) => {
      const first = s.bridgeIdentity === null;
      // On first contact, adopt the room the bridge remembers if the browser has none.
      const adopt = first && !s.room && identity.room && identity.name;
      return {
        bridgeIdentity: identity,
        ...(adopt ? { room: identity.room!, name: identity.name!, shareDetails: identity.shareDetails ?? false } : {}),
        name: s.name || identity.name || '',
      };
    }),

  setSimulatorEnabled: (enabled) => {
    try {
      window.localStorage.setItem(SIMULATOR_KEY, enabled ? 'on' : 'off');
    } catch {
      // Ignore: the toggle still works for this page load.
    }
    set({ simulatorEnabled: enabled });
  },

  upsertSource: (info) =>
    set((s) => {
      const prev = s.sources[info.id];
      const next: SourceInfo = {
        id: info.id,
        label: info.label,
        state: info.state ?? prev?.state ?? 'stopped',
        detail: info.detail !== undefined ? info.detail : (prev?.detail ?? null),
        eventCount: info.eventCount ?? prev?.eventCount ?? 0,
        lastEventAt: info.lastEventAt ?? prev?.lastEventAt ?? null,
      };
      return { sources: { ...s.sources, [info.id]: next } };
    }),

  countEvent: (id, at) =>
    set((s) => {
      const prev = s.sources[id];
      if (!prev) return s;
      return { sources: { ...s.sources, [id]: { ...prev, eventCount: prev.eventCount + 1, lastEventAt: at } } };
    }),
}));
