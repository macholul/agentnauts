/**
 * Event sources feed AgentEvents into the app. The scene and store never
 * know which source an event came from, so adding a new one (e.g. Supabase
 * Realtime for multiplayer) means implementing this interface and
 * registering it; nothing else changes.
 */
import type { AgentEvent } from '@groundcrew/shared';

export type EventSink = (event: AgentEvent) => void;

export type SourceState = 'stopped' | 'connecting' | 'connected' | 'disconnected' | 'running' | 'error';

export interface SourceStatus {
  state: SourceState;
  /** Human-readable detail for the HUD, e.g. the server URL or an error. */
  detail?: string;
}

export interface AgentEventSource {
  /** Stable id, also stamped on agents it creates (Agent.source). */
  readonly id: string;
  /** Name shown in the HUD. */
  readonly label: string;
  /** Begin emitting events into `sink`. */
  start(sink: EventSink): void;
  /** Stop emitting and release resources. Must be safe to call twice. */
  stop(): void;
  /** Subscribe to status changes. Returns an unsubscribe function. */
  onStatus(listener: (status: SourceStatus) => void): () => void;
}

/** Small helper for sources to manage status listeners. */
export class StatusEmitter {
  private listeners = new Set<(status: SourceStatus) => void>();
  private current: SourceStatus = { state: 'stopped' };

  get status(): SourceStatus {
    return this.current;
  }

  set(status: SourceStatus): void {
    this.current = status;
    for (const listener of this.listeners) listener(status);
  }

  subscribe(listener: (status: SourceStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
}
