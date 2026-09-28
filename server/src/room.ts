/**
 * Multiplayer: forward this machine's normalized events to a shared room on
 * Supabase Realtime (broadcast). Everyone watching that room in the web app
 * sees your astronauts next to theirs.
 *
 * Sending uses Realtime's REST broadcast (`channel.httpSend`), so the bridge
 * never holds a socket open to Supabase and nothing is stored in a database.
 */
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import {
  ROOM_EVENT,
  cleanName,
  isValidRoomCode,
  roomTopic,
  type AgentEvent,
  type RoomMessage,
} from '@groundcrew/shared';

export interface RoomConfig {
  url: string;
  key: string;
  room: string;
  name: string;
  /** Include file names / commands / queries. Off by default for privacy. */
  shareDetails: boolean;
}

/**
 * Read room settings from the environment. Returns null when multiplayer is
 * off, plus a problem description when it's half-configured.
 */
export function roomConfigFromEnv(env: NodeJS.ProcessEnv): { config: RoomConfig | null; problem?: string } {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_ANON_KEY?.trim();
  const room = env.GROUNDCREW_ROOM?.trim();
  const name = cleanName(env.GROUNDCREW_NAME ?? '');
  if (!room) return { config: null };
  if (!url || !key) return { config: null, problem: 'GROUNDCREW_ROOM is set but SUPABASE_URL / SUPABASE_ANON_KEY are missing' };
  if (!isValidRoomCode(room)) {
    return { config: null, problem: 'GROUNDCREW_ROOM must be 6-48 letters, digits or dashes' };
  }
  if (!name) return { config: null, problem: 'GROUNDCREW_NAME is required so others know whose agents are whose' };
  return { config: { url, key, room, name, shareDetails: env.GROUNDCREW_SHARE_DETAILS === '1' } };
}

/** What actually leaves the machine for one event. Pure, for testing. */
export function toRoomMessage(event: AgentEvent, config: Pick<RoomConfig, 'name' | 'shareDetails'>): RoomMessage {
  const { detail, ...rest } = event;
  return {
    v: 1,
    owner: config.name,
    event: config.shareDetails && detail ? { ...rest, detail } : rest,
  };
}

export interface RoomForwarder {
  forward(event: AgentEvent): void;
  close(): Promise<void>;
}

export function createRoomForwarder(config: RoomConfig, log: (...args: unknown[]) => void): RoomForwarder {
  const supabase = createClient(config.url, config.key, { auth: { persistSession: false } });
  const channel: RealtimeChannel = supabase.channel(roomTopic(config.room));
  let failures = 0;

  return {
    forward(event) {
      const message = toRoomMessage(event, config);
      // Fire and forget: a slow or unreachable Supabase must never delay hooks.
      channel
        .httpSend(ROOM_EVENT, message, { timeout: 5000 })
        .then((result) => {
          if (result.success) {
            if (failures > 0) log(`[room] sending again after ${failures} failed attempt(s)`);
            failures = 0;
            return;
          }
          failures++;
          if (failures === 1 || failures % 50 === 0) {
            log(`[room] broadcast failed (${result.status}): ${result.error}`);
          }
        })
        .catch((error: unknown) => {
          failures++;
          if (failures === 1 || failures % 50 === 0) log(`[room] broadcast failed: ${(error as Error).message}`);
        });
    },
    async close() {
      await supabase.removeChannel(channel);
    },
  };
}
