/**
 * agent-auth: swaps a computer's signed proof for short-lived, send-only
 * tokens, one per room that computer is connected to.
 *
 * The daemon on someone's computer never holds their account session. It
 * proves it owns its Ed25519 key by signing a timestamp; this function looks
 * up that key's rows in project_agents and returns a one-hour token for each.
 * A token's subject is the agent row's id, not a user id, so the database
 * lets it do exactly one thing: send broadcasts to that room's channel while
 * the row exists (see supabase/migrations/…_agents.sql).
 *
 * Secrets (Edge Functions → Secrets):
 *   AGENT_JWT_SECRET        the project's legacy JWT secret (HS256), or
 *   AGENT_JWT_PRIVATE_JWK   an ES256 private key (JWK with a `kid`) that was
 *                           imported as a signing key for the project
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
 *
 * One self-contained file, so it can be pasted into the dashboard editor.
 */

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AGENT_JWT_SECRET?: string;
  AGENT_JWT_PRIVATE_JWK?: string;
}

export interface AgentConnection {
  agentId: string;
  roomId: string;
  roomName: string;
  personal: boolean;
  /** The person's display name in that room. */
  name: string;
  shareDetails: boolean;
  /** Send-only token for this room's channel. */
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** How long a token lasts. Revoking the row cuts it off sooner. */
export const TOKEN_SECONDS = 3600;
/** How far the computer's clock may be off. */
export const MAX_SKEW_MS = 120_000;

/** What the daemon signs. Must match agentAuthMessage() in shared/src/protocol.ts. */
export function proofMessage(publicKey: string, timestamp: number): string {
  return `agentnauts-agent-auth:${publicKey}:${timestamp}`;
}

type Bytes = Uint8Array<ArrayBuffer>;
const encoder = new TextEncoder();
const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;

function base64UrlToBytes(text: string): Bytes {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

async function proofIsValid(publicKey: string, timestamp: number, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', base64UrlToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64UrlToBytes(signature), utf8(proofMessage(publicKey, timestamp)));
  } catch {
    return false;
  }
}

type Signer = { header: Record<string, string>; sign: (data: Bytes) => Promise<Bytes> };

async function signerFrom(env: Env): Promise<Signer | null> {
  if (env.AGENT_JWT_PRIVATE_JWK) {
    const jwk = JSON.parse(env.AGENT_JWT_PRIVATE_JWK) as { kid?: string };
    // `as never`: the JWK type is named differently in Deno, browsers and Node.
    const key = await crypto.subtle.importKey('jwk', jwk as never, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return {
      header: { alg: 'ES256', typ: 'JWT', ...(jwk.kid ? { kid: jwk.kid } : {}) },
      sign: async (data) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data)),
    };
  }
  if (env.AGENT_JWT_SECRET) {
    const key = await crypto.subtle.importKey('raw', utf8(env.AGENT_JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return {
      header: { alg: 'HS256', typ: 'JWT' },
      sign: async (data) => new Uint8Array(await crypto.subtle.sign('HMAC', key, data)),
    };
  }
  return null;
}

async function mintToken(signer: Signer, claims: Record<string, unknown>): Promise<string> {
  const body = `${bytesToBase64Url(utf8(JSON.stringify(signer.header)))}.${bytesToBase64Url(utf8(JSON.stringify(claims)))}`;
  return `${body}.${bytesToBase64Url(await signer.sign(utf8(body)))}`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface AgentRow {
  agent_id: string;
  room_id: string;
  room_name: string;
  personal: boolean;
  display_name: string;
  share_details: boolean;
}

export async function handle(
  req: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let body: { publicKey?: unknown; timestamp?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'expected JSON' });
  }
  const { publicKey, timestamp, signature } = body;
  if (
    typeof publicKey !== 'string' ||
    !KEY.test(publicKey) ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    typeof signature !== 'string' ||
    !SIGNATURE.test(signature)
  ) {
    return json(400, { error: 'expected {publicKey, timestamp, signature}' });
  }

  const time = now();
  if (Math.abs(time - timestamp) > MAX_SKEW_MS) {
    return json(401, { error: 'clock', detail: "this computer's clock is too far off", serverTime: time });
  }
  if (!(await proofIsValid(publicKey, timestamp, signature))) return json(401, { error: 'bad signature' });

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'function is missing its database settings' });
  let signer: Signer | null;
  try {
    signer = await signerFrom(env);
  } catch {
    signer = null;
  }
  if (!signer) return json(500, { error: 'function is missing its signing key (AGENT_JWT_SECRET)' });

  let rows: AgentRow[];
  try {
    const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/rpc/agent_login`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_public_key: publicKey }),
    });
    if (!res.ok) return json(502, { error: 'database lookup failed' });
    rows = (await res.json()) as AgentRow[];
  } catch {
    return json(502, { error: 'database lookup failed' });
  }

  const issuedAt = Math.floor(time / 1000);
  const expiresAt = issuedAt + TOKEN_SECONDS;
  const connections: AgentConnection[] = [];
  for (const row of rows) {
    connections.push({
      agentId: row.agent_id,
      roomId: row.room_id,
      roomName: row.room_name,
      personal: row.personal,
      name: row.display_name,
      shareDetails: row.share_details,
      token: await mintToken(signer, {
        iss: `${env.SUPABASE_URL}/auth/v1`,
        aud: 'authenticated',
        role: 'authenticated',
        // Not a user id: the agent row. Row gone, access gone.
        sub: row.agent_id,
        agent: true,
        room_id: row.room_id,
        iat: issuedAt,
        exp: expiresAt,
      }),
      expiresAt,
    });
  }
  return json(200, { connections });
}

// Supabase Edge Functions (Deno). Skipped when this file is imported by tests.
interface DenoLike {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): unknown;
}
const deno = (globalThis as { Deno?: DenoLike }).Deno;
if (deno) {
  const read = (name: keyof Env) => deno.env.get(name);
  deno.serve((req) =>
    handle(req, {
      SUPABASE_URL: read('SUPABASE_URL'),
      SUPABASE_SERVICE_ROLE_KEY: read('SUPABASE_SERVICE_ROLE_KEY'),
      AGENT_JWT_SECRET: read('AGENT_JWT_SECRET'),
      AGENT_JWT_PRIVATE_JWK: read('AGENT_JWT_PRIVATE_JWK'),
    }),
  );
}
