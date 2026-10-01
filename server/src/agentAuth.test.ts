/**
 * Tests the agent-auth Edge Function (supabase/functions/agent-auth) with a
 * real key pair from the daemon's identity code and a stand-in database.
 */
import assert from 'node:assert/strict';
import { createHmac, type webcrypto } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentAuthMessage, parseAgentConnections } from '@agentnauts/shared';
import { handle, proofMessage, type Env } from '../../supabase/functions/agent-auth/index';
import { loadOrCreateIdentity } from './identity';

const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), 'an-')), 'identity.json'));
const NOW = 1_800_000_000_000;
const ENV: Env = {
  SUPABASE_URL: 'https://project.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  AGENT_JWT_SECRET: 'legacy-jwt-secret-for-tests',
};
const ROWS = [
  { agent_id: '11111111-1111-4111-8111-111111111111', room_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', room_name: 'My agents', personal: true, display_name: 'Olive', share_details: true },
  { agent_id: '22222222-2222-4222-8222-222222222222', room_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', room_name: 'Base', personal: false, display_name: 'Olive', share_details: false },
];

interface DbCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A database that answers agent_login with `rows` and records what it was asked. */
function fakeDb(rows: unknown, status = 200): { fetch: typeof fetch; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(rows), { status });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function request(body: unknown, method = 'POST'): Request {
  return new Request('https://project.example/functions/v1/agent-auth', {
    method,
    ...(method === 'POST' ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
}

function proof(timestamp = NOW, key = identity.publicKey) {
  return { publicKey: key, timestamp, signature: identity.sign(agentAuthMessage(key, timestamp)) };
}

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('agent-auth function', () => {
  it('signs the same message as the daemon', () => {
    assert.equal(proofMessage('KEY', 42), agentAuthMessage('KEY', 42));
  });

  it('returns one send-only token per connected room', async () => {
    const db = fakeDb(ROWS);
    const res = await handle(request(proof()), ENV, db.fetch, () => NOW);
    assert.equal(res.status, 200);
    const connections = parseAgentConnections(await res.json())!;
    assert.deepEqual(
      connections.map((c) => [c.agentId, c.roomId, c.roomName, c.personal, c.name, c.shareDetails]),
      ROWS.map((r) => [r.agent_id, r.room_id, r.room_name, r.personal, r.display_name, r.share_details]),
    );

    // It asked the database as the service role, for this key only.
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0]!.url, 'https://project.example/rest/v1/rpc/agent_login');
    assert.equal(db.calls[0]!.headers.Authorization, 'Bearer service-role-key');
    assert.deepEqual(db.calls[0]!.body, { p_public_key: identity.publicKey });

    for (const [i, connection] of connections.entries()) {
      const [header, payload, signature] = connection.token.split('.') as [string, string, string];
      assert.deepEqual(decode(header), { alg: 'HS256', typ: 'JWT' });
      // Signed with the project's secret, so Supabase accepts it.
      assert.equal(signature, createHmac('sha256', ENV.AGENT_JWT_SECRET!).update(`${header}.${payload}`).digest('base64url'));
      const claims = decode(payload);
      // The subject is the agent row, never a user.
      assert.equal(claims.sub, ROWS[i]!.agent_id);
      assert.equal(claims.room_id, ROWS[i]!.room_id);
      assert.equal(claims.role, 'authenticated');
      assert.equal(claims.agent, true);
      assert.equal(claims.exp, NOW / 1000 + 3600);
      assert.equal(connection.expiresAt, claims.exp);
    }
  });

  it('returns no tokens for a computer that is not connected anywhere', async () => {
    const res = await handle(request(proof()), ENV, fakeDb([]).fetch, () => NOW);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { connections: [] });
  });

  it('refuses a proof it cannot trust, without asking the database', async () => {
    const db = fakeDb(ROWS);
    const call = (body: unknown, method?: string) => handle(request(body, method), ENV, db.fetch, () => NOW);
    const other = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), 'an-')), 'identity.json'));

    assert.equal((await call(proof(), 'GET')).status, 405);
    assert.equal((await call({})).status, 400);
    assert.equal((await call({ ...proof(), publicKey: 'short' })).status, 400);
    // Someone else's key with our signature, a signature for another moment, a tampered one.
    assert.equal((await call({ ...proof(), publicKey: other.publicKey })).status, 401);
    assert.equal((await call({ ...proof(), timestamp: NOW + 1 })).status, 401);
    assert.equal((await call({ ...proof(), signature: 'A'.repeat(86) })).status, 401);
    // An old proof (a replay) or a clock that is far off.
    const stale = await call(proof(NOW - 5 * 60_000));
    assert.equal(stale.status, 401);
    assert.equal(((await stale.json()) as { error: string }).error, 'clock');
    assert.equal((await call(proof(NOW + 5 * 60_000))).status, 401);
    assert.equal(db.calls.length, 0);
  });

  it('fails closed when it is not set up or the database is down', async () => {
    const { AGENT_JWT_SECRET: _secret, ...noSecret } = ENV;
    assert.equal((await handle(request(proof()), noSecret, fakeDb(ROWS).fetch, () => NOW)).status, 500);
    const { SUPABASE_SERVICE_ROLE_KEY: _key, ...noDb } = ENV;
    assert.equal((await handle(request(proof()), noDb, fakeDb(ROWS).fetch, () => NOW)).status, 500);
    assert.equal((await handle(request(proof()), ENV, fakeDb({ message: 'boom' }, 500).fetch, () => NOW)).status, 502);
  });

  it('can sign with an imported ES256 key instead of the shared secret', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'agent-key-1' };
    const env: Env = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: ENV.SUPABASE_SERVICE_ROLE_KEY, AGENT_JWT_PRIVATE_JWK: JSON.stringify(jwk) };
    const res = await handle(request(proof()), env, fakeDb(ROWS.slice(0, 1)).fetch, () => NOW);
    const [connection] = parseAgentConnections(await res.json())!;
    const [header, payload, signature] = connection!.token.split('.') as [string, string, string];
    assert.deepEqual(decode(header), { alg: 'ES256', typ: 'JWT', kid: 'agent-key-1' });
    assert.ok(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.publicKey,
        Buffer.from(signature, 'base64url'),
        Buffer.from(`${header}.${payload}`),
      ),
    );
  });
});
