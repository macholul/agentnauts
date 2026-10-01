import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handle, type Env } from '../../supabase/functions/agent-auth/index';
import { fetchConnections, publish } from './cloud';
import { loadOrCreateIdentity } from './identity';

const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), 'an-')), 'identity.json'));
const CLOUD = { url: 'https://project.example', key: 'anon-key' };
const ROOM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV: Env = { SUPABASE_URL: CLOUD.url, SUPABASE_SERVICE_ROLE_KEY: 'service', AGENT_JWT_SECRET: 'secret' };
const ROW = { agent_id: '22222222-2222-4222-8222-222222222222', room_id: ROOM, room_name: 'Base', personal: false, display_name: 'Olive', share_details: false };

describe('daemon cloud calls', () => {
  it('gets its rooms and tokens from the real function code', async () => {
    // Route the daemon's request into the function, with a stand-in database behind it.
    const db = (async () => new Response(JSON.stringify([ROW]))) as typeof fetch;
    let sentAuthorization = '';
    const network = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), 'https://project.example/functions/v1/agent-auth');
      sentAuthorization = (init?.headers as Record<string, string>).Authorization!;
      return handle(new Request(String(url), init), ENV, db);
    }) as typeof fetch;

    const result = await fetchConnections(CLOUD, identity, network);
    assert.ok(result.ok);
    assert.deepEqual(
      result.value.map((c) => [c.agentId, c.roomId, c.name]),
      [[ROW.agent_id, ROOM, 'Olive']],
    );
    // The daemon only ever presents the public anon key, never a user's token.
    assert.equal(sentAuthorization, 'Bearer anon-key');
  });

  it('reports why it was turned away', async () => {
    const refused = (async () => new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 })) as typeof fetch;
    assert.deepEqual(await fetchConnections(CLOUD, identity, refused), { ok: false, status: 401, error: 'bad signature' });
    const offline = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;
    assert.deepEqual(await fetchConnections(CLOUD, identity, offline), { ok: false, status: 0, error: 'fetch failed' });
  });

  it("posts to the room's private channel with that room's token", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const realtime = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) };
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    assert.deepEqual(await publish(CLOUD, { roomId: ROOM, token: 'room-token' }, 'agent_event', { v: 2 }, realtime), { ok: true, value: null });
    assert.equal(seen!.url, `https://project.example/realtime/v1/api/broadcast/agentnauts%3A${ROOM}/events/agent_event?private=true`);
    assert.equal(seen!.headers.Authorization, 'Bearer room-token');
    assert.equal(seen!.headers.apikey, 'anon-key');
    assert.equal(seen!.body, '{"v":2}');

    const revoked = (async () => new Response(JSON.stringify({ message: 'not allowed' }), { status: 403 })) as typeof fetch;
    assert.deepEqual(await publish(CLOUD, { roomId: ROOM, token: 't' }, 'agent_event', {}, revoked), { ok: false, status: 403, error: 'not allowed' });
  });
});
