/**
 * agentnauts daemon.
 *
 *   POST /event    Claude Code hook JSON (stdin of the hook, forwarded by curl)
 *   GET  /health   liveness + connected browser count
 *   GET  /status   this computer's ID and the rooms it publishes to
 *   POST /refresh  this computer was just connected or disconnected: check its rooms now
 *   WS   /ws       local mode: browsers on this machine receive events here
 *
 * Events go to Supabase, signed, with a send-only token per room (see
 * connections.ts). The daemon never holds an account session.
 *
 * Plain node:http + ws; no framework needed for five routes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { BRIDGE_WS_PATH, keyFingerprint, pairingLink, type AgentEvent, type ServerMessage } from '@agentnauts/shared';
import type { Settings } from './config';
import { CloudConnections, type ConnectionSummary } from './connections';
import type { Identity } from './identity';
import { normalizeHookPayload } from './normalize';
import { isAllowedOrigin, isLocalHost, isLoopback } from './origin';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface DaemonOptions {
  settings: Settings;
  identity: Identity;
  version: string;
  /** Things the person should see: what this computer publishes to, and when that fails. */
  log: (...args: unknown[]) => void;
  /** Every event and browser connection. */
  debug: (...args: unknown[]) => void;
  fetchFn?: typeof fetch;
}

/** What GET /status answers. */
export interface DaemonStatus {
  server: 'agentnauts';
  version: string;
  port: number;
  /** This computer's public key, and its short form. */
  identity: string;
  id: string;
  cloud: boolean;
  rooms: ConnectionSummary[];
  connectLink: string;
  appUrl: string;
}

export interface Daemon {
  /** The port it actually listens on. */
  port: number;
  connections: CloudConnections;
  status(): DaemonStatus;
  close(): Promise<void>;
}

/** The link that connects a computer to an account, opened in a signed-in browser. */
export function connectLinkFor(settings: Settings, identity: Identity): string {
  return pairingLink(settings.appUrl, { key: identity.publicKey, device: hostname().replace(/\.local$/, '') });
}

function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function describe(event: AgentEvent): string {
  const who = event.subagent ? `${event.subagent.name ?? 'subagent'}@${event.sessionId.slice(0, 8)}` : event.sessionId.slice(0, 8);
  const what = [event.type, event.toolName, event.detail].filter(Boolean).join(' ');
  return `${who} ${what}`;
}

/** Start listening. Rejects if the port can't be opened (`code` is EADDRINUSE when it is taken). */
export function startDaemon({ settings, identity, version, log, debug, fetchFn }: DaemonOptions): Promise<Daemon> {
  const { extraOrigins } = settings;
  // Listening on loopback only (the default), requests must also be addressed to it.
  const addressedHere = (req: http.IncomingMessage) => !isLoopback(settings.host) || isLocalHost(req.headers.host);
  // The rooms this computer publishes to (decided in the web app).
  const connections = new CloudConnections({ cloud: settings.cloud, identity, log, ...(fetchFn ? { fetchFn } : {}) });
  const connectLink = connectLinkFor(settings, identity);
  let port = settings.port;

  const status = (): DaemonStatus => ({
    server: 'agentnauts',
    version,
    port,
    identity: identity.publicKey,
    id: keyFingerprint(identity.publicKey),
    cloud: connections.cloud !== null,
    rooms: connections.summary,
    connectLink,
    appUrl: settings.appUrl,
  });

  // --- WebSocket fan-out (local mode) ---------------------------------------

  const wss = new WebSocketServer({ noServer: true });
  const alive = new WeakMap<WebSocket, boolean>();

  function broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  wss.on('connection', (socket, req) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('error', (error) => debug('[ws] client error:', error.message));
    socket.on('close', () => debug(`[ws] browser disconnected (${wss.clients.size} connected)`));
    // Browsers never need to send us anything; ignore whatever they do send.
    const hello: ServerMessage = { type: 'hello', server: 'agentnauts', version, cloud: connections.cloud !== null, identity: identity.publicKey };
    socket.send(JSON.stringify(hello));
    debug(`[ws] browser connected from ${req.headers.origin ?? req.socket.remoteAddress} (${wss.clients.size} connected)`);
  });

  // Drop connections that stopped answering pings.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, 30_000);
  heartbeat.unref();

  // --- HTTP -----------------------------------------------------------------

  /**
   * POST /event. Responses never have a body: curl prints it to the hook's
   * stdout, and Claude Code interprets hook stdout that looks like JSON.
   */
  async function handleEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        debug('[hooks] payload too large, ignored');
        send(res, 413);
      } else {
        send(res, 400);
      }
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      debug(`[hooks] invalid JSON ignored: ${preview(raw)}`);
      send(res, 400);
      return;
    }

    let result;
    try {
      result = normalizeHookPayload(payload);
    } catch (error) {
      // Never let a weird payload take the daemon down.
      debug(`[hooks] failed to normalize payload: ${(error as Error).message} ${preview(raw)}`);
      send(res, 204);
      return;
    }

    if (result.warning) debug(`[hooks] ${result.warning}: ${preview(raw, 200)}`);
    for (const event of result.events) {
      debug(`[hooks] ${describe(event)}`);
      broadcast({ type: 'event', event });
      connections.forward(event);
    }
    send(res, 204);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;

    if (!addressedHere(req)) {
      debug(`[http] rejected request for host ${req.headers.host}`);
      send(res, 403, { error: 'host not allowed' });
      return;
    }
    // Browsers always send Origin on cross-site requests; curl (the hooks) never does.
    if (origin && !isAllowedOrigin(origin, extraOrigins)) {
      debug(`[http] rejected request from origin ${origin}`);
      send(res, 403, { error: 'origin not allowed' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      send(res, 204);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/event') {
      void handleEvent(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      send(res, 200, status());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/refresh') {
      connections.nudge();
      send(res, 204);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, version, clients: wss.clients.size });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `agentnauts daemon ${version}\n\n` +
          `POST /event    Claude Code hook JSON\n` +
          `GET  /health   liveness\n` +
          `GET  /status   this computer's ID and the rooms it publishes to\n` +
          `POST /refresh  this computer was just connected or disconnected: check its rooms now\n` +
          `WS   ${BRIDGE_WS_PATH}       local mode: normalized events for a page on this machine\n`,
      );
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (url.pathname !== BRIDGE_WS_PATH || !addressedHere(req) || (origin && !isAllowedOrigin(origin, extraOrigins))) {
      debug(`[ws] rejected upgrade for ${url.pathname} from ${origin ?? 'unknown origin'}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      clearInterval(heartbeat);
      connections.stop();
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject);
      server.on('error', (error) => log('[agentnauts] server error:', error.message));
      port = (server.address() as AddressInfo).port;
      connections.start();
      resolve({ port, connections, status, close });
    });
  });
}
