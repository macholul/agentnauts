/**
 * Multiplayer: forward this machine's normalized events to a shared room on
 * Supabase Realtime (broadcast). Everyone watching that room in the web app
 * sees your astronauts next to theirs.
 *
 * Privacy rules enforced here:
 * - Nothing is shared until you join a room in the web app (PUT /room).
 * - A remembered room is NOT resumed automatically after a restart; the web
 *   app asks you first.
 * - By default only tool names and states leave the machine: file names,
 *   commands, queries and project folder names are replaced or removed.
 * - Every message is signed with this machine's key, so nobody else can post
 *   as you.
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
  type RoomEnvelope,
  type SignedRoomContent,
} from '@groundcrew/shared';
import type { Identity } from './identity';

/** Which room this bridge shares to, and as whom. */
export interface RoomSettings {
  room: string;
  name: string;
  /** Include project names, file names, commands and queries. Off by default. */
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
    return {
      settings: null,
      problem: 'GROUNDCREW_ROOM must be a generated code (crew-xxxx-xxxx-xxxx) and GROUNDCREW_NAME must be set',
    };
  }
  return { settings };
}

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
export function toRoomContent(
  event: AgentEvent,
  settings: RoomSettings,
  key: string,
  aliases: ProjectAliases,
): SignedRoomContent {
  const { detail, sessionName, ...rest } = event;
  const shared: AgentEvent = settings.shareDetails
    ? { ...rest, ...(detail ? { detail } : {}), ...(sessionName ? { sessionName } : {}) }
    : { ...rest, ...(sessionName ? { sessionName: aliases.alias(sessionName) } : {}) };
  return { room: settings.room, owner: settings.name, key, event: shared };
}

/** Serialize and sign content into the wire envelope. */
export function signRoomContent(content: SignedRoomContent, identity: Identity): RoomEnvelope {
  const data = JSON.stringify(content);
  return { v: 2, data, sig: identity.sign(data) };
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
  identity: Identity;
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
  readonly identity: Identity;
  /** Set when env vars pin the room; the web app can't change it then. */
  readonly pinned: boolean;
  /** Room we're sharing to right now. */
  private active: RoomSettings | null;
  /** Room remembered from a previous run, waiting for the user to resume it. */
  private saved: RoomSettings | null;
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
    const fromEnv = roomSettingsFromEnv(env);
    if (fromEnv.problem) log(`[room] ignoring env room: ${fromEnv.problem}`);
    this.pinned = fromEnv.settings !== null;
    // An explicit env setting is a deliberate choice; a remembered room waits for confirmation.
    this.active = fromEnv.settings;
    this.saved = this.pinned ? null : loadSavedRoom(file);
  }

  get current(): RoomSettings | null {
    return this.cloud ? this.active : null;
  }

  get resumable(): RoomSettings | null {
    return this.cloud && !this.active ? this.saved : null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start sharing (or stop with null). Returns false if pinned by env. */
  set(settings: RoomSettings | null): boolean {
    if (this.pinned) return false;
    const same =
      settings?.room === this.active?.room &&
      settings?.name === this.active?.name &&
      settings?.shareDetails === this.active?.shareDetails;
    if (same && (settings !== null || this.saved === null)) return true;
    if (settings?.room !== this.active?.room) this.aliases = new ProjectAliases();
    this.active = settings;
    this.saved = settings;
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
    this.log(
      settings
        ? `[room] SHARING as "${settings.name}" in room "${settings.room}"` +
            (settings.shareDetails ? ' (with project names, files and commands)' : ' (tool names only)')
        : '[room] stopped sharing',
    );
    for (const listener of this.listeners) listener();
    return true;
  }

  forward(event: AgentEvent): void {
    const settings = this.current;
    if (!settings || !this.cloud) return;
    this.supabase ??= createClient(this.cloud.url, this.cloud.key, { auth: { persistSession: false } });
    this.channel ??= this.supabase.channel(roomTopic(settings.room));
    const envelope = signRoomContent(toRoomContent(event, settings, this.identity.publicKey, this.aliases), this.identity);
    // Fire and forget: a slow or unreachable Supabase must never delay hooks.
    this.channel
      .httpSend(ROOM_EVENT, envelope, { timeout: 5000 })
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
