/**
 * Plain-data view of the event sources for the HUD: status, counters and the
 * simulator toggle. The sources themselves live in sourceManager.ts.
 */
import { create } from 'zustand';
import { cleanName, isUuid, isValidRoomCode, keyFingerprint, normalizeRoomCode, type BridgeRoom } from '@groundcrew/shared';
import type { JoinedRoom } from './roomsApi';
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

/** The local bridge's multiplayer state, from its hello message. */
export interface BridgeIdentity {
  /** Bridge was built with a Supabase project configured. */
  cloud: boolean;
  /** Room the bridge is sharing to right now. */
  room?: BridgeRoom;
  /** Room remembered from before a restart, not shared until you resume it. */
  resumable?: BridgeRoom;
  /** Sharing, but its access token expired. */
  needsToken?: boolean;
  /** Bridge's public key: your identity in rooms. */
  identity?: string;
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

  /** Private room you're in (or waiting to be let into). */
  room: JoinedRoom | null;
  /** Room code from an invite link, to pre-fill the join form. */
  inviteCode: string | null;
  /** Display name shown to others in rooms. */
  name: string;
  roommates: Roommate[];
  /** Also share project names, files and commands with the room. */
  shareDetails: boolean;
  /**
   * You said "share my agents" in this page session. Never persisted, so
   * sharing only ever resumes after a restart when you confirm it.
   */
  sharingWanted: boolean;
  /** People whose agents we've seen in the room (signature-verified). */
  roomPeople: Record<string, RoomPerson>;
  /** What the local bridge reported in its hello message. */
  bridgeIdentity: BridgeIdentity | null;
  /** Enter a room (created, requested or approved); `share` starts sharing once you're a member. */
  setRoom: (room: JoinedRoom | null, options?: { share?: boolean; shareDetails?: boolean }) => void;
  setName: (name: string) => void;
  /** Share (true) or stop sharing (false) your agents in the current room. */
  setSharing: (share: boolean) => void;
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
  sharingWanted: false,
  roomPeople: {},
  bridgeIdentity: null,

  setRoom: (room, options = {}) => {
    writeStorage(ROOM_KEY, room ? JSON.stringify(room) : null);
    if (options.shareDetails !== undefined) writeStorage(DETAILS_KEY, options.shareDetails ? 'on' : 'off');
    set((s) => ({
      room,
      inviteCode: room ? null : s.inviteCode,
      ...(options.share !== undefined ? { sharingWanted: options.share } : {}),
      ...(!room ? { sharingWanted: false, roommates: [] } : {}),
      ...(options.shareDetails !== undefined ? { shareDetails: options.shareDetails } : {}),
      ...(room?.id !== s.room?.id ? { roomPeople: {} } : {}),
    }));
  },

  setName: (name) => {
    const clean = cleanName(name);
    writeStorage(NAME_KEY, clean);
    set({ name: clean });
  },

  setSharing: (share) => set({ sharingWanted: share }),

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

  setBridgeIdentity: (identity) =>
    set((s) => {
      // If the bridge is already sharing (you confirmed earlier and it kept
      // running), show that room here. A merely remembered room is NOT
      // adopted: the panel asks you first.
      const sharing = identity.room;
      const adopt = s.bridgeIdentity === null && sharing && (!s.room || s.room.id === sharing.roomId);
      // The bridge was sharing and now reports it isn't: it restarted. Even
      // with this page still open, sharing again needs a fresh "yes".
      const restarted = Boolean(s.bridgeIdentity?.room) && !identity.room;
      return {
        bridgeIdentity: identity,
        ...(restarted ? { sharingWanted: false } : {}),
        ...(adopt
          ? {
              room: s.room ?? { id: sharing.roomId, code: sharing.code, name: sharing.roomName, owner: false, status: 'member' as const },
              name: s.name || sharing.name,
              shareDetails: sharing.shareDetails,
              sharingWanted: true,
            }
          : {}),
        name: s.name || identity.room?.name || identity.resumable?.name || '',
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
