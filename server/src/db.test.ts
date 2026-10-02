/**
 * Tests the migrations (supabase/migrations) against a real
 * Postgres (PGlite, in-process) with small stand-ins for Supabase's `auth`
 * and `realtime` schemas. Checks the access rules, not just the syntax.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

/** Minimal Supabase look-alike: roles, auth.users/uid(), realtime.messages/topic(). */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema realtime;
  create table realtime.messages (id bigserial primary key, topic text not null, extension text not null, payload jsonb);
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable
    as $$ select nullif(current_setting('realtime.topic', true), '') $$;
  grant usage on schema auth, realtime, public to anon, authenticated, service_role;
  grant select, insert on realtime.messages to authenticated;
  grant usage, select on sequence realtime.messages_id_seq to authenticated;
`;

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const CODE = 'crew-abcd-efgh-jkmn';

let db: PGlite;

/** A fresh database with the stub and every migration applied, in order. */
async function freshDb(): Promise<void> {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(`insert into auth.users values ('${OWNER}', 'owner@example.com'), ('${FRIEND}', 'friend@example.com'), ('${STRANGER}', 'stranger@example.com')`);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
}

/** Run SQL as a signed-in user (or anonymously with null), like PostgREST would. */
async function as<T>(user: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ''}', false);`);
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

interface Access {
  /** See what others send. */
  receive: boolean;
  /** Send events (broadcast). */
  send: boolean;
  /** Show up in the room's "who's watching" list (presence). */
  presence: boolean;
}

const MEMBER: Access = { receive: true, send: false, presence: true };
const AGENT: Access = { receive: false, send: true, presence: false };
const NOTHING: Access = { receive: false, send: false, presence: false };

/**
 * What Realtime's authorization check would allow on `topic` for a token
 * whose subject is `subject`: a user id, or an agent row id.
 */
async function channelAccess(subject: string, topic: string): Promise<Access> {
  await db.exec(`reset role; delete from realtime.messages; insert into realtime.messages (topic, extension) values ('${topic}', 'broadcast');`);
  await db.exec(`select set_config('realtime.topic', '${topic}', false)`);
  const receive = (await as<{ n: number }>(subject, 'select count(*)::int as n from realtime.messages'))[0]!.n > 0;
  const canInsert = async (extension: string) => {
    try {
      await as(subject, `insert into realtime.messages (topic, extension) values ($1, $2)`, [topic, extension]);
      return true;
    } catch {
      return false;
    }
  };
  return { receive, send: await canInsert('broadcast'), presence: await canInsert('presence') };
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

describe('private rooms', () => {
  let roomId = '';
  let topic = '';

  before(freshDb);

  it('lets a signed-in user create a room and nobody anonymous', async () => {
    await rejects(as(null, `select public.create_room($1, 'x', 'x')`, [CODE]), /permission denied/);
    await rejects(as(OWNER, `select public.create_room('my-room', 'Base', 'Olive')`), /check constraint|violates/);
    const [room] = await as<{ id: string }>(OWNER, `select (public.create_room($1, 'Base', 'Olive')).id`, [CODE]);
    roomId = room!.id;
    topic = `agentnauts:${roomId}`;
    assert.deepEqual(await channelAccess(OWNER, topic), MEMBER);
  });

  it('keeps rooms invisible and channels closed to outsiders', async () => {
    assert.equal((await as(STRANGER, 'select * from public.rooms')).length, 0);
    assert.equal((await as(STRANGER, 'select * from public.list_room_members($1)', [roomId])).length, 0);
    assert.deepEqual(await channelAccess(STRANGER, topic), NOTHING);
    await rejects(as(STRANGER, `insert into public.room_members values ($1, $2, 'me', 'member')`, [roomId, STRANGER]), /permission denied/);
  });

  it('makes join requests wait for the owner', async () => {
    const [request] = await as<{ status: string }>(FRIEND, 'select * from public.request_to_join($1, $2)', [CODE, 'Finn']);
    assert.equal(request!.status, 'pending');
    assert.deepEqual(await channelAccess(FRIEND, topic), NOTHING);
    await rejects(as(FRIEND, 'select public.approve_member($1, $2)', [roomId, FRIEND]), /only the room owner/);
    await rejects(as(STRANGER, 'select * from public.request_to_join($1, $2)', ['crew-zzzz-zzzz-zzzz', 'S']), /no room/);
  });

  it('shows emails to the owner only, to vet requests', async () => {
    const forOwner = await as<{ display_name: string; status: string; email: string | null }>(
      OWNER,
      'select * from public.list_room_members($1)',
      [roomId],
    );
    assert.deepEqual(
      forOwner.map((m) => [m.display_name, m.status, m.email]),
      [
        ['Olive', 'member', 'owner@example.com'],
        ['Finn', 'pending', 'friend@example.com'],
      ],
    );
  });

  it('opens the channel once approved, hides emails from members', async () => {
    await as(OWNER, 'select public.approve_member($1, $2)', [roomId, FRIEND]);
    assert.deepEqual(await channelAccess(FRIEND, topic), MEMBER);
    const forFriend = await as<{ email: string | null }>(FRIEND, 'select * from public.list_room_members($1)', [roomId]);
    assert.equal(forFriend.length, 2);
    assert.ok(forFriend.every((m) => m.email === null));
    // Membership doesn't leak into other channels.
    const other = 'agentnauts:44444444-4444-4444-8444-444444444444';
    assert.deepEqual(await channelAccess(FRIEND, other), NOTHING);
    assert.deepEqual(await channelAccess(FRIEND, 'someone-elses-topic'), NOTHING);
  });

  it('closes the channel again when a member is removed or leaves', async () => {
    await rejects(as(FRIEND, 'select public.remove_member($1, $2)', [roomId, OWNER]), /owner cannot be removed/);
    await as(OWNER, 'select public.remove_member($1, $2)', [roomId, FRIEND]);
    assert.deepEqual(await channelAccess(FRIEND, topic), NOTHING);

    await as(FRIEND, 'select * from public.request_to_join($1, $2)', [CODE, 'Finn']);
    await as(OWNER, 'select public.approve_member($1, $2)', [roomId, FRIEND]);
    await as(FRIEND, 'select public.remove_member($1, $2)', [roomId, FRIEND]);
    assert.deepEqual(await channelAccess(FRIEND, topic), NOTHING);
  });

  it('only lets the owner delete the room', async () => {
    await rejects(as(FRIEND, 'select public.delete_room($1)', [roomId]), /only the room owner/);
    await as(OWNER, 'select public.delete_room($1)', [roomId]);
    assert.deepEqual(await channelAccess(OWNER, topic), NOTHING);
  });
});

/** Run SQL as the service role, like the agent-auth Edge Function does. */
async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

describe('agent credentials', () => {
  // Public keys of three computers (43 base64url characters each).
  const LAPTOP = 'A'.repeat(43);
  const DESKTOP = 'B'.repeat(43);
  const FRIENDS_LAPTOP = 'C'.repeat(43);

  let personal = '';
  let team = '';
  let laptopPersonal = '';
  let laptopTeam = '';
  let friendTeam = '';
  const topic = (room: string) => `agentnauts:${room}`;
  const connect = async (user: string, room: string, key: string, name: string, details = false) =>
    (await as<{ id: string }>(user, 'select public.connect_agent($1, $2, $3, $4) as id', [room, key, name, details]))[0]!.id;

  before(async () => {
    await freshDb();
    const [room] = await as<{ id: string }>(OWNER, `select (public.create_room($1, 'Base', 'Olive')).id`, [CODE]);
    team = room!.id;
    await as(FRIEND, 'select * from public.request_to_join($1, $2)', [CODE, 'Finn']);
    await as(OWNER, 'select public.approve_member($1, $2)', [team, FRIEND]);
  });

  it('gives each person one personal room that nobody can join', async () => {
    await rejects(as(null, `select public.my_room('x')`), /permission denied/);
    const [first] = await as<{ id: string; code: string; personal: boolean }>(OWNER, `select * from public.my_room('Olive')`);
    const [again] = await as<{ id: string }>(OWNER, `select * from public.my_room('Olive')`);
    personal = first!.id;
    assert.equal(first!.personal, true);
    assert.equal(again!.id, personal);
    assert.match(first!.code, /^crew(-[a-z2-9]{4}){3}$/);
    assert.deepEqual(await channelAccess(OWNER, topic(personal)), MEMBER);
    await rejects(as(FRIEND, 'select * from public.request_to_join($1, $2)', [first!.code, 'Finn']), /no room/);
    assert.deepEqual(await channelAccess(FRIEND, topic(personal)), NOTHING);
  });

  it('connects a computer only to rooms you are a member of', async () => {
    laptopPersonal = await connect(OWNER, personal, LAPTOP, "Olive's laptop");
    laptopTeam = await connect(OWNER, team, LAPTOP, "Olive's laptop");
    friendTeam = await connect(FRIEND, team, FRIENDS_LAPTOP, "Finn's laptop", true);
    await rejects(connect(STRANGER, team, DESKTOP, 'nope'), /join the room first/);
    await rejects(connect(FRIEND, personal, FRIENDS_LAPTOP, 'nope'), /join the room first/);
    await rejects(connect(OWNER, team, 'too-short', 'x'), /check constraint|violates/);
    // The same computer can't be claimed by a second person in the same room.
    await rejects(connect(FRIEND, team, LAPTOP, 'mine now'), /already connected/);

    const mine = await as<{ room_id: string; personal: boolean; share_details: boolean; device_name: string }>(
      OWNER,
      'select * from public.list_agents()',
    );
    assert.deepEqual(
      mine.map((a) => [a.room_id, a.personal, a.share_details]),
      [
        [personal, true, true], // your own room always gets the details
        [team, false, false],
      ],
    );
    // Connecting again updates the row instead of adding one.
    assert.equal(await connect(OWNER, team, LAPTOP, 'Work laptop', true), laptopTeam);
    const [updated] = await as<{ device_name: string; share_details: boolean }>(OWNER, 'select * from public.list_agents() where room_id = $1', [team]);
    assert.deepEqual([updated!.device_name, updated!.share_details], ['Work laptop', true]);
  });

  it('lets an agent token send to its own room and do nothing else', async () => {
    assert.deepEqual(await channelAccess(laptopTeam, topic(team)), AGENT);
    assert.deepEqual(await channelAccess(laptopPersonal, topic(personal)), AGENT);
    // One room each: the team credential is useless in the personal room and vice versa.
    assert.deepEqual(await channelAccess(laptopTeam, topic(personal)), NOTHING);
    assert.deepEqual(await channelAccess(laptopPersonal, topic(team)), NOTHING);
    assert.deepEqual(await channelAccess(friendTeam, topic(personal)), NOTHING);
    assert.deepEqual(await channelAccess(laptopTeam, 'someone-elses-topic'), NOTHING);

    // It is not a user: no tables, no room operations.
    assert.equal((await as(laptopTeam, 'select * from public.rooms')).length, 0);
    assert.equal((await as(laptopTeam, 'select * from public.room_members')).length, 0);
    assert.equal((await as(laptopTeam, 'select * from public.list_room_members($1)', [team])).length, 0);
    assert.equal((await as(laptopTeam, 'select * from public.list_agents()')).length, 0);
    assert.equal((await as(laptopTeam, 'select * from public.list_room_agents($1)', [team])).length, 0);
    await rejects(as(laptopTeam, 'select * from public.project_agents'), /permission denied/);
    await rejects(as(laptopTeam, `select public.create_room('crew-zzzz-zzzz-zzzz', 'x', 'x')`), /foreign key|violates/);
    await rejects(as(laptopTeam, `select public.my_room('x')`), /foreign key|violates/);
    await rejects(as(laptopTeam, 'select * from public.request_to_join($1, $2)', [CODE, 'x']), /foreign key|violates/);
    await rejects(connect(laptopTeam, team, DESKTOP, 'x'), /join the room first/);
    await rejects(as(laptopTeam, 'select public.approve_member($1, $2)', [team, STRANGER]), /only the room owner/);
    await rejects(as(laptopTeam, 'select public.delete_room($1)', [team]), /only the room owner/);
    await rejects(as(laptopTeam, 'select public.revoke_agent($1)', [friendTeam]), /no such connection/);
    await rejects(as(laptopTeam, 'select * from public.agent_login($1)', [LAPTOP]), /permission denied/);
  });

  it('tells members which keys may publish in a room, and whose they are', async () => {
    const forFriend = await as<{ public_key: string; display_name: string }>(FRIEND, 'select * from public.list_room_agents($1)', [team]);
    assert.deepEqual(
      forFriend.map((a) => [a.public_key, a.display_name]),
      [
        [LAPTOP, 'Olive'],
        [FRIENDS_LAPTOP, 'Finn'],
      ],
    );
    assert.equal((await as(STRANGER, 'select * from public.list_room_agents($1)', [team])).length, 0);
    assert.equal((await as(FRIEND, 'select * from public.list_room_agents($1)', [personal])).length, 0);
    await rejects(as(FRIEND, 'select * from public.project_agents'), /permission denied/);
  });

  it('hands the Edge Function a computer\'s live connections, and nobody else', async () => {
    await rejects(as(OWNER, 'select * from public.agent_login($1)', [LAPTOP]), /permission denied/);
    await rejects(as(null, 'select * from public.agent_login($1)', [LAPTOP]), /permission denied/);
    const rows = await asService<{ agent_id: string; room_id: string; display_name: string; share_details: boolean; personal: boolean }>(
      'select * from public.agent_login($1)',
      [LAPTOP],
    );
    assert.deepEqual(
      rows.map((r) => [r.agent_id, r.room_id, r.display_name, r.personal]),
      [
        [laptopPersonal, personal, 'Olive', true],
        [laptopTeam, team, 'Olive', false],
      ],
    );
    const [seen] = await as<{ last_seen_at: string | null }>(OWNER, 'select last_seen_at from public.list_agents() limit 1');
    assert.ok(seen!.last_seen_at);
    assert.equal((await asService('select * from public.agent_login($1)', [DESKTOP])).length, 0);
  });

  it('revokes one connection without touching the others', async () => {
    await rejects(as(STRANGER, 'select public.revoke_agent($1)', [laptopTeam]), /no such connection/);
    await rejects(as(FRIEND, 'select public.revoke_agent($1)', [laptopTeam]), /no such connection/);
    await as(OWNER, 'select public.revoke_agent($1)', [laptopTeam]);
    assert.deepEqual(await channelAccess(laptopTeam, topic(team)), NOTHING);
    // The person is still a member, and their personal room still works.
    assert.deepEqual(await channelAccess(OWNER, topic(team)), MEMBER);
    assert.deepEqual(await channelAccess(laptopPersonal, topic(personal)), AGENT);
    assert.deepEqual(await channelAccess(friendTeam, topic(team)), AGENT);
  });

  it('lets a room owner disconnect someone else\'s computer', async () => {
    await as(OWNER, 'select public.revoke_agent($1)', [friendTeam]);
    assert.deepEqual(await channelAccess(friendTeam, topic(team)), NOTHING);
    friendTeam = await connect(FRIEND, team, FRIENDS_LAPTOP, "Finn's laptop");
    assert.deepEqual(await channelAccess(friendTeam, topic(team)), AGENT);
  });

  it('lets a computer disconnect itself from every room, through the Edge Function only', async () => {
    const desktop = await connect(OWNER, personal, DESKTOP, "Olive's desktop");
    const desktopTeam = await connect(OWNER, team, DESKTOP, "Olive's desktop");
    assert.deepEqual(await channelAccess(desktopTeam, topic(team)), AGENT);
    await rejects(as(OWNER, 'select public.agent_logout($1)', [DESKTOP]), /permission denied/);
    await rejects(as(null, 'select public.agent_logout($1)', [DESKTOP]), /permission denied/);
    await rejects(as(desktop, 'select public.agent_logout($1)', [DESKTOP]), /permission denied/);

    assert.deepEqual(await asService('select public.agent_logout($1) as n', [DESKTOP]), [{ n: 2 }]);
    assert.deepEqual(await channelAccess(desktop, topic(personal)), NOTHING);
    assert.deepEqual(await channelAccess(desktopTeam, topic(team)), NOTHING);
    assert.deepEqual(await asService('select public.agent_logout($1) as n', [DESKTOP]), [{ n: 0 }]);
    // Other computers are untouched, and the person is still in their rooms.
    assert.deepEqual(await channelAccess(laptopPersonal, topic(personal)), AGENT);
    assert.deepEqual(await channelAccess(friendTeam, topic(team)), AGENT);
    assert.deepEqual(await channelAccess(OWNER, topic(team)), MEMBER);
  });

  it('disconnects your computers when you leave or are removed, or the room goes', async () => {
    await as(OWNER, 'select public.remove_member($1, $2)', [team, FRIEND]);
    assert.deepEqual(await channelAccess(friendTeam, topic(team)), NOTHING);
    assert.equal((await as(FRIEND, 'select * from public.list_agents()')).length, 0);

    laptopTeam = await connect(OWNER, team, LAPTOP, "Olive's laptop");
    assert.deepEqual(await channelAccess(laptopTeam, topic(team)), AGENT);
    await as(OWNER, 'select public.delete_room($1)', [team]);
    assert.deepEqual(await channelAccess(laptopTeam, topic(team)), NOTHING);
    assert.equal((await as(OWNER, 'select * from public.list_agents()')).length, 1);
  });
});
