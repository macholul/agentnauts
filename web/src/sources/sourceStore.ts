/**
 * Plain-data view of the event sources for the HUD: status, counters and the
 * simulator toggle. The sources themselves live in sourceManager.ts.
 */
import { create } from 'zustand';
import {
  cleanName,
  isUuid,
  isValidRoomCode,
  keyFingerprint,
  normalizeRoomCode,
  parsePairingHash,
  type PairingRequest,
} from '@agentnauts/shared';
import type { JoinedRoom, MyAgent } from './roomsApi';
import type { SourceState } from './types';

export interface SourceInfo {
  id: string;
  label: string;
  state: SourceState;
  detail: string | null;
  eventCount: number;
  lastEventAt: number | null;
}

const SIMULATOR_KEY = 'agentnauts.simulator';
const ROOM_KEY = 'agentnauts.room';
const NAME_KEY = 'agentnauts.name';
const DETAILS_KEY = 'agentnauts.shareDetails';

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

function readStoredRoom(): JoinedRoom | null {
  try {
    const value = JSON.parse(readStorage(ROOM_KEY) ?? 'null') as Partial<JoinedRoom> | null;
    if (value && isUuid(value.id) && typeof value.code === 'string' && isValidRoomCode(value.code)) {
      return {
        id: value.id,
        code: value.code,
        name: typeof value.name === 'string' ? value.name : value.code,
        owner: value.owner === true,
        status: value.status === 'member' ? 'member' : 'pending',
      };
    }
  } catch {
    // Ignore unreadable settings.
  }
  return null;
}

/** A room code from a `?room=` link, to pre-fill the join form. */
function readInviteCode(): string | null {
  const code = normalizeRoomCode(new URLSearchParams(window.location.search).get('room') ?? '');
  return isValidRoomCode(code) ? code : null;
}

/** What a daemon on this machine said about itself (local mode only). */
export interface BridgeIdentity {
  /** Daemon was built with a Supabase project configured. */
  cloud: boolean;
  /** Its public key: this computer's ID. */
  identity?: string;
}

const PAIRING_KEY = 'agentnauts.pairing';
/** A pairing request is kept this long while you sign in. */
const PAIRING_KEEP_MS = 15 * 60_000;

/**
 * A "connect this computer" request from the link the daemon prints
 * (`#connect=<key>`). Signing in by email link reloads the page without the
 * fragment, so the request is remembered in this browser for a few minutes.
 */
export function readPairing(): PairingRequest | null {
  const fromLink = parsePairingHash(window.location.hash);
  if (fromLink) {
    writeStorage(PAIRING_KEY, JSON.stringify({ ...fromLink, at: Date.now() }));
    return fromLink;
  }
  try {
    const saved = JSON.parse(readStorage(PAIRING_KEY) ?? 'null') as { key?: string; device?: string; at?: number } | null;
    if (saved && typeof saved.at === 'number' && Date.now() - saved.at < PAIRING_KEEP_MS) {
      return parsePairingHash(`#connect=${saved.key ?? ''}&device=${encodeURIComponent(saved.device ?? '')}`);
    }
  } catch {
    // Ignore unreadable settings.
  }
  return null;
}

/** Someone whose signed events we've verified in this room. */
export interface RoomPerson {
  /** Public key (base64url). */
  key: string;
  /** Short ID people can compare, e.g. "a3f9-c21e". */
  fingerprint: string;
  name: string;
  lastSeen: number;
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

  /** Your own room of one, where your computers send everything. */
  personalRoom: JoinedRoom | null;
  setPersonalRoom: (room: JoinedRoom | null) => void;
  /** Your computers and the rooms each publishes to (from the database). */
  agents: MyAgent[];
  setAgents: (agents: MyAgent[]) => void;
  /** A computer asking to be connected, from the link its daemon printed. */
  pairing: PairingRequest | null;
  setPairing: (pairing: PairingRequest | null) => void;

  /** Private room you're in (or waiting to be let into). */
  room: JoinedRoom | null;
  /** Room code from an invite link, to pre-fill the join form. */
  inviteCode: string | null;
  /** Display name shown to others in rooms. */
  name: string;
  roommates: Roommate[];
  /** When sharing with a room, also send project names, files and commands. */
  shareDetails: boolean;
  /** People whose agents we've seen in the room (signature-verified). */
  roomPeople: Record<string, RoomPerson>;
  /** What a daemon on this machine reported (local mode only). */
  bridgeIdentity: BridgeIdentity | null;
  /** Enter a room (created, requested or approved), or leave with null. */
  setRoom: (room: JoinedRoom | null) => void;
  setName: (name: string) => void;
  notePerson: (key: string, name: string, at: number) => void;
  setShareDetails: (share: boolean) => void;
  setRoommates: (roommates: Roommate[]) => void;
  setBridgeIdentity: (identity: BridgeIdentity) => void;
}

export const useSourceStore = create<SourceStoreState>()((set) => ({
  sources: {},
  simulatorEnabled: readSimulatorPreference(),
  room: readStoredRoom(),
  inviteCode: readInviteCode(),
  name: cleanName(readStorage(NAME_KEY) ?? ''),
  roommates: [],
  shareDetails: readStorage(DETAILS_KEY) === 'on',
  roomPeople: {},
  bridgeIdentity: null,
  personalRoom: null,
  agents: [],
  pairing: readPairing(),

  setPersonalRoom: (personalRoom) => set({ personalRoom }),
  setAgents: (agents) => set({ agents }),
  setPairing: (pairing) => {
    if (!pairing) writeStorage(PAIRING_KEY, null);
    set({ pairing });
  },

  setRoom: (room) => {
    writeStorage(ROOM_KEY, room ? JSON.stringify(room) : null);
    set((s) => ({
      room,
      inviteCode: room ? null : s.inviteCode,
      ...(!room ? { roommates: [] } : {}),
      ...(room?.id !== s.room?.id ? { roomPeople: {} } : {}),
    }));
  },

  setName: (name) => {
    const clean = cleanName(name);
    writeStorage(NAME_KEY, clean);
    set({ name: clean });
  },

  notePerson: (key, name, at) =>
    set((s) => {
      const prev = s.roomPeople[key];
      if (prev && prev.name === name && at - prev.lastSeen < 5000) return s;
      return { roomPeople: { ...s.roomPeople, [key]: { key, fingerprint: keyFingerprint(key), name, lastSeen: at } } };
    }),

  setShareDetails: (share) => {
    writeStorage(DETAILS_KEY, share ? 'on' : 'off');
    set({ shareDetails: share });
  },

  setRoommates: (roommates) => set({ roommates }),

  setBridgeIdentity: (identity) => set({ bridgeIdentity: identity }),

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
