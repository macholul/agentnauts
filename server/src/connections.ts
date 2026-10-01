/**
 * The rooms this computer publishes to.
 *
 * The daemon holds no account session. Which rooms it is connected to is
 * decided in the web app (rows in project_agents for this computer's key);
 * the daemon just asks the agent-auth function, which answers with a
 * send-only token per room. Tokens stay in memory and last an hour;
 * disconnecting a computer in the app cuts it off at once.
 */
import {
  ROOM_EVENT,
  ROOM_SNAPSHOT,
  type AgentConnection,
  type AgentEvent,
  type CloudSettings,
} from '@agentnauts/shared';
import { fetchConnections, publish } from './cloud';
import type { Identity } from './identity';
import { ProjectAliases, signRoomContent, toRoomContent, toRoomSnapshot } from './room';

/** How often to look at the clocks below. */
const TICK_MS = 5_000;
/** Resend the current agents this often, for pages that opened later. */
export const SNAPSHOT_MS = 20_000;
/**
 * A computer that isn't connected yet checks often right after starting
 * (someone is probably pairing it), then less and less.
 */
const PAIRING_STEPS: readonly (readonly [runningForMs: number, everyMs: number])[] = [
  [10 * 60_000, 5_000],
  [60 * 60_000, 30_000],
  [Infinity, 5 * 60_000],
];
/** Soonest two checks may follow each other. */
const MIN_REFRESH_MS = 5_000;
/**
 * While this computer has agents around, pick up rooms added or removed in
 * the app this quickly (so "share my agents here" takes effect soon).
 */
const ACTIVE_REFRESH_MS = 30_000;
/** With no agents there is nothing to publish; the first event triggers a check anyway. */
const IDLE_REFRESH_MS = 30 * 60_000;
/** Get new tokens this long before the old ones run out. */
const RENEW_BEFORE_MS = 10 * 60_000;
/** After a refused send, don't ask again more often than this. */
const REJECTED_RETRY_MS = 10_000;
/** After agent-auth could not be reached, try again this soon. */
const FAILED_RETRY_MS = 30_000;
/** Sessions and crew nobody has heard from in this long are no longer reported (same as the app). */
const SESSION_STALE_MS = 30 * 60_000;
const CREW_STALE_MS = 5 * 60_000;

export interface ConnectionSummary {
  roomId: string;
  roomName: string;
  name: string;
  personal: boolean;
  shareDetails: boolean;
}

export interface ConnectionsOptions {
  cloud: CloudSettings | null;
  identity: Identity;
  log: (...args: unknown[]) => void;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface LiveAgent {
  event: AgentEvent;
  at: number;
}

export class CloudConnections {
  readonly cloud: CloudSettings | null;
  readonly identity: Identity;
  private connections: AgentConnection[] = [];
  private readonly aliases = new Map<string, ProjectAliases>();
  /** Latest event of every session and crew member that is still around. */
  private readonly live = new Map<string, LiveAgent>();
  private readonly failing = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private everRefreshed = false;
  private lastRefreshAt = 0;
  private lastSnapshotAt = 0;
  private eventsSinceRefresh = 0;
  private rejected = false;
  private lastError = '';
  private readonly startedAt: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor({ cloud, identity, log, fetchFn = fetch, now = Date.now }: ConnectionsOptions) {
    this.cloud = cloud;
    this.identity = identity;
    this.log = log;
    this.fetchFn = fetchFn;
    this.now = now;
    this.startedAt = now();
  }

  get summary(): ConnectionSummary[] {
    return this.connections.map(({ roomId, roomName, name, personal, shareDetails }) => ({ roomId, roomName, name, personal, shareDetails }));
  }

  /** True once the first answer from agent-auth is in. */
  get ready(): boolean {
    return this.everRefreshed;
  }

  start(): void {
    if (!this.cloud || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for a check and sends in flight (tests, shutdown). */
  async idle(): Promise<void> {
    await this.refreshing;
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Publish one event to every connected room, and remember who is around. */
  forward(event: AgentEvent): void {
    if (!this.cloud) return;
    this.track(event);
    this.eventsSinceRefresh++;
    for (const connection of this.connections) {
      const content = toRoomContent(event, connection, this.identity.publicKey, this.aliasesFor(connection.roomId));
      this.send(connection, ROOM_EVENT, signRoomContent(content, this.identity));
    }
  }

  /** Timers: renew tokens, notice rooms added or removed in the app, resend the snapshot. */
  tick(): void {
    const now = this.now();
    if (this.shouldRefresh(now)) void this.refresh();
    if (now - this.lastSnapshotAt >= SNAPSHOT_MS) this.sendSnapshot();
  }

  /** Ask agent-auth which rooms this computer is connected to, with fresh tokens. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (!this.cloud) return;
    const result = await fetchConnections(this.cloud, this.identity, this.fetchFn, this.now);
    this.lastRefreshAt = this.now();
    this.eventsSinceRefresh = 0;
    this.rejected = false;
    if (!result.ok) {
      // Keep what we have: the tokens may well still be good.
      const error = `${result.status || 'offline'}: ${result.error}`;
      if (error !== this.lastError) this.log(`[cloud] could not check this computer's rooms (${error})`);
      this.lastError = error;
      return;
    }
    this.lastError = '';
    const before = new Map(this.connections.map((c) => [c.roomId, c]));
    const added = result.value.filter((c) => !before.has(c.roomId));
    for (const connection of result.value) {
      const old = before.get(connection.roomId);
      if (!old || old.name !== connection.name || old.shareDetails !== connection.shareDetails) {
        this.log(
          `[cloud] publishing to "${connection.roomName}" as ${connection.name}` +
            (connection.personal ? ' (your own room)' : connection.shareDetails ? ' (with project names, files and commands)' : ' (tool names only)'),
        );
      }
      before.delete(connection.roomId);
    }
    for (const gone of before.values()) {
      this.log(`[cloud] no longer publishing to "${gone.roomName}"`);
      this.aliases.delete(gone.roomId);
      this.failing.delete(gone.roomId);
    }
    this.connections = result.value;
    this.everRefreshed = true;
    // A room that was just connected gets the current agents straight away.
    if (added.length > 0) this.sendSnapshot(added);
  }

  private shouldRefresh(now: number): boolean {
    if (this.refreshing) return false;
    const since = now - this.lastRefreshAt;
    if (this.rejected) return since >= REJECTED_RETRY_MS;
    if (this.lastError) return since >= FAILED_RETRY_MS;
    if (this.connections.length === 0) {
      const [, every] = PAIRING_STEPS.find(([runningFor]) => now - this.startedAt < runningFor)!;
      return since >= every;
    }
    const expires = Math.min(...this.connections.map((c) => c.expiresAt * 1000));
    if (expires - now < RENEW_BEFORE_MS) return since >= MIN_REFRESH_MS;
    if (this.eventsSinceRefresh > 0 || this.live.size > 0) return since >= ACTIVE_REFRESH_MS;
    return since >= IDLE_REFRESH_MS;
  }

  private aliasesFor(roomId: string): ProjectAliases {
    let aliases = this.aliases.get(roomId);
    if (!aliases) {
      aliases = new ProjectAliases();
      this.aliases.set(roomId, aliases);
    }
    return aliases;
  }

  private track(event: AgentEvent): void {
    const now = this.now();
    const key = event.subagent ? `${event.sessionId}/${event.subagent.id}` : event.sessionId;
    if (event.type === 'session_end') {
      for (const id of [...this.live.keys()]) {
        if (id === event.sessionId || id.startsWith(`${event.sessionId}/`)) this.live.delete(id);
      }
      return;
    }
    if (event.type === 'subagent_stop') {
      this.live.delete(key);
      return;
    }
    this.live.set(key, { event, at: now });
    // A commander is busy supervising while its crew works.
    const commander = event.subagent ? this.live.get(event.sessionId) : undefined;
    if (commander) commander.at = now;
  }

  /**
   * Who is on the planet right now, as events a page can apply: "landed" for
   * everyone, or "waiting for you" for those who are. What they were doing
   * arrives with their next real event.
   */
  snapshotEvents(): AgentEvent[] {
    const now = this.now();
    const events: AgentEvent[] = [];
    for (const [key, { event, at }] of this.live) {
      if (now - at > (event.subagent ? CREW_STALE_MS : SESSION_STALE_MS)) {
        this.live.delete(key);
        continue;
      }
      const waiting = event.type === 'notification';
      events.push({
        id: `snapshot:${key}`,
        sessionId: event.sessionId,
        type: waiting ? 'notification' : event.subagent ? 'subagent_start' : 'session_start',
        ...(waiting && event.detail ? { detail: event.detail } : {}),
        ...(event.subagent ? { subagent: event.subagent } : {}),
        ...(event.sessionName ? { sessionName: event.sessionName } : {}),
        timestamp: at,
        ...(event.source ? { source: event.source } : {}),
      });
    }
    // Commanders first, so crew find theirs when a page applies these in order.
    return events.sort((a, b) => Number(Boolean(a.subagent)) - Number(Boolean(b.subagent)));
  }

  private sendSnapshot(to: AgentConnection[] = this.connections): void {
    if (to === this.connections) this.lastSnapshotAt = this.now();
    if (to.length === 0) return;
    const events = this.snapshotEvents();
    if (events.length === 0) return;
    for (const connection of to) {
      const content = toRoomSnapshot(events, connection, this.identity.publicKey, this.aliasesFor(connection.roomId));
      this.send(connection, ROOM_SNAPSHOT, signRoomContent(content, this.identity));
    }
  }

  /** Fire and forget: a slow or unreachable Supabase must never delay hooks. */
  private send(connection: AgentConnection, event: string, payload: unknown): void {
    const cloud = this.cloud;
    if (!cloud) return;
    const sending = publish(cloud, connection, event, payload, this.fetchFn).then((result) => {
      if (result.ok) {
        if (this.failing.delete(connection.roomId)) this.log(`[cloud] publishing to "${connection.roomName}" again`);
        return;
      }
      // Refused: the token ran out, or this computer was disconnected in the app.
      if (result.status === 401 || result.status === 403) this.rejected = true;
      if (!this.failing.has(connection.roomId)) {
        this.failing.add(connection.roomId);
        this.log(`[cloud] not published to "${connection.roomName}" (${result.status || 'offline'}: ${result.error})`);
      }
    });
    this.pending.add(sending);
    void sending.finally(() => this.pending.delete(sending));
  }
}
