/**
 * Multiplayer: forward this machine's normalized events to a shared room on
 * Supabase Realtime (broadcast). Everyone watching that room in the web app
 * sees your astronauts next to theirs.
 *
 * The room is normally chosen in the web app (which tells the bridge via
 * PUT /room) and remembered in ~/.groundcrew/room.json across restarts.
 * GROUNDCREW_ROOM / GROUNDCREW_NAME env vars still work as a fixed override.
 *
 * Sending uses Realtime's REST broadcast (`channel.httpSend`), so the bridge
 * never holds a socket open to Supabase and nothing is stored in a database.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import {
  ROOM_EVENT,
  cleanName,
  isValidRoomCode,
  resolveCloud,
  roomTopic,
  type AgentEvent,
  type CloudSettings,
  type RoomMessage,
} from '@groundcrew/shared';

/** Which room this bridge shares to, and as whom. */
export interface RoomSettings {
  room: string;
  name: string;
  /** Include file names / commands / queries. Off by default for privacy. */
  shareDetails: boolean;
}

/** Validate untrusted room settings (from the web app or a file). */
export function parseRoomSettings(input: unknown): RoomSettings | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.room !== 'string' || !isValidRoomCode(v.room)) return null;
  const name = typeof v.name === 'string' ? cleanName(v.name) : '';
  if (!name) return null;
  return { room: v.room, name, shareDetails: v.shareDetails === true };
}

/** Room settings from GROUNDCREW_ROOM / GROUNDCREW_NAME, if set. */
export function roomSettingsFromEnv(env: NodeJS.ProcessEnv): { settings: RoomSettings | null; problem?: string } {
  const room = env.GROUNDCREW_ROOM?.trim();
  if (!room) return { settings: null };
  const settings = parseRoomSettings({
    room,
    name: env.GROUNDCREW_NAME ?? '',
    shareDetails: env.GROUNDCREW_SHARE_DETAILS === '1',
  });
  if (!settings) {
    return { settings: null, problem: 'GROUNDCREW_ROOM needs 6-48 letters/digits/dashes and GROUNDCREW_NAME must be set' };
  }
  return { settings };
}

/** What actually leaves the machine for one event. Pure, for testing. */
export function toRoomMessage(event: AgentEvent, settings: Pick<RoomSettings, 'name' | 'shareDetails'>): RoomMessage {
  const { detail, ...rest } = event;
  return {
    v: 1,
    owner: settings.name,
    event: settings.shareDetails && detail ? { ...rest, detail } : rest,
  };
}

export const ROOM_FILE = join(homedir(), '.groundcrew', 'room.json');

function loadSavedRoom(file: string): RoomSettings | null {
  try {
    return parseRoomSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export interface RoomManagerOptions {
  env: NodeJS.ProcessEnv;
  log: (...args: unknown[]) => void;
  /** Where the chosen room is remembered (tests pass a temp path). */
  file?: string;
}

/**
 * Holds the current room and forwards events to it. The room can change at
 * runtime; `onChange` lets the server tell connected browsers.
 */
export class RoomManager {
  readonly cloud: CloudSettings | null;
  /** Set when env vars pin the room; the web app can't change it then. */
  readonly pinned: boolean;
  private settings: RoomSettings | null;
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private failures = 0;
  private readonly file: string;
  private readonly log: (...args: unknown[]) => void;
  private listeners = new Set<() => void>();

  constructor({ env, log, file = ROOM_FILE }: RoomManagerOptions) {
    this.log = log;
    this.file = file;
    this.cloud = resolveCloud(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    const fromEnv = roomSettingsFromEnv(env);
    if (fromEnv.problem) log(`[room] ignoring env room: ${fromEnv.problem}`);
    this.pinned = fromEnv.settings !== null;
    this.settings = fromEnv.settings ?? loadSavedRoom(file);
  }

  get current(): RoomSettings | null {
    return this.cloud ? this.settings : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Switch rooms (or stop sharing with null). Returns false if pinned by env. */
  set(settings: RoomSettings | null): boolean {
    if (this.pinned) return false;
    const same =
      settings?.room === this.settings?.room &&
      settings?.name === this.settings?.name &&
      settings?.shareDetails === this.settings?.shareDetails;
    if (same) return true;
    this.settings = settings;
    this.resetChannel();
    try {
      if (settings) {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(settings, null, 2));
      } else {
        rmSync(this.file, { force: true });
      }
    } catch (error) {
      this.log(`[room] could not remember room: ${(error as Error).message}`);
    }
    this.log(settings ? `[room] sharing as "${settings.name}" in room "${settings.room}"` : '[room] stopped sharing');
    for (const listener of this.listeners) listener();
    return true;
  }

  forward(event: AgentEvent): void {
    const settings = this.current;
    if (!settings || !this.cloud) return;
    this.supabase ??= createClient(this.cloud.url, this.cloud.key, { auth: { persistSession: false } });
    this.channel ??= this.supabase.channel(roomTopic(settings.room));
    const message = toRoomMessage(event, settings);
    // Fire and forget: a slow or unreachable Supabase must never delay hooks.
    this.channel
      .httpSend(ROOM_EVENT, message, { timeout: 5000 })
      .then((result) => {
        if (result.success) {
          if (this.failures > 0) this.log(`[room] sending again after ${this.failures} failed attempt(s)`);
          this.failures = 0;
        } else {
          this.fail(`${result.status}: ${result.error}`);
        }
      })
      .catch((error: unknown) => this.fail((error as Error).message));
  }

  async close(): Promise<void> {
    this.resetChannel();
  }

  private fail(reason: string): void {
    this.failures++;
    if (this.failures === 1 || this.failures % 50 === 0) this.log(`[room] broadcast failed (${reason})`);
  }

  private resetChannel(): void {
    if (this.channel && this.supabase) void this.supabase.removeChannel(this.channel);
    this.channel = null;
  }
}
