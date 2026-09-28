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
  | { type: 'hello'; server: 'groundcrew'; version: string; room?: string; name?: string }
  /** A normalized agent event. */
  | { type: 'event'; event: AgentEvent };

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
      server: 'groundcrew',
      version: msg.version,
      ...(typeof msg.room === 'string' && isValidRoomCode(msg.room) ? { room: msg.room } : {}),
      ...(typeof msg.name === 'string' && msg.name ? { name: cleanName(msg.name) } : {}),
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

/** Realtime channel name for a room. */
export function roomTopic(room: string): string {
  return `groundcrew:${room.toLowerCase()}`;
}

/** Room codes double as the shared secret for public channels, so keep them long. */
export function isValidRoomCode(room: string): boolean {
  return /^[a-z0-9][a-z0-9-]{5,47}$/i.test(room);
}

/** Display names: trimmed, single-line, short. */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 24);
}

/** One agent event, published to a room by the bridge of the person who owns it. */
export interface RoomMessage {
  v: 1;
  /** Display name of the person whose agent produced the event. */
  owner: string;
  event: AgentEvent;
}

export function parseRoomMessage(payload: unknown): RoomMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const msg = payload as Record<string, unknown>;
  if (msg.v !== 1 || typeof msg.owner !== 'string' || !msg.owner.trim() || !isAgentEvent(msg.event)) return null;
  return { v: 1, owner: cleanName(msg.owner), event: msg.event };
}
