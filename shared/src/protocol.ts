/**
 * Messages the event bridge (server) sends to browsers over WebSocket.
 */
import { isAgentEvent, type AgentEvent } from './events';

export const DEFAULT_BRIDGE_PORT = 4747;
export const BRIDGE_WS_PATH = '/ws';

export type ServerMessage =
  /** Sent once right after a browser connects. */
  | { type: 'hello'; server: 'groundcrew'; version: string }
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
    return { type: 'hello', server: 'groundcrew', version: msg.version };
  }
  if (msg.type === 'event' && isAgentEvent(msg.event)) {
    return { type: 'event', event: msg.event };
  }
  return null;
}
