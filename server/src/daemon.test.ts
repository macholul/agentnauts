/** The daemon's local side: what a hook's curl, the command line and a local page get from it. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { keyFingerprint, parsePairingHash, parseServerMessage } from '@agentnauts/shared';
import { handle, type Env } from '../../supabase/functions/agent-auth/index';
import { startDaemon, type Daemon, type DaemonStatus } from './daemon';
import { loadOrCreateIdentity } from './identity';

const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), 'an-')), 'identity.json'));
const CLOUD = { url: 'https://project.example', key: 'anon-key' };
const ENV: Env = { SUPABASE_URL: CLOUD.url, SUPABASE_SERVICE_ROLE_KEY: 'service', AGENT_JWT_SECRET: 'secret' };
const ROW = { agent_id: '11111111-1111-4111-8111-111111111111', room_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', room_name: 'My agents', personal: true, display_name: 'Olive', share_details: true };

describe('daemon', () => {
  /** What the stand-in cloud has for this computer, and what it received. */
  const cloud = { rows: [] as (typeof ROW)[], published: 0 };
  let daemon: Daemon;
  let url = '';
  const logs: string[] = [];

  before(async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/functions/v1/agent-auth') {
        const db = (async () => new Response(JSON.stringify(cloud.rows))) as typeof fetch;
        return handle(new Request(String(input), init), ENV, db);
      }
      cloud.published++;
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    daemon = await startDaemon({
      // Port 0: any free port.
      settings: { port: 0, host: '127.0.0.1', extraOrigins: [], appUrl: 'https://app.example', cloud: CLOUD },
      identity,
      version: '9.9.9',
      log: (...args) => logs.push(args.join(' ')),
      debug: () => {},
      fetchFn,
    });
    url = `http://127.0.0.1:${daemon.port}`;
    await daemon.connections.idle();
  });

  after(() => daemon.close());

  const status = async () => (await (await fetch(`${url}/status`)).json()) as DaemonStatus;
  const hook = (body: string) => fetch(`${url}/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  it('tells the command line who it is, with a link to connect this computer', async () => {
    const answer = await status();
    assert.equal(answer.server, 'agentnauts');
    assert.equal(answer.version, '9.9.9');
    assert.equal(answer.port, daemon.port);
    assert.equal(answer.id, keyFingerprint(identity.publicKey));
    assert.deepEqual(answer.rooms, []);
    assert.equal(answer.appUrl, 'https://app.example');
    assert.ok(answer.connectLink.startsWith('https://app.example/#connect='));
    assert.equal(parsePairingHash(new URL(answer.connectLink).hash)?.key, identity.publicKey);
  });

  it('answers hooks with nothing, whatever they send', async () => {
    const good = await hook(JSON.stringify({ session_id: 's1', cwd: '/tmp/project', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    assert.equal(good.status, 204);
    assert.equal(await good.text(), '');
    assert.equal((await hook('not json')).status, 400);
    assert.equal((await hook(JSON.stringify({ hook_event_name: 'SomethingNew' }))).status, 204);
    // Not connected to any room yet: nothing left this computer.
    await daemon.connections.idle();
    assert.equal(cloud.published, 0);
  });

  it('shows the rooms this computer got connected to', async () => {
    cloud.rows = [ROW];
    // `agentnauts connect` says: someone is connecting this computer now.
    assert.equal((await fetch(`${url}/refresh`, { method: 'POST' })).status, 204);
    await daemon.connections.refresh();
    await daemon.connections.idle();
    assert.deepEqual((await status()).rooms, [{ roomId: ROW.room_id, roomName: 'My agents', name: 'Olive', personal: true, shareDetails: true }]);
    assert.ok(logs.some((line) => line.includes('publishing to "My agents" as Olive (your own room)')));
    // The session from before is sent to the room it just got.
    assert.ok(cloud.published > 0);
  });

  it('only lets pages on this computer in', async () => {
    assert.equal((await fetch(`${url}/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const local = await fetch(`${url}/status`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(local.status, 200);
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  it('only answers requests addressed to this computer', async () => {
    // A website whose domain points at 127.0.0.1 arrives with its own name in Host.
    const ask = (host: string, path = '/status', method = 'GET') =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: daemon.port, path, method, headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    assert.equal(await ask(`evil.example:${daemon.port}`), 403);
    assert.equal(await ask(`evil.example:${daemon.port}`, '/event', 'POST'), 403);
    assert.equal(await ask(`localhost:${daemon.port}`), 200);
    assert.equal(await ask(`127.0.0.1:${daemon.port}`), 200);
    assert.equal(await ask(`[::1]:${daemon.port}`), 200);
  });

  it('greets a local page over the socket and passes events on', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
    const messages: string[] = [];
    let wake = (): void => {};
    socket.on('message', (data) => {
      messages.push(String(data));
      wake();
    });
    const got = async (count: number): Promise<void> => {
      while (messages.length < count) await new Promise<void>((resolve) => (wake = resolve));
    };
    await got(1);
    const hello = parseServerMessage(messages[0]!);
    assert.ok(hello?.type === 'hello' && hello.version === '9.9.9' && hello.identity === identity.publicKey);
    await hook(JSON.stringify({ session_id: 's2', cwd: '/tmp/project', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
    await got(2);
    const event = parseServerMessage(messages[1]!);
    assert.ok(event?.type === 'event' && event.event.sessionId === 's2');
    socket.close();
  });

  it('says so when the port is taken', async () => {
    await assert.rejects(
      startDaemon({
        settings: { port: daemon.port, host: '127.0.0.1', extraOrigins: [], appUrl: 'https://app.example', cloud: null },
        identity,
        version: '9.9.9',
        log: () => {},
        debug: () => {},
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE',
    );
  });
});
