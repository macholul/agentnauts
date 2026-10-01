/**
 * Tests the private-rooms migration (supabase/migrations) against a real
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
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema realtime;
  create table realtime.messages (id bigserial primary key, topic text not null, extension text not null, payload jsonb);
  alter table realtime.messages enable row level security;
  create function realtime.topic() returns text language sql stable
    as $$ select nullif(current_setting('realtime.topic', true), '') $$;
  grant usage on schema auth, realtime, public to anon, authenticated;
  grant select, insert on realtime.messages to authenticated;
  grant usage, select on sequence realtime.messages_id_seq to authenticated;
`;

const OWNER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const CODE = 'crew-abcd-efgh-jkmn';

let db: PGlite;

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

/** Would Realtime let `user` receive / send on `topic`? (What its authorization check does.) */
async function channelAccess(user: string, topic: string): Promise<{ receive: boolean; send: boolean }> {
  await db.exec(`reset role; delete from realtime.messages; insert into realtime.messages (topic, extension) values ('${topic}', 'broadcast');`);
  await db.exec(`select set_config('realtime.topic', '${topic}', false)`);
  const receive = (await as<{ n: number }>(user, 'select count(*)::int as n from realtime.messages'))[0]!.n > 0;
  let send = true;
  try {
    await as(user, `insert into realtime.messages (topic, extension) values ($1, 'broadcast')`, [topic]);
  } catch {
    send = false;
  }
  return { receive, send };
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: Error) => pattern.test(error.message));
}

describe('private rooms migration', () => {
  let roomId = '';
  let topic = '';

  before(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_STUB);
    await db.exec(`insert into auth.users values ('${OWNER}', 'owner@example.com'), ('${FRIEND}', 'friend@example.com'), ('${STRANGER}', 'stranger@example.com')`);
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }
  });

  it('lets a signed-in user create a room and nobody anonymous', async () => {
    await rejects(as(null, `select public.create_room($1, 'x', 'x')`, [CODE]), /permission denied/);
    await rejects(as(OWNER, `select public.create_room('my-room', 'Base', 'Olive')`), /check constraint|violates/);
    const [room] = await as<{ id: string }>(OWNER, `select (public.create_room($1, 'Base', 'Olive')).id`, [CODE]);
    roomId = room!.id;
    topic = `agentnauts:${roomId}`;
    assert.deepEqual(await channelAccess(OWNER, topic), { receive: true, send: true });
  });

  it('keeps rooms invisible and channels closed to outsiders', async () => {
    assert.equal((await as(STRANGER, 'select * from public.rooms')).length, 0);
    assert.equal((await as(STRANGER, 'select * from public.list_room_members($1)', [roomId])).length, 0);
    assert.deepEqual(await channelAccess(STRANGER, topic), { receive: false, send: false });
    await rejects(as(STRANGER, `insert into public.room_members values ($1, $2, 'me', 'member')`, [roomId, STRANGER]), /permission denied/);
  });

  it('makes join requests wait for the owner', async () => {
    const [request] = await as<{ status: string }>(FRIEND, 'select * from public.request_to_join($1, $2)', [CODE, 'Finn']);
    assert.equal(request!.status, 'pending');
    assert.deepEqual(await channelAccess(FRIEND, topic), { receive: false, send: false });
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
    assert.deepEqual(await channelAccess(FRIEND, topic), { receive: true, send: true });
    const forFriend = await as<{ email: string | null }>(FRIEND, 'select * from public.list_room_members($1)', [roomId]);
    assert.equal(forFriend.length, 2);
    assert.ok(forFriend.every((m) => m.email === null));
    // Membership doesn't leak into other channels.
    const other = 'agentnauts:44444444-4444-4444-8444-444444444444';
    assert.deepEqual(await channelAccess(FRIEND, other), { receive: false, send: false });
    assert.deepEqual(await channelAccess(FRIEND, 'someone-elses-topic'), { receive: false, send: false });
  });

  it('closes the channel again when a member is removed or leaves', async () => {
    await rejects(as(FRIEND, 'select public.remove_member($1, $2)', [roomId, OWNER]), /owner cannot be removed/);
    await as(OWNER, 'select public.remove_member($1, $2)', [roomId, FRIEND]);
    assert.deepEqual(await channelAccess(FRIEND, topic), { receive: false, send: false });

    await as(FRIEND, 'select * from public.request_to_join($1, $2)', [CODE, 'Finn']);
    await as(OWNER, 'select public.approve_member($1, $2)', [roomId, FRIEND]);
    await as(FRIEND, 'select public.remove_member($1, $2)', [roomId, FRIEND]);
    assert.deepEqual(await channelAccess(FRIEND, topic), { receive: false, send: false });
  });

  it('only lets the owner delete the room', async () => {
    await rejects(as(FRIEND, 'select public.delete_room($1)', [roomId]), /only the room owner/);
    await as(OWNER, 'select public.delete_room($1)', [roomId]);
    assert.deepEqual(await channelAccess(OWNER, topic), { receive: false, send: false });
  });
});
