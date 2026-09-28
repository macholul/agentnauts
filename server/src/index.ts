/**
 * groundcrew event bridge.
 *
 *   POST /event   Claude Code hook JSON (stdin of the hook, forwarded by curl)
 *   GET  /health  liveness + connected browser count
 *   WS   /ws      browsers receive normalized AgentEvents here
 *
 * Plain node:http + ws; no framework needed for three routes.
 */
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BRIDGE_WS_PATH, DEFAULT_BRIDGE_PORT, type AgentEvent, type ServerMessage } from '@groundcrew/shared';
import { normalizeHookPayload } from './normalize';
import { isAllowedOrigin } from './origin';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? DEFAULT_BRIDGE_PORT);
// Loopback only by default: events include file names and commands.
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const QUIET = process.env.GROUNDCREW_QUIET === '1';

const extraOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function log(...args: unknown[]): void {
  if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...args);
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

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, extraOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

wss.on('connection', (socket, req) => {
  alive.set(socket, true);
  socket.on('pong', () => alive.set(socket, true));
  socket.on('error', (error) => log('[ws] client error:', error.message));
  socket.on('close', () => log(`[ws] browser disconnected (${wss.clients.size} connected)`));
  // Browsers never need to send us anything; ignore whatever they do send.
  const hello: ServerMessage = { type: 'hello', server: 'groundcrew', version: VERSION };
  socket.send(JSON.stringify(hello));
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
  }
  send(res, 204);
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

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, version: VERSION, clients: wss.clients.size });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `groundcrew event bridge ${VERSION}\n\n` +
        `POST /event   Claude Code hook JSON\n` +
        `GET  /health  status\n` +
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
    console.error(`[groundcrew] port ${PORT} is already in use. Is another bridge running? Set PORT to change it.`);
  } else {
    console.error('[groundcrew] server error:', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[groundcrew] event bridge listening on http://${HOST === '::' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[groundcrew]   hooks  → POST http://localhost:${PORT}/event`);
  console.log(`[groundcrew]   browser ← ws://localhost:${PORT}${BRIDGE_WS_PATH}`);
});

function shutdown(): void {
  clearInterval(heartbeat);
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
