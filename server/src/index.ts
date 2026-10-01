/**
 * agentnauts event bridge.
 *
 *   POST /event   Claude Code hook JSON (stdin of the hook, forwarded by curl)
 *   GET  /health  liveness + connected browser count
 *   WS   /ws      browsers receive normalized AgentEvents here
 *
 * Plain node:http + ws; no framework needed for three routes.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  BRIDGE_WS_PATH,
  DEFAULT_BRIDGE_PORT,
  parseBridgeRoomRequest,
  type AgentEvent,
  type ServerMessage,
} from '@agentnauts/shared';
import { normalizeHookPayload } from './normalize';
import { isAllowedOrigin } from './origin';
import { loadOrCreateIdentity } from './identity';
import { RoomManager } from './room';

// Optional settings file next to package.json (see .env.example).
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: plain environment variables only.
}

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? DEFAULT_BRIDGE_PORT);
// Loopback only by default: events include file names and commands.
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const QUIET = process.env.AGENTNAUTS_QUIET === '1';

const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function log(...args: unknown[]): void {
  if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...args);
}

// Multiplayer room this bridge shares to (chosen in the web app, remembered on disk).
const rooms = new RoomManager({ env: process.env, identity: loadOrCreateIdentity(), log });

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

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, extraOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

// ---------------------------------------------------------------------------
// WebSocket fan-out
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
const alive = new WeakMap<WebSocket, boolean>();

function broadcast(message: ServerMessage): void {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function helloMessage(): ServerMessage {
  const room = rooms.current;
  return {
    type: 'hello',
    server: 'agentnauts',
    version: VERSION,
    cloud: rooms.cloud !== null,
    ...(rooms.cloud ? { identity: rooms.identity.publicKey } : {}),
    ...(room ? { room } : {}),
    ...(rooms.resumable ? { resumable: rooms.resumable } : {}),
    ...(rooms.needsToken ? { needsToken: true } : {}),
  };
}

// Tell open browsers whenever the shared room changes.
rooms.onChange(() => broadcast(helloMessage()));

wss.on('connection', (socket, req) => {
  alive.set(socket, true);
  socket.on('pong', () => alive.set(socket, true));
  socket.on('error', (error) => log('[ws] client error:', error.message));
  socket.on('close', () => log(`[ws] browser disconnected (${wss.clients.size} connected)`));
  // Browsers never need to send us anything; ignore whatever they do send.
  socket.send(JSON.stringify(helloMessage()));
  log(`[ws] browser connected from ${req.headers.origin ?? req.socket.remoteAddress} (${wss.clients.size} connected)`);
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

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function describe(event: AgentEvent): string {
  const who = event.subagent ? `${event.subagent.name ?? 'subagent'}@${event.sessionId.slice(0, 8)}` : event.sessionId.slice(0, 8);
  const what = [event.type, event.toolName, event.detail].filter(Boolean).join(' ');
  return `${who} ${what}`;
}

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
      log('[hooks] payload too large, ignored');
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
    log(`[hooks] invalid JSON ignored: ${preview(raw)}`);
    send(res, 400);
    return;
  }

  let result;
  try {
    result = normalizeHookPayload(payload);
  } catch (error) {
    // Never let a weird payload take the bridge down.
    log(`[hooks] failed to normalize payload: ${(error as Error).message} ${preview(raw)}`);
    send(res, 204);
    return;
  }

  if (result.warning) log(`[hooks] ${result.warning}: ${preview(raw, 200)}`);
  for (const event of result.events) {
    log(`[hooks] ${describe(event)}`);
    broadcast({ type: 'event', event });
    rooms.forward(event);
  }
  send(res, 204);
}

/** PUT /room {room, name, shareDetails} starts sharing; DELETE /room stops. */
/**
 * PUT /room {roomId, code, roomName, name, shareDetails, accessToken} starts
 * sharing; DELETE /room stops; POST /room/token {accessToken} refreshes the
 * token. Only the web app (localhost origin) or local tools can call these.
 */
async function handleRoom(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
  if (!rooms.cloud) {
    send(res, 409, { error: 'multiplayer is not configured in this build' });
    return;
  }
  if (req.method === 'DELETE' && path === '/room') {
    rooms.set(null);
    send(res, 200, {});
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { error: 'expected JSON' });
    return;
  }
  if (req.method === 'PUT' && path === '/room') {
    const request = parseBridgeRoomRequest(body);
    if (!request) {
      send(res, 400, { error: 'expected {roomId, code, roomName, name, shareDetails, accessToken}' });
      return;
    }
    const { accessToken, ...room } = request;
    rooms.set(room, accessToken);
    send(res, 200, rooms.current ?? {});
    return;
  }
  if (req.method === 'POST' && path === '/room/token') {
    const token = (body as { accessToken?: unknown } | null)?.accessToken;
    if (typeof token !== 'string' || token.length < 20) {
      send(res, 400, { error: 'expected {accessToken}' });
      return;
    }
    rooms.setToken(token);
    send(res, 204);
    return;
  }
  send(res, 405);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;

  // Browsers always send Origin on cross-site requests; curl (the hooks) never does.
  if (origin && !isAllowedOrigin(origin, extraOrigins)) {
    log(`[http] rejected request from origin ${origin}`);
    send(res, 403, { error: 'origin not allowed' });
    return;
  }
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    send(res, 204);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    void handleEvent(req, res);
    return;
  }

  if (url.pathname === '/room' || url.pathname === '/room/token') {
    if (req.method === 'GET' && url.pathname === '/room') send(res, 200, rooms.current ?? {});
    else void handleRoom(req, res, url.pathname);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, version: VERSION, clients: wss.clients.size });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `agentnauts event bridge ${VERSION}\n\n` +
        `POST /event   Claude Code hook JSON\n` +
        `GET  /health  status\n` +
        `PUT  /room    share this machine's agents in a multiplayer room (DELETE to stop)\n` +
        `WS   ${BRIDGE_WS_PATH}      normalized events for the visualizer\n`,
    );
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (url.pathname !== BRIDGE_WS_PATH || (origin && !isAllowedOrigin(origin, extraOrigins))) {
    log(`[ws] rejected upgrade for ${url.pathname} from ${origin ?? 'unknown origin'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[agentnauts] port ${PORT} is already in use. Is another bridge running? Set PORT to change it.`);
  } else {
    console.error('[agentnauts] server error:', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[agentnauts] event bridge listening on http://${HOST === '::' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[agentnauts]   hooks  → POST http://localhost:${PORT}/event`);
  console.log(`[agentnauts]   browser ← ws://localhost:${PORT}${BRIDGE_WS_PATH}`);
  const room = rooms.current;
  if (room) {
    console.log(
      `[agentnauts]   room   → SHARING as "${room.name}" in room "${room.roomName}"` +
        (room.shareDetails ? ' (with project names, files and commands)' : ' (tool names only)'),
    );
  } else if (rooms.resumable) {
    console.log(`[agentnauts]   room   → not sharing; open the web app to resume room "${rooms.resumable.roomName}"`);
  } else if (!rooms.cloud) {
    console.log('[agentnauts]   room   → multiplayer not configured (see shared/src/cloud.ts)');
  }
});

function shutdown(): void {
  clearInterval(heartbeat);
  void rooms.close();
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
