/**
 * Watch a room on Supabase Realtime: your personal room (your own computers)
 * or a shared one (everyone's). Computers connected to the room publish their
 * agents' events there, signed with that computer's key (see
 * server/src/connections.ts). This source checks every signature, drops
 * anything from a key that isn't connected to the room, and feeds the rest
 * into the store like any other source, so the scene doesn't know or care
 * that the events are remote.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  ROOM_EVENT,
  ROOM_SNAPSHOT,
  canVerifySignatures,
  keyFingerprint,
  makeId,
  parseRoomEnvelope,
  roomTopic,
  verifyRoomEnvelope,
  verifyRoomSnapshot,
  type AgentEvent,
} from '@agentnauts/shared';
import { listRoomAgents, type JoinedRoom, type RoomAgent } from './roomsApi';
import { useSourceStore, type Roommate } from './sourceStore';
import { getSupabase } from './supabase';
import { StatusEmitter, type AgentEventSource, type EventSink, type SourceStatus } from './types';

/**
 * Keep each computer's sessions apart by its verified key (never just a
 * name). In a shared room, label them with who they belong to.
 */
export function namespaceEvent(owner: string | null, key: string, event: AgentEvent, nameTaken = false): AgentEvent {
  const project = event.sessionName ?? 'agent';
  const who = owner && nameTaken ? `${owner} (${keyFingerprint(key)})` : owner;
  return {
    ...event,
    sessionId: `room:${key}:${event.sessionId}`,
    sessionName: who ? `${who} · ${project}` : project,
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

/** After a key we don't know shows up, look the room's computers up again at most this often. */
const REGISTRY_RETRY_MS = 5000;

export interface RoomSourceOptions {
  /** Source id, also stamped on the agents it creates. */
  id: 'personal' | 'room';
  /** Your display name, shown to others watching a shared room. */
  name: string;
  /** Your user id: your own computers are shown through your personal room only. */
  userId: string;
  /** Is this astronaut (session, or session + crew member) already on the planet? */
  hasAgent: (sessionId: string, subagentId?: string) => boolean;
}

export class RoomSource implements AgentEventSource {
  readonly id: string;
  readonly label: string;
  private status = new StatusEmitter();
  private channel: RealtimeChannel | null = null;
  private stopped = false;
  private readonly presenceKey = makeId('viewer');
  private readonly recent = new RecentIds();
  /** Computers connected to this room, by public key. */
  private registry = new Map<string, RoomAgent>();
  private registryLoadedAt = 0;
  private registryLoading: Promise<void> | null = null;
  private rejected = 0;

  constructor(
    private readonly room: JoinedRoom,
    private readonly options: RoomSourceOptions,
  ) {
    this.id = options.id;
    this.label = room.personal ? 'Your computers' : `Room ${room.name}`;
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
    const supabase = getSupabase();
    if (!supabase) return;
    const personal = this.room.personal === true;
    this.status.set({ state: 'connecting', detail: personal ? 'Connecting' : `Joining ${this.room.name}` });
    // Private channel: the database only lets approved members in.
    const channel = supabase.channel(roomTopic(this.room.id), {
      config: { private: true, broadcast: { self: false }, presence: { key: this.presenceKey, enabled: !personal } },
    });
    this.channel = channel;

    channel.on('broadcast', { event: ROOM_EVENT }, ({ payload }) => {
      void this.receive(payload, sink);
    });
    channel.on('broadcast', { event: ROOM_SNAPSHOT }, ({ payload }) => {
      void this.receiveSnapshot(payload, sink);
    });

    if (!personal) {
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
    }

    void this.loadRegistry();
    // Make sure the channel authorizes with the signed-in user's token.
    void supabase.realtime.setAuth().then(() => {
      if (this.stopped) return;
      channel.subscribe((status, error) => {
        if (this.channel !== channel) return;
        if (status === 'SUBSCRIBED') {
          this.status.set({ state: 'connected', detail: personal ? 'Watching your computers' : `In ${this.room.name} as ${this.options.name}` });
          if (!personal) void channel.track({ name: this.options.name });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // realtime-js keeps retrying on its own; just report it.
          this.status.set({ state: 'error', detail: error?.message ?? `Could not join ${this.room.name}` });
        } else if (status === 'CLOSED') {
          this.status.set({ state: 'disconnected', detail: `Left ${this.room.name}` });
        }
      });
    });
  }

  stop(): void {
    this.stopped = true;
    const channel = this.channel;
    this.channel = null;
    if (channel) void getSupabase()?.removeChannel(channel);
    if (!this.room.personal) useSourceStore.getState().setRoommates([]);
    this.status.set({ state: 'stopped' });
  }

  private loadRegistry(): Promise<void> {
    this.registryLoading ??= listRoomAgents(this.room.id)
      .then((agents) => {
        this.registry = new Map(agents.map((agent) => [agent.publicKey, agent]));
      })
      .catch(() => {
        // Offline or signed out: unknown keys stay unknown until the next try.
      })
      .finally(() => {
        this.registryLoadedAt = Date.now();
        this.registryLoading = null;
      });
    return this.registryLoading;
  }

  /** The connected computer behind a key, or null if that key isn't connected to this room. */
  private async senderFor(key: string): Promise<RoomAgent | null> {
    if (this.registryLoading) await this.registryLoading;
    const known = this.registry.get(key);
    if (known) return known;
    // Maybe it was connected a moment ago.
    if (Date.now() - this.registryLoadedAt >= REGISTRY_RETRY_MS) await this.loadRegistry();
    return this.registry.get(key) ?? null;
  }

  private drop(): void {
    // Unsigned, forged, tampered, meant for another room, or from a computer that isn't connected here.
    this.rejected++;
    if (this.rejected === 1 || this.rejected % 100 === 0) {
      console.warn(`[${this.id}] dropped ${this.rejected} message(s) that failed signature checks`);
    }
  }

  /**
   * Should this computer's agents be shown by this source?
   * In a shared room your own computers are skipped (they show through your
   * personal room, with full details), and in local mode this machine's own
   * daemon already delivers its events directly.
   */
  private wanted(sender: RoomAgent): boolean {
    const store = useSourceStore.getState();
    if (store.bridgeIdentity?.identity === sender.publicKey && store.sources.bridge?.state === 'connected') return false;
    if (this.room.personal) return true;
    const alsoPersonal = store.agents.some((a) => a.personal && a.publicKey === sender.publicKey);
    return !(sender.userId === this.options.userId && alsoPersonal);
  }

  /** The event as this page shows it: namespaced by key, labelled with its owner in shared rooms. */
  private localEvent(sender: RoomAgent, event: AgentEvent): AgentEvent {
    if (this.room.personal) return namespaceEvent(null, sender.publicKey, event);
    // Names are just labels: two people with the same one are told apart by ID.
    const nameTaken = [...this.registry.values()].some((other) => other.name === sender.name && other.userId !== sender.userId);
    return namespaceEvent(sender.name, sender.publicKey, event, nameTaken);
  }

  private async receive(payload: unknown, sink: EventSink): Promise<void> {
    const envelope = parseRoomEnvelope(payload);
    const content = envelope ? await verifyRoomEnvelope(envelope, this.room.id) : null;
    const sender = content ? await this.senderFor(content.key) : null;
    if (!content || !sender) return this.drop();
    if (this.channel === null || this.recent.seen(`${content.key}:${content.event.id}`)) return;
    if (!this.room.personal) useSourceStore.getState().notePerson(sender.publicKey, sender.name, Date.now());
    if (this.wanted(sender)) sink(this.localEvent(sender, content.event));
  }

  /** A computer's "who is here right now": add the astronauts this page hasn't seen yet. */
  private async receiveSnapshot(payload: unknown, sink: EventSink): Promise<void> {
    const envelope = parseRoomEnvelope(payload);
    const content = envelope ? await verifyRoomSnapshot(envelope, this.room.id) : null;
    const sender = content ? await this.senderFor(content.key) : null;
    if (!content || !sender) return this.drop();
    if (this.channel === null) return;
    if (!this.room.personal) useSourceStore.getState().notePerson(sender.publicKey, sender.name, Date.now());
    if (!this.wanted(sender)) return;
    for (const event of content.events) {
      const local = this.localEvent(sender, event);
      if (!this.options.hasAgent(local.sessionId, local.subagent?.id)) sink(local);
    }
  }
}
