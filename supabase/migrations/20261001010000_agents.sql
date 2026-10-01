-- agentnauts: personal rooms and per-room agent credentials.
--
-- Run in the Supabase SQL editor after the earlier migrations.
--
-- The daemon on someone's computer never holds their account session. For
-- each room it publishes to it has one row in project_agents, identified by
-- that computer's Ed25519 public key. The agent-auth Edge Function swaps a
-- signed proof for a short-lived token whose subject is that row's id (not a
-- user id), so every rule written for users denies it by default. The one
-- thing it may do is send broadcasts to its own room's channel, and only
-- while the row exists. Deleting the row revokes it at once.

-- ---------------------------------------------------------------------------
-- Personal rooms: a room of one, for watching your own agents.
-- ---------------------------------------------------------------------------

alter table public.rooms add column if not exists personal boolean not null default false;
create unique index if not exists rooms_one_personal_per_owner on public.rooms (owner) where personal;

create or replace function public.new_room_code()
returns text
language plpgsql volatile
as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  code text := 'crew';
begin
  for i in 0..11 loop
    if i % 4 = 0 then code := code || '-'; end if;
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;

-- Your personal room, created the first time you ask for it.
create or replace function public.my_room(p_display_name text)
returns public.rooms
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into r from public.rooms where owner = auth.uid() and personal;
  if found then return r; end if;
  begin
    insert into public.rooms (code, name, owner, personal)
      values (public.new_room_code(), 'My agents', auth.uid(), true) returning * into r;
    insert into public.room_members (room_id, user_id, display_name, status)
      values (r.id, auth.uid(), trim(p_display_name), 'member');
  exception when unique_violation then
    -- Another tab created it a moment ago.
    select * into r from public.rooms where owner = auth.uid() and personal;
  end;
  return r;
end;
$$;

-- Personal rooms can't be joined, even with their code.
create or replace function public.request_to_join(p_code text, p_display_name text)
returns table (room_id uuid, room_name text, status text)
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into r from public.rooms where code = lower(trim(p_code)) and not personal;
  if not found then raise exception 'no room with that code'; end if;
  insert into public.room_members (room_id, user_id, display_name, status)
    values (r.id, auth.uid(), trim(p_display_name), case when r.owner = auth.uid() then 'member' else 'pending' end)
    on conflict on constraint room_members_pkey do nothing;
  return query
    select r.id, r.name, m.status from public.room_members m where m.room_id = r.id and m.user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- Agent credentials: one row per computer per room.
-- ---------------------------------------------------------------------------

create table if not exists public.project_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- The computer's Ed25519 public key, base64url. Its private key never
  -- leaves that computer; no secret is stored here.
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  device_name text not null check (char_length(device_name) between 1 and 40),
  -- Also publish project names, files and commands (always on in a personal room).
  share_details boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (room_id, public_key)
);

create index if not exists project_agents_user_idx on public.project_agents (user_id);
create index if not exists project_agents_key_idx on public.project_agents (public_key);

-- No direct access: everything goes through the functions below.
alter table public.project_agents enable row level security;
revoke all on public.project_agents from anon, authenticated;

-- Connect one of your computers to a room you're a member of (or update its
-- name and details setting).
create or replace function public.connect_agent(
  p_room uuid,
  p_public_key text,
  p_device_name text,
  p_share_details boolean default false
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms;
  agent_id uuid;
begin
  if not public.is_room_member(p_room) then raise exception 'join the room first'; end if;
  select * into r from public.rooms where id = p_room;
  if (select count(*) from public.project_agents where room_id = p_room and user_id = auth.uid() and public_key <> p_public_key) >= 10 then
    raise exception 'too many computers connected to this room';
  end if;
  insert into public.project_agents (user_id, room_id, public_key, device_name, share_details)
    values (auth.uid(), p_room, p_public_key, trim(p_device_name), r.personal or coalesce(p_share_details, false))
    on conflict (room_id, public_key) do update
      set device_name = excluded.device_name, share_details = excluded.share_details
      where project_agents.user_id = auth.uid()
    returning id into agent_id;
  if agent_id is null then
    raise exception 'that computer is already connected to this room by someone else';
  end if;
  return agent_id;
end;
$$;

-- Disconnect a computer from a room. You can revoke your own; a room's owner
-- can revoke anyone's in that room.
create or replace function public.revoke_agent(p_agent uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.project_agents a
    where a.id = p_agent and (a.user_id = auth.uid() or public.is_room_owner(a.room_id));
  if not found then raise exception 'no such connection'; end if;
end;
$$;

-- Your connected computers, across rooms.
create or replace function public.list_agents()
returns table (
  id uuid, room_id uuid, room_name text, personal boolean, public_key text,
  device_name text, share_details boolean, created_at timestamptz, last_seen_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select a.id, a.room_id, r.name, r.personal, a.public_key, a.device_name, a.share_details, a.created_at, a.last_seen_at
  from public.project_agents a
  join public.rooms r on r.id = a.room_id
  where a.user_id = auth.uid()
  order by a.created_at;
$$;

-- Which keys may publish in a room, and whose they are. Members only.
-- Browsers use it to drop events signed by anything else.
create or replace function public.list_room_agents(p_room uuid)
returns table (public_key text, user_id uuid, display_name text, device_name text)
language sql stable security definer set search_path = public
as $$
  select a.public_key, a.user_id, m.display_name, a.device_name
  from public.project_agents a
  join public.room_members m on m.room_id = a.room_id and m.user_id = a.user_id and m.status = 'member'
  where a.room_id = p_room and public.is_room_member(p_room)
  order by a.created_at;
$$;

-- Leaving a room, or being removed from it, disconnects your computers from it.
create or replace function public.drop_member_agents()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  delete from public.project_agents where room_id = old.room_id and user_id = old.user_id;
  return old;
end;
$$;

drop trigger if exists room_members_drop_agents on public.room_members;
create trigger room_members_drop_agents
  after delete on public.room_members
  for each row execute function public.drop_member_agents();

-- For the agent-auth Edge Function only (service role): the live connections
-- of a computer, by its public key. Marks them as seen.
create or replace function public.agent_login(p_public_key text)
returns table (agent_id uuid, room_id uuid, room_name text, personal boolean, display_name text, share_details boolean)
language plpgsql security definer set search_path = public
as $$
begin
  update public.project_agents set last_seen_at = now() where public_key = p_public_key;
  return query
    select a.id, a.room_id, r.name, r.personal, m.display_name, a.share_details
    from public.project_agents a
    join public.rooms r on r.id = a.room_id
    join public.room_members m on m.room_id = a.room_id and m.user_id = a.user_id and m.status = 'member'
    where a.public_key = p_public_key
    order by a.created_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

-- Room of the agent row this token stands for, if the row still exists and
-- its owner is still a member. Null for ordinary users.
create or replace function public.agent_room_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select a.room_id
  from public.project_agents a
  join public.room_members m on m.room_id = a.room_id and m.user_id = a.user_id and m.status = 'member'
  where a.id = auth.uid();
$$;

-- Agents send events to their own room. They cannot receive anything.
drop policy if exists "agents send to their room" on realtime.messages;
create policy "agents send to their room" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.agent_room_id() = public.topic_room_id()
  );

-- Members watch a room and show up in its presence list, but no longer send
-- events themselves: only connected computers do.
drop policy if exists "room members send" on realtime.messages;
create policy "room members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and public.is_room_member(public.topic_room_id())
  );

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

revoke execute on function
  public.new_room_code(),
  public.my_room(text),
  public.request_to_join(text, text),
  public.connect_agent(uuid, text, text, boolean),
  public.revoke_agent(uuid),
  public.list_agents(),
  public.list_room_agents(uuid),
  public.drop_member_agents(),
  public.agent_login(text),
  public.agent_room_id()
  from public, anon, authenticated;
grant execute on function
  public.my_room(text),
  public.request_to_join(text, text),
  public.connect_agent(uuid, text, text, boolean),
  public.revoke_agent(uuid),
  public.list_agents(),
  public.list_room_agents(uuid),
  public.agent_room_id()
  to authenticated;
grant execute on function public.agent_login(text) to service_role;

-- ---------------------------------------------------------------------------
-- Tightening (from Supabase's security advisor)
-- ---------------------------------------------------------------------------

-- Helpers that don't need a search path shouldn't inherit the caller's.
alter function public.topic_room_id() set search_path = '';
alter function public.new_room_code() set search_path = '';

-- Membership checks are for signed-in users only.
revoke execute on function public.is_room_member(uuid), public.is_room_owner(uuid) from public, anon;
grant execute on function public.is_room_member(uuid), public.is_room_owner(uuid) to authenticated;
