/**
 * Messages the event bridge (server) sends to browsers over WebSocket.
 */
import { isAgentEvent, type AgentEvent } from './events';

export const DEFAULT_BRIDGE_PORT = 4747;
export const BRIDGE_WS_PATH = '/ws';

export type ServerMessage =
  /** Sent once right after a browser connects (local mode only). */
  | {
      type: 'hello';
      server: 'agentnauts';
      version: string;
      /** Whether this build has a Supabase project configured. */
      cloud?: boolean;
      /** This computer's public key (its ID in rooms). */
      identity?: string;
    }
  /** A normalized agent event. */
  | { type: 'event'; event: AgentEvent };

/** How one room gets this computer's events: under which name, and with how much detail. */
export interface RoomSharing {
  roomId: string;
  /** The person's display name in that room. */
  name: string;
  /** Also send project names, files and commands. */
  shareDetails: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
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
      ...(typeof msg.identity === 'string' && KEY.test(msg.identity) ? { identity: msg.identity } : {}),
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
/**
 * Broadcast every few seconds with the agents a computer has right now, so
 * a page that opens later can show them without waiting for their next move.
 */
export const ROOM_SNAPSHOT = 'agent_snapshot';

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

// --- Agent credentials ---------------------------------------------------------
//
// A daemon never holds its owner's account session. It proves it owns its
// key by signing this message; the agent-auth Edge Function answers with a
// send-only token for each room that key is connected to.

/** What a daemon signs to authenticate. Must match proofMessage() in supabase/functions/agent-auth. */
export function agentAuthMessage(publicKey: string, timestamp: number): string {
  return `agentnauts-agent-auth:${publicKey}:${timestamp}`;
}

/**
 * What a daemon signs to disconnect itself from every room. A different
 * message, so a captured sign-in proof can't be replayed as a disconnect.
 * Must match disconnectMessage() in supabase/functions/agent-auth.
 */
export function agentDisconnectMessage(publicKey: string, timestamp: number): string {
  return `agentnauts-agent-disconnect:${publicKey}:${timestamp}`;
}

/** One room this computer publishes to, with its current send-only token. */
export interface AgentConnection {
  agentId: string;
  roomId: string;
  roomName: string;
  /** The owner's own room (gets full details). */
  personal: boolean;
  /** The person's display name in that room. */
  name: string;
  shareDetails: boolean;
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function parseAgentConnections(value: unknown): AgentConnection[] | null {
  const list = (value as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) return null;
  const out: AgentConnection[] = [];
  for (const item of list) {
    const v = item as Record<string, unknown> | null;
    if (!v || !isUuid(v.agentId) || !isUuid(v.roomId) || typeof v.token !== 'string' || typeof v.expiresAt !== 'number') continue;
    out.push({
      agentId: v.agentId,
      roomId: v.roomId,
      roomName: typeof v.roomName === 'string' ? v.roomName.slice(0, 40) : '',
      personal: v.personal === true,
      name: typeof v.name === 'string' ? cleanName(v.name) : '',
      shareDetails: v.shareDetails === true,
      token: v.token,
      expiresAt: v.expiresAt,
    });
  }
  return out;
}

// --- Pairing -------------------------------------------------------------------
//
// To connect a computer, its daemon prints a link to the app that carries
// the computer's public key. The signed-in page shows the key's short ID to
// compare with the terminal, and registers the key for a room. The key is in
// the URL fragment, so it is never sent to the web server.

export interface PairingRequest {
  /** The computer's Ed25519 public key, base64url. */
  key: string;
  /** Suggested name for the computer; the person can change it. */
  device: string;
}

/** Computer names: single-line, short. */
export function cleanDeviceName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function pairingLink(appUrl: string, request: PairingRequest): string {
  const device = encodeURIComponent(cleanDeviceName(request.device));
  return `${appUrl.replace(/\/+$/, '')}/#connect=${request.key}&device=${device}`;
}

/** Read a pairing request from a URL fragment (`location.hash`), or null. */
export function parsePairingHash(hash: string): PairingRequest | null {
  const params = new Map<string, string>();
  for (const part of hash.replace(/^#/, '').split('&')) {
    const [name, value = ''] = part.split('=');
    try {
      if (name) params.set(name, decodeURIComponent(value));
    } catch {
      // Not valid percent-encoding: ignore that part.
    }
  }
  const key = params.get('connect') ?? '';
  if (!KEY.test(key)) return null;
  return { key, device: cleanDeviceName(params.get('device') ?? '') };
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

/**
 * What actually goes over the wire.
 *
 * The content is base64url text, not readable JSON: it carries file names
 * and shell commands, and the gateway in front of Supabase refuses requests
 * whose text looks like an attack (a piped shell command, a SQL statement).
 */
export interface RoomEnvelope {
  v: 3;
  /** JSON of SignedRoomContent or SignedRoomSnapshot, UTF-8, as base64url. */
  data: string;
  /** Ed25519 signature of `data` (the base64url text), base64url. */
  sig: string;
}

/** Envelope version this build sends and understands. */
export const ENVELOPE_VERSION = 3;

/** Like SignedRoomContent, for a snapshot of several agents at once. */
export interface SignedRoomSnapshot {
  room: string;
  owner: string;
  key: string;
  events: AgentEvent[];
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** An Ed25519 public key: 32 bytes as base64url. */
const KEY = /^[A-Za-z0-9_-]{43}$/;

export function parseRoomEnvelope(payload: unknown): RoomEnvelope | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const msg = payload as Record<string, unknown>;
  if (msg.v !== ENVELOPE_VERSION || typeof msg.data !== 'string' || typeof msg.sig !== 'string') return null;
  if (msg.data.length > 300_000 || !BASE64URL.test(msg.data) || !BASE64URL.test(msg.sig)) return null;
  return { v: ENVELOPE_VERSION, data: msg.data, sig: msg.sig };
}

/** Parse the decoded content of an envelope (trust it only once the signature checked out). */
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
  if (!KEY.test(v.key) || !cleanName(v.owner) || !isAgentEvent(v.event)) return null;
  return { room: v.room, owner: cleanName(v.owner), key: v.key, event: v.event };
}

/** Parse the decoded content of a snapshot envelope (trust it only once the signature checked out). */
export function parseSignedSnapshot(data: string): SignedRoomSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.room !== 'string' || typeof v.owner !== 'string' || typeof v.key !== 'string') return null;
  if (!KEY.test(v.key) || !cleanName(v.owner) || !Array.isArray(v.events) || v.events.length > 200) return null;
  return { room: v.room, owner: cleanName(v.owner), key: v.key, events: v.events.filter(isAgentEvent) };
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
