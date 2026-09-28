/**
 * Multiplayer: forward this machine's normalized events to a private room on
 * Supabase Realtime. Only members the room owner approved can read or post
 * there (row level security, see supabase/migrations).
 *
 * Privacy rules enforced here:
 * - Nothing is shared until you join a room in the web app (PUT /room).
 * - The bridge only ever holds a short-lived access token for your account,
 *   handed over by the web app and refreshed while it's open. It never sees
 *   your refresh token, and keeps the token in memory only.
 * - A remembered room is NOT resumed automatically after a restart; the web
 *   app asks you first.
 * - By default only tool names and states leave the machine: file names,
 *   commands, queries and project folder names are replaced or removed.
 * - Every message is signed with this machine's key, so no other member can
 *   post as you.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import {
  ROOM_EVENT,
  parseBridgeRoom,
  resolveCloud,
  roomTopic,
  type AgentEvent,
  type BridgeRoom,
  type CloudSettings,
  type RoomEnvelope,
  type SignedRoomContent,
} from '@groundcrew/shared';
import type { Identity } from './identity';

/**
 * Stable stand-ins for project folder names ("project 1", "project 2"...), so
 * others can tell your sessions apart without learning what you work on.
 */
export class ProjectAliases {
  private aliases = new Map<string, string>();

  alias(project: string): string {
    let alias = this.aliases.get(project);
    if (!alias) {
      alias = `project ${this.aliases.size + 1}`;
      this.aliases.set(project, alias);
    }
    return alias;
  }
}

/** What actually leaves the machine for one event (before signing). Pure, for testing. */
export function toRoomContent(event: AgentEvent, room: BridgeRoom, key: string, aliases: ProjectAliases): SignedRoomContent {
  const { detail, sessionName, ...rest } = event;
  const shared: AgentEvent = room.shareDetails
    ? { ...rest, ...(detail ? { detail } : {}), ...(sessionName ? { sessionName } : {}) }
    : { ...rest, ...(sessionName ? { sessionName: aliases.alias(sessionName) } : {}) };
  return { room: room.roomId, owner: room.name, key, event: shared };
}

/** Serialize and sign content into the wire envelope. */
export function signRoomContent(content: SignedRoomContent, identity: Identity): RoomEnvelope {
  const data = JSON.stringify(content);
  return { v: 2, data, sig: identity.sign(data) };
}

/** Seconds until a JWT expires (from its `exp` claim), or -1 if unreadable. */
export function tokenSecondsLeft(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp - Math.floor(now / 1000) : -1;
  } catch {
    return -1;
  }
}

export const ROOM_FILE = join(homedir(), '.groundcrew', 'room.json');

function loadSavedRoom(file: string): BridgeRoom | null {
  try {
    return parseBridgeRoom(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export interface RoomManagerOptions {
  env: NodeJS.ProcessEnv;
  identity: Identity;
  log: (...args: unknown[]) => void;
  /** Where the chosen room is remembered (tests pass a temp path). */
  file?: string;
}

/**
 * Holds the current room and access token, and forwards events. The room can
 * change at runtime; `onChange` lets the server tell connected browsers.
 */
export class RoomManager {
  readonly cloud: CloudSettings | null;
  readonly identity: Identity;
  /** Room we're sharing to right now. */
  private active: BridgeRoom | null = null;
  /** Room remembered from a previous run, waiting for the user to resume it. */
  private saved: BridgeRoom | null;
  /** Access token for the signed-in user (memory only). */
  private token: string | null = null;
  private aliases = new ProjectAliases();
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private failures = 0;
  private readonly file: string;
  private readonly log: (...args: unknown[]) => void;
  private listeners = new Set<() => void>();

  constructor({ env, identity, log, file = ROOM_FILE }: RoomManagerOptions) {
    this.log = log;
    this.file = file;
    this.identity = identity;
    this.cloud = resolveCloud(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    this.saved = loadSavedRoom(file);
  }

  get current(): BridgeRoom | null {
    return this.cloud ? this.active : null;
  }

  get resumable(): BridgeRoom | null {
    return this.cloud && !this.active ? this.saved : null;
  }

  /** Sharing, but without a usable token (the app needs to hand over a fresh one). */
  get needsToken(): boolean {
    return this.current !== null && (!this.token || tokenSecondsLeft(this.token) <= 0);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start sharing to `room` with `token`, or stop with null. */
  set(room: BridgeRoom | null, token: string | null = null): void {
    const sameRoom =
      room?.roomId === this.active?.roomId &&
      room?.name === this.active?.name &&
      room?.shareDetails === this.active?.shareDetails;
    if (room && sameRoom) {
      this.setToken(token);
      return;
    }
    if (!room && !this.active && !this.saved) return;

    if (room?.roomId !== this.active?.roomId) {
      this.aliases = new ProjectAliases();
      this.resetChannel();
    }
    this.active = room;
    this.saved = room;
    this.token = room ? token : null;
    this.failures = 0;
    try {
      if (room) {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(room, null, 2));
      } else {
        rmSync(this.file, { force: true });
      }
    } catch (error) {
      this.log(`[room] could not remember room: ${(error as Error).message}`);
    }
    this.log(
      room
        ? `[room] SHARING as "${room.name}" in room "${room.roomName}" (${room.code})` +
            (room.shareDetails ? ' with project names, files and commands' : ', tool names only')
        : '[room] stopped sharing',
    );
    this.emit();
  }

  /** Swap in a refreshed access token for the current room. */
  setToken(token: string | null): void {
    if (!this.active || !token || token === this.token) return;
    const wasMissing = this.needsToken;
    this.token = token;
    if (this.supabase) void this.supabase.realtime.setAuth(token);
    if (wasMissing) {
      this.log('[room] got a fresh access token, sharing again');
      this.emit();
    }
  }

  forward(event: AgentEvent): void {
    const room = this.current;
    if (!room || !this.cloud) return;
    if (this.needsToken) {
      this.fail('access token expired; open the groundcrew app to keep sharing');
      return;
    }
    if (!this.supabase) {
      // No auth session on the bridge: it only ever uses the token it was given.
      this.supabase = createClient(this.cloud.url, this.cloud.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    }
    const supabase = this.supabase;
    const token = this.token!;
    this.channel ??= supabase.channel(roomTopic(room.roomId), { config: { private: true } });
    const channel = this.channel;
    const envelope = signRoomContent(toRoomContent(event, room, this.identity.publicKey, this.aliases), this.identity);
    // Fire and forget: a slow or unreachable Supabase must never delay hooks.
    void supabase.realtime
      .setAuth(token)
      .then(() => channel.httpSend(ROOM_EVENT, envelope, { timeout: 5000 }))
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

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private fail(reason: string): void {
    this.failures++;
    if (this.failures === 1 || this.failures % 50 === 0) this.log(`[room] not shared (${reason})`);
    if (this.failures === 1 && this.needsToken) this.emit();
  }

  private resetChannel(): void {
    if (this.channel && this.supabase) void this.supabase.removeChannel(this.channel);
    this.channel = null;
  }
}
