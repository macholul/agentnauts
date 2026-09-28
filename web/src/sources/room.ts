/**
 * Multiplayer: watch a shared room on Supabase Realtime. Every person's
 * bridge publishes their agents' events to the room (see server/src/room.ts);
 * this source receives them and feeds them into the store like any other
 * source, so the scene doesn't know or care that they're remote.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { ROOM_EVENT, makeId, parseRoomMessage, resolveCloud, roomTopic, type AgentEvent } from '@groundcrew/shared';
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

/** Keep each person's sessions apart, and label them with who they belong to. */
export function namespaceEvent(owner: string, event: AgentEvent): AgentEvent {
  const project = event.sessionName ?? 'agent';
  return {
    ...event,
    sessionId: `room:${owner}:${event.sessionId}`,
    sessionName: `${owner} · ${project}`,
  };
}

export class RoomSource implements AgentEventSource {
  readonly id = 'room';
  readonly label: string;
  private status = new StatusEmitter();
  private channel: RealtimeChannel | null = null;
  private readonly presenceKey = makeId('viewer');

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
    this.status.set({ state: 'connecting', detail: `Joining room ${this.room}` });
    const supabase = getClient(this.settings);
    const channel = supabase.channel(roomTopic(this.room), {
      config: { broadcast: { self: false }, presence: { key: this.presenceKey, enabled: true } },
    });
    this.channel = channel;

    channel.on('broadcast', { event: ROOM_EVENT }, ({ payload }) => {
      const message = parseRoomMessage(payload);
      if (!message) {
        console.warn('[room] ignoring malformed message', payload);
        return;
      }
      // Your own agents already arrive through your local bridge.
      const sources = useSourceStore.getState();
      const ownBridge = sources.bridgeIdentity?.name;
      if (ownBridge && message.owner === ownBridge && sources.sources.bridge?.state === 'connected') return;
      sink(namespaceEvent(message.owner, message.event));
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
}
