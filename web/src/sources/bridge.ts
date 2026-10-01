/**
 * Real events: connects to the agentnauts event bridge (server package) over
 * WebSocket and forwards the normalized AgentEvents it broadcasts.
 * Reconnects with backoff, so the bridge can be started before or after the
 * browser.
 */
import { BRIDGE_WS_PATH, DEFAULT_BRIDGE_PORT, parseServerMessage, type BridgeRoomRequest } from '@agentnauts/shared';
import { useSourceStore } from './sourceStore';
import { StatusEmitter, type AgentEventSource, type EventSink, type SourceStatus } from './types';

function bridgeHttpUrl(path: string): URL {
  const url = new URL(defaultBridgeUrl());
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  return url;
}

/**
 * Tell the local bridge which room to share this machine's agents in (or
 * null to stop). The request carries a short-lived access token, never the
 * refresh token. The bridge answers with a fresh hello over the WebSocket.
 */
export async function setBridgeRoom(request: BridgeRoomRequest | null): Promise<boolean> {
  try {
    const res = await fetch(bridgeHttpUrl('/room'), {
      method: request ? 'PUT' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      ...(request ? { body: JSON.stringify(request) } : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Hand the bridge a refreshed access token for the room it's sharing to. */
export async function sendBridgeToken(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(bridgeHttpUrl('/room/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** VITE_BRIDGE_URL overrides the default ws://<page host>:4747/ws. */
export function defaultBridgeUrl(): string {
  const configured = import.meta.env.VITE_BRIDGE_URL;
  if (configured) return configured;
  const host = window.location.hostname || 'localhost';
  const needsBrackets = host.includes(':') && !host.startsWith('[');
  return `ws://${needsBrackets ? `[${host}]` : host}:${DEFAULT_BRIDGE_PORT}${BRIDGE_WS_PATH}`;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 10000;

export class BridgeSource implements AgentEventSource {
  readonly id = 'bridge';
  readonly label = 'Claude Code';
  private status = new StatusEmitter();
  private socket: WebSocket | null = null;
  private retryTimer: number | null = null;
  private retryDelay = MIN_RETRY_MS;
  private sink: EventSink | null = null;
  private stopped = true;

  constructor(private readonly url: string = defaultBridgeUrl()) {}

  onStatus(listener: (status: SourceStatus) => void): () => void {
    return this.status.subscribe(listener);
  }

  start(sink: EventSink): void {
    this.sink = sink;
    this.stopped = false;
    // Connect on the next tick: React StrictMode mounts, unmounts and remounts
    // effects in dev, and this avoids opening a socket only to close it at once.
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.status.set({ state: 'stopped', detail: this.url });
  }

  private connect(): void {
    if (this.stopped) return;
    this.status.set({ state: 'connecting', detail: this.url });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.status.set({ state: 'error', detail: `${this.url}: ${(error as Error).message}` });
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = MIN_RETRY_MS;
      this.status.set({ state: 'connected', detail: this.url });
    };

    socket.onmessage = (message: MessageEvent) => {
      if (typeof message.data !== 'string') return;
      const parsed = parseServerMessage(message.data);
      if (!parsed) {
        console.warn('[bridge] ignoring unexpected message', message.data.slice(0, 200));
        return;
      }
      if (parsed.type === 'hello') {
        const { cloud, room, resumable, needsToken, identity } = parsed;
        useSourceStore.getState().setBridgeIdentity({
          cloud: cloud ?? false,
          ...(room ? { room } : {}),
          ...(resumable ? { resumable } : {}),
          ...(needsToken ? { needsToken } : {}),
          ...(identity ? { identity } : {}),
        });
      }
      if (parsed.type === 'event') this.sink?.(parsed.event);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleRetry();
    };

    // onerror is always followed by onclose; nothing extra to do here.
    socket.onerror = () => {};
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(MAX_RETRY_MS, this.retryDelay * 2);
    this.status.set({
      state: 'disconnected',
      detail: `Bridge not reachable at ${this.url}. Run "npm run server". Retrying in ${Math.round(delay / 1000)}s.`,
    });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
