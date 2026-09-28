/**
 * Multiplayer: watch a shared room on Supabase Realtime. Every person's
 * bridge publishes their agents' events to the room, signed with that
 * person's key (see server/src/room.ts). This source verifies each signature
 * and feeds genuine events into the store like any other source, so the
 * scene doesn't know or care that they're remote.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import {
  ROOM_EVENT,
  canVerifySignatures,
  keyFingerprint,
  makeId,
  parseRoomEnvelope,
  resolveCloud,
  roomTopic,
  verifyRoomEnvelope,
  type AgentEvent,
} from '@groundcrew/shared';
import { useSourceStore, type Roommate } from './sourceStore';
import { StatusEmitter, type AgentEventSource, type EventSink, type SourceStatus } from './types';

export interface SupabaseSettings {
  url: string;
  key: string;
}

/** The shared Supabase project (shared/src/cloud.ts, overridable via VITE_ env), or null. */
export function supabaseSettings(): SupabaseSettings | null {
  return resolveCloud(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
}

let client: SupabaseClient | null = null;

function getClient(settings: SupabaseSettings): SupabaseClient {
  client ??= createClient(settings.url, settings.key, { auth: { persistSession: false } });
  return client;
}

/**
 * Keep each person's sessions apart by their verified key (never just their
 * name), and label them with who they belong to.
 */
export function namespaceEvent(owner: string, key: string, event: AgentEvent, nameTaken: boolean): AgentEvent {
  const project = event.sessionName ?? 'agent';
  const who = nameTaken ? `${owner} (${keyFingerprint(key)})` : owner;
  return {
    ...event,
    sessionId: `room:${key}:${event.sessionId}`,
    sessionName: `${who} · ${project}`,
  };
}

/** Remembers recent event ids so a re-broadcast (replayed) message is ignored. */
class RecentIds {
  private ids = new Set<string>();
  seen(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > 2000) {
      const first = this.ids.values().next().value;
      if (first !== undefined) this.ids.delete(first);
    }
    return false;
  }
}

export class RoomSource implements AgentEventSource {
  readonly id = 'room';
  readonly label: string;
  private status = new StatusEmitter();
  private channel: RealtimeChannel | null = null;
  private readonly presenceKey = makeId('viewer');
  private readonly recent = new RecentIds();
  /** Which key first used each display name in this room. */
  private readonly nameOwners = new Map<string, string>();
  private rejected = 0;

  constructor(
    private readonly settings: SupabaseSettings,
    private readonly room: string,
    private readonly name: string,
  ) {
    this.label = `Room ${room}`;
  }

  onStatus(listener: (status: SourceStatus) => void): () => void {
    return this.status.subscribe(listener);
  }

  start(sink: EventSink): void {
    if (this.channel) return;
    if (!canVerifySignatures()) {
      this.status.set({
        state: 'error',
        detail: 'This page cannot check signatures here. Open it via localhost or https.',
      });
      return;
    }
    this.status.set({ state: 'connecting', detail: `Joining room ${this.room}` });
    const supabase = getClient(this.settings);
    const channel = supabase.channel(roomTopic(this.room), {
      config: { broadcast: { self: false }, presence: { key: this.presenceKey, enabled: true } },
    });
    this.channel = channel;

    channel.on('broadcast', { event: ROOM_EVENT }, ({ payload }) => {
      void this.receive(payload, sink);
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<{ name: string }>();
      const roommates: Roommate[] = [];
      for (const [key, entries] of Object.entries(state)) {
        const name = entries[0]?.name;
        if (key !== this.presenceKey && name) roommates.push({ key, name });
      }
      roommates.sort((a, b) => a.name.localeCompare(b.name));
      useSourceStore.getState().setRoommates(roommates);
    });

    channel.subscribe((status, error) => {
      if (this.channel !== channel) return;
      if (status === 'SUBSCRIBED') {
        this.status.set({ state: 'connected', detail: `In room ${this.room} as ${this.name}` });
        void channel.track({ name: this.name });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // realtime-js keeps retrying on its own; just report it.
        this.status.set({ state: 'error', detail: error?.message ?? `Could not join room ${this.room}` });
      } else if (status === 'CLOSED') {
        this.status.set({ state: 'disconnected', detail: `Left room ${this.room}` });
      }
    });
  }

  stop(): void {
    const channel = this.channel;
    this.channel = null;
    if (channel && client) void client.removeChannel(channel);
    useSourceStore.getState().setRoommates([]);
    this.status.set({ state: 'stopped' });
  }

  private async receive(payload: unknown, sink: EventSink): Promise<void> {
    const envelope = parseRoomEnvelope(payload);
    const content = envelope ? await verifyRoomEnvelope(envelope, this.room) : null;
    if (!content) {
      // Unsigned, forged, tampered, or meant for another room.
      this.rejected++;
      if (this.rejected === 1 || this.rejected % 100 === 0) {
        console.warn(`[room] dropped ${this.rejected} message(s) that failed signature checks`);
      }
      return;
    }
    if (this.channel === null || this.recent.seen(`${content.key}:${content.event.id}`)) return;

    const store = useSourceStore.getState();
    store.notePerson(content.key, content.owner, Date.now());

    // Your own agents already arrive through your local bridge.
    const ownKey = store.bridgeIdentity?.identity;
    if (ownKey && content.key === ownKey && store.sources.bridge?.state === 'connected') return;

    // Names are just labels: whoever used a name first keeps it (you, for your
    // own name); anyone else using it is shown with their ID.
    const ownName = store.bridgeIdentity?.name;
    if (ownKey && ownName && !this.nameOwners.has(ownName)) this.nameOwners.set(ownName, ownKey);
    if (!this.nameOwners.has(content.owner)) this.nameOwners.set(content.owner, content.key);
    const nameTaken = this.nameOwners.get(content.owner) !== content.key;
    sink(namespaceEvent(content.owner, content.key, content.event, nameTaken));
  }
}
