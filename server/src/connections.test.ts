/**
 * The daemon's cloud side against a stand-in Supabase: the real agent-auth
 * function code in front of a list of rows, and a Realtime endpoint that
 * records what it is sent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ROOM_EVENT,
  ROOM_SNAPSHOT,
  parseRoomEnvelope,
  verifyRoomEnvelope,
  verifyRoomSnapshot,
  type AgentEvent,
} from '@agentnauts/shared';
import { handle, type Env } from '../../supabase/functions/agent-auth/index';
import { CloudConnections, SNAPSHOT_MS } from './connections';
import { loadOrCreateIdentity } from './identity';

const CLOUD = { url: 'https://project.example', key: 'anon-key' };
const ENV: Env = { SUPABASE_URL: CLOUD.url, SUPABASE_SERVICE_ROLE_KEY: 'service', AGENT_JWT_SECRET: 'secret' };
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSONAL_ROW = { agent_id: '11111111-1111-4111-8111-111111111111', room_id: MINE, room_name: 'My agents', personal: true, display_name: 'Olive', share_details: true };
const TEAM_ROW = { agent_id: '22222222-2222-4222-8222-222222222222', room_id: TEAM, room_name: 'Base', personal: false, display_name: 'Olive', share_details: false };

interface Sent {
  room: string;
  event: string;
  /** Subject of the token it was sent with: the agent row. */
  agent: string;
  payload: unknown;
}

function setup(rows: (typeof TEAM_ROW)[] = []) {
  const identity = loadOrCreateIdentity(join(mkdtempSync(join(tmpdir(), 'an-')), 'identity.json'));
  const world = {
    rows,
    now: 1_800_000_000_000,
    sent: [] as Sent[],
    /** Rooms whose channel refuses sends (computer disconnected in the app). */
    refuse: new Set<string>(),
    authCalls: 0,
    authDown: false,
    logs: [] as string[],
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/functions/v1/agent-auth') {
      world.authCalls++;
      if (world.authDown) throw new Error('fetch failed');
      const db = (async () => new Response(JSON.stringify(world.rows))) as typeof fetch;
      return handle(new Request(url, init), ENV, db, () => world.now);
    }
    const match = /^\/realtime\/v1\/api\/broadcast\/agentnauts%3A([0-9a-f-]+)\/events\/(\w+)$/.exec(url.pathname);
    assert.ok(match, `unexpected request to ${url.pathname}`);
    const [, room, event] = match as unknown as [string, string, string];
    if (world.refuse.has(room)) return new Response(JSON.stringify({ message: 'not allowed' }), { status: 403 });
    const token = (init?.headers as Record<string, string>).Authorization!.replace('Bearer ', '');
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sub: string };
    world.sent.push({ room, event, agent: claims.sub, payload: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const connections = new CloudConnections({
    cloud: CLOUD,
    identity,
    log: (...args) => world.logs.push(args.join(' ')),
    fetchFn,
    now: () => world.now,
  });
  return { world, connections, identity };
}

let counter = 0;
const event = (overrides: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++counter}`,
  sessionId: 's1',
  type: 'tool_start',
  toolName: 'Bash',
  detail: 'cat ~/.secrets',
  sessionName: 'acme-payments',
  timestamp: 1,
  ...overrides,
});

describe('publishing to connected rooms', () => {
  it('sends nothing until the computer is connected to a room', async () => {
    const { world, connections } = setup();
    await connections.refresh();
    connections.forward(event());
    await connections.idle();
    assert.equal(world.sent.length, 0);
    assert.deepEqual(connections.summary, []);
  });

  it('sends each event to every room with that room\'s token, name and level of detail', async () => {
    const { world, connections, identity } = setup([PERSONAL_ROW, TEAM_ROW]);
    await connections.refresh();
    connections.forward(event());
    await connections.idle();

    assert.deepEqual(world.sent.map((s) => [s.room, s.event, s.agent]).sort(), [
      [MINE, ROOM_EVENT, PERSONAL_ROW.agent_id],
      [TEAM, ROOM_EVENT, TEAM_ROW.agent_id],
    ]);
    const read = async (room: string) => (await verifyRoomEnvelope(parseRoomEnvelope(world.sent.find((s) => s.room === room)!.payload)!, room))!;
    // Your own room gets everything; the team sees tool names and "project 1".
    const mine = await read(MINE);
    assert.deepEqual([mine.key, mine.owner, mine.event.detail, mine.event.sessionName], [identity.publicKey, 'Olive', 'cat ~/.secrets', 'acme-payments']);
    // Even where details are shared, nothing readable is on the wire.
    assert.ok(!JSON.stringify(world.sent).includes('secrets'));
    const team = await read(TEAM);
    assert.deepEqual([team.key, team.event.toolName, team.event.detail, team.event.sessionName], [identity.publicKey, 'Bash', undefined, 'project 1']);
  });

  it('picks up a room connected in the app and sends it the agents that are already here', async () => {
    const { world, connections } = setup([PERSONAL_ROW]);
    await connections.refresh();
    connections.forward(event({ type: 'session_start' }));
    connections.forward(event({ sessionId: 's2', type: 'notification', detail: 'Needs your OK', sessionName: 'other' }));
    await connections.idle();
    world.sent.length = 0;

    world.rows = [PERSONAL_ROW, TEAM_ROW];
    await connections.refresh();
    await connections.idle();
    // Only the new room gets a snapshot; nothing is repeated to the old one.
    assert.deepEqual(world.sent.map((s) => [s.room, s.event]), [[TEAM, ROOM_SNAPSHOT]]);
    const snapshot = (await verifyRoomSnapshot(parseRoomEnvelope(world.sent[0]!.payload)!, TEAM))!;
    assert.deepEqual(
      snapshot.events.map((e) => [e.sessionId, e.type, e.detail, e.sessionName]),
      [
        ['s1', 'session_start', undefined, 'project 1'],
        ['s2', 'notification', undefined, 'project 2'], // still waiting for its person
      ],
    );
    assert.ok(world.logs.some((line) => line.includes('publishing to "Base" as Olive (tool names only)')));
  });

  it('stops within seconds when the computer is disconnected in the app', async () => {
    const { world, connections } = setup([PERSONAL_ROW, TEAM_ROW]);
    await connections.refresh();
    // Disconnected from the team room: the row is gone and the channel refuses the old token.
    world.rows = [PERSONAL_ROW];
    world.refuse.add(TEAM);
    connections.forward(event());
    await connections.idle();
    assert.deepEqual(world.sent.map((s) => s.room), [MINE]);

    world.now += 10_000;
    connections.tick();
    await connections.idle();
    assert.deepEqual(connections.summary.map((c) => c.roomId), [MINE]);
    world.sent.length = 0;
    connections.forward(event());
    await connections.idle();
    assert.deepEqual(world.sent.map((s) => s.room), [MINE]);
    assert.ok(world.logs.some((line) => line.includes('no longer publishing to "Base"')));
  });
});

describe('snapshots', () => {
  it('reports who is around every 20 seconds, commanders before crew', async () => {
    const { world, connections } = setup([PERSONAL_ROW]);
    await connections.refresh();
    connections.forward(event({ sessionId: 's1', subagent: { id: 'a1', name: 'Explore' } }));
    connections.forward(event({ sessionId: 's1', type: 'user_prompt' }));
    await connections.idle();
    world.sent.length = 0;

    connections.tick();
    await connections.idle();
    assert.equal(world.sent.length, 1);
    const snapshot = (await verifyRoomSnapshot(parseRoomEnvelope(world.sent[0]!.payload)!, MINE))!;
    assert.deepEqual(
      snapshot.events.map((e) => [e.type, e.subagent?.name]),
      [
        ['session_start', undefined],
        ['subagent_start', 'Explore'],
      ],
    );

    // Not again until 20 seconds have passed.
    world.now += SNAPSHOT_MS - 1000;
    connections.tick();
    await connections.idle();
    assert.equal(world.sent.length, 1);
    world.now += 1000;
    connections.tick();
    await connections.idle();
    assert.equal(world.sent.length, 2);
  });

  it('forgets agents that left or went quiet', async () => {
    const { world, connections } = setup([PERSONAL_ROW]);
    await connections.refresh();
    connections.forward(event({ sessionId: 's1' }));
    connections.forward(event({ sessionId: 's1', subagent: { id: 'a1' } }));
    connections.forward(event({ sessionId: 's2' }));
    connections.forward(event({ sessionId: 's1', subagent: { id: 'a1' }, type: 'subagent_stop' }));
    assert.deepEqual(connections.snapshotEvents().map((e) => e.sessionId + (e.subagent ? '/crew' : '')), ['s1', 's2']);
    connections.forward(event({ sessionId: 's2', type: 'session_end' }));
    assert.deepEqual(connections.snapshotEvents().map((e) => e.sessionId), ['s1']);
    world.now += 31 * 60_000;
    assert.deepEqual(connections.snapshotEvents(), []);
  });
});

describe('checking in with agent-auth', () => {
  it('checks often while waiting to be connected, rarely once it is', async () => {
    const { world, connections } = setup();
    await connections.refresh();
    assert.equal(world.authCalls, 1);
    world.now += 4000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 1, 'not yet');
    world.now += 1000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 2, 'every 5 seconds while unconnected');

    // Connected now: with no agents around, checking every half hour is enough.
    world.rows = [PERSONAL_ROW];
    world.now += 5000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 3);
    world.now += 5 * 60_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 3, 'no agents: no need');

    // The first event after a quiet spell checks at once...
    connections.forward(event({ type: 'session_start' }));
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 4);
    // ...and while that agent is around, even if it does nothing, every 30 seconds:
    // sharing it with a room in the app should take effect soon.
    world.now += 29_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 4);
    world.now += 1000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 5);

    // Once it has left, back to the slow pace.
    connections.forward(event({ type: 'session_end' }));
    world.now += 30_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 6, 'its last event still counts as activity');
    world.now += 5 * 60_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 6);
  });

  it('renews tokens well before they run out, and keeps working through an outage', async () => {
    const { world, connections } = setup([PERSONAL_ROW]);
    await connections.refresh();
    world.now += 20 * 60_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 1, 'a quiet computer leaves an hour-long token alone for half an hour');

    world.authDown = true;
    world.now += 10 * 60_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 2);
    // The check failed, but the old token is still good: keep publishing.
    assert.equal(connections.summary.length, 1);
    connections.forward(event());
    await connections.idle();
    assert.equal(world.sent.length, 1);
    assert.ok(world.logs.some((line) => line.includes('could not check')));

    world.authDown = false;
    world.now += 30_000;
    connections.tick();
    await connections.idle();
    assert.equal(world.authCalls, 3);
  });
});
