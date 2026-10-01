/**
 * Messages the event bridge (server) sends to browsers over WebSocket.
 */
import { isAgentEvent, type AgentEvent } from './events';

export const DEFAULT_BRIDGE_PORT = 4747;
export const BRIDGE_WS_PATH = '/ws';

export type ServerMessage =
  /**
   * Sent once right after a browser connects. `room` / `name` are set when
   * the bridge is forwarding this machine's events to a multiplayer room.
   */
  | {
      type: 'hello';
      server: 'agentnauts';
      version: string;
      /** Whether this build has a multiplayer (Supabase) project configured. */
      cloud?: boolean;
      /** Room the bridge is sharing to right now (only after you said so). */
      room?: BridgeRoom;
      /** Room remembered from last time, waiting for you to resume it. */
      resumable?: BridgeRoom;
      /** Sharing, but the access token expired: open the app to refresh it. */
      needsToken?: boolean;
      /** This bridge's public key (its multiplayer identity). */
      identity?: string;
    }
  /** A normalized agent event. */
  | { type: 'event'; event: AgentEvent };

/**
 * A room as the bridge knows it. The id is what access control and the
 * Realtime channel use; the code is what people type to ask to join.
 */
export interface BridgeRoom {
  roomId: string;
  code: string;
  /** Room's display name. */
  roomName: string;
  /** Your display name in that room. */
  name: string;
  shareDetails: boolean;
}

/** Body of PUT /room on the bridge: a room plus a short-lived access token. */
export interface BridgeRoomRequest extends BridgeRoom {
  /** Supabase access token (JWT) of the signed-in user. Never the refresh token. */
  accessToken: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function parseBridgeRoom(value: unknown): BridgeRoom | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!isUuid(v.roomId) || typeof v.code !== 'string' || !isValidRoomCode(v.code)) return null;
  const name = typeof v.name === 'string' ? cleanName(v.name) : '';
  const roomName = typeof v.roomName === 'string' ? v.roomName.trim().slice(0, 40) : '';
  if (!name) return null;
  return { roomId: v.roomId, code: v.code, roomName: roomName || v.code, name, shareDetails: v.shareDetails === true };
}

export function parseBridgeRoomRequest(value: unknown): BridgeRoomRequest | null {
  const room = parseBridgeRoom(value);
  const token = (value as { accessToken?: unknown } | null)?.accessToken;
  if (!room || typeof token !== 'string' || token.length < 20 || token.length > 8192) return null;
  return { ...room, accessToken: token };
}

/** Parse and validate a raw WebSocket message. Returns null if it isn't one of ours. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type === 'hello' && typeof msg.version === 'string') {
    return {
      type: 'hello',
      server: 'agentnauts',
      version: msg.version,
      ...(typeof msg.cloud === 'boolean' ? { cloud: msg.cloud } : {}),
      ...(parseBridgeRoom(msg.room) ? { room: parseBridgeRoom(msg.room)! } : {}),
      ...(parseBridgeRoom(msg.resumable) ? { resumable: parseBridgeRoom(msg.resumable)! } : {}),
      ...(msg.needsToken === true ? { needsToken: true } : {}),
      ...(typeof msg.identity === 'string' && BASE64URL.test(msg.identity) ? { identity: msg.identity } : {}),
    };
  }
  if (msg.type === 'event' && isAgentEvent(msg.event)) {
    return { type: 'event', event: msg.event };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Multiplayer rooms (Supabase Realtime broadcast)
// ---------------------------------------------------------------------------

/** Broadcast event name used on room channels. */
export const ROOM_EVENT = 'agent_event';

/** Realtime channel name for a room (by id; access rules match on it). */
export function roomTopic(roomId: string): string {
  return `agentnauts:${roomId}`;
}

/** Characters used in room codes: no 0/o, 1/l/i to keep them easy to read aloud. */
export const ROOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_CODE_PATTERN = /^crew(-[abcdefghjkmnpqrstuvwxyz23456789]{4}){3}$/;

/**
 * Room codes are what people type to ask to join a room (the owner still
 * has to let them in). Only generated ones are accepted:
 * `crew-xxxx-xxxx-xxxx`, 12 random characters (~59 bits).
 */
export function isValidRoomCode(room: string): boolean {
  return ROOM_CODE_PATTERN.test(room);
}

/** Make a room code from a source of random 32-bit values, e.g. `(n) => crypto.getRandomValues(new Uint32Array(n))`. */
export function generateRoomCode(randomValues: (count: number) => ArrayLike<number>): string {
  const values = Array.from(randomValues(12));
  const chars = values.map((v) => ROOM_CODE_ALPHABET[v % ROOM_CODE_ALPHABET.length]).join('');
  return `crew-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/**
 * Tolerate pasted codes with stray spaces or capitals, and pull the code out
 * of a pasted invite link (`http://localhost:5173/?room=crew-…`).
 */
export function normalizeRoomCode(input: string): string {
  const lower = input.trim().toLowerCase();
  return lower.match(/crew(-[a-z0-9]{4}){3}/)?.[0] ?? lower;
}

/** Display names: trimmed, single-line, short. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 24);
}

// --- Signed messages ---------------------------------------------------------
//
// Each bridge has an Ed25519 key pair (created once, kept on that machine).
// Every event it publishes is signed, and browsers drop anything whose
// signature doesn't check out. The public key is the person's identity; its
// short fingerprint (e.g. "a3f9-c21e") is what people compare.

/** What a bridge signs. Serialized to a string before signing so every
 * receiver verifies exactly the bytes that were signed. */
export interface SignedRoomContent {
  /** Room id the message is for (a signed message can't be replayed elsewhere). */
  room: string;
  /** Display name of the sender. */
  owner: string;
  /** Sender's Ed25519 public key, base64url (32 bytes raw). */
  key: string;
  event: AgentEvent;
}

/** What actually goes over the wire. */
export interface RoomEnvelope {
  v: 2;
  /** JSON of SignedRoomContent, exactly as signed. */
  data: string;
  /** Ed25519 signature of `data` (UTF-8), base64url. */
  sig: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function parseRoomEnvelope(payload: unknown): RoomEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const msg = payload as Record<string, unknown>;
  if (msg.v !== 2 || typeof msg.data !== 'string' || typeof msg.sig !== 'string') return null;
  if (msg.data.length > 20_000 || !BASE64URL.test(msg.sig)) return null;
  return { v: 2, data: msg.data, sig: msg.sig };
}

/** Parse the signed content (only call this after the signature checked out). */
export function parseSignedContent(data: string): SignedRoomContent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.room !== 'string' || typeof v.owner !== 'string' || typeof v.key !== 'string') return null;
  if (!BASE64URL.test(v.key) || v.key.length !== 43 || !cleanName(v.owner) || !isAgentEvent(v.event)) return null;
  return { room: v.room, owner: cleanName(v.owner), key: v.key, event: v.event };
}

/** Decode base64url to bytes (works in browsers and Node without Buffer). */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = alphabet.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Short, human-comparable fingerprint of a public key, e.g. "a3f9-c21e". */
export function keyFingerprint(key: string): string {
  const hex = Array.from(base64UrlToBytes(key).slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}
