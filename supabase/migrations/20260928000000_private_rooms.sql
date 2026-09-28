-- groundcrew: private multiplayer rooms.
--
-- Run once in the Supabase SQL editor (or `supabase db push`). Rooms are
-- private: only members the owner approved can send or receive on a room's
-- Realtime channel, enforced by row level security on realtime.messages.
--
-- Channel topic for a room: 'groundcrew:<room uuid>'.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  -- What people type to ask to join (crew-xxxx-xxxx-xxxx). Knowing it only
  -- lets you *ask*; the owner decides.
  code text not null unique check (code ~ '^crew(-[abcdefghjkmnpqrstuvwxyz23456789]{4}){3}$'),
  name text not null check (char_length(name) between 1 and 40),
  owner uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  status text not null check (status in ('pending', 'member')),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx on public.room_members (user_id);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers (security definer so policies don't recurse into each other)
-- ---------------------------------------------------------------------------

create or replace function public.is_room_member(p_room uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room and user_id = auth.uid() and status = 'member'
  );
$$;

create or replace function public.is_room_owner(p_room uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.rooms where id = p_room and owner = auth.uid());
$$;

-- Room id from the current Realtime topic, or null if it isn't one of ours.
create or replace function public.topic_room_id()
returns uuid
language plpgsql stable
as $$
declare
  t text := realtime.topic();
begin
  if t ~ '^groundcrew:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return substr(t, 12)::uuid;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: tables are read-only to clients; changes go through
-- the functions below.
-- ---------------------------------------------------------------------------

drop policy if exists "members see their rooms" on public.rooms;
create policy "members see their rooms" on public.rooms
  for select to authenticated
  using (owner = auth.uid() or public.is_room_member(id));

drop policy if exists "members see each other" on public.room_members;
create policy "members see each other" on public.room_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_room_member(room_id) or public.is_room_owner(room_id));

revoke all on public.rooms, public.room_members from anon;
revoke insert, update, delete on public.rooms, public.room_members from authenticated;
grant select on public.rooms, public.room_members to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: only approved members may send or receive on a room's channel.
-- ---------------------------------------------------------------------------

drop policy if exists "groundcrew members receive" on realtime.messages;
create policy "groundcrew members receive" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_member(public.topic_room_id())
  );

drop policy if exists "groundcrew members send" on realtime.messages;
create policy "groundcrew members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_member(public.topic_room_id())
  );

-- ---------------------------------------------------------------------------
-- Functions the app calls
-- ---------------------------------------------------------------------------

-- Create a room; the caller becomes its owner and first member.
create or replace function public.create_room(p_code text, p_name text, p_display_name text)
returns public.rooms
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.rooms (code, name, owner) values (p_code, trim(p_name), auth.uid()) returning * into r;
  insert into public.room_members (room_id, user_id, display_name, status)
    values (r.id, auth.uid(), trim(p_display_name), 'member');
  return r;
end;
$$;

-- Ask to join a room by its code. Returns the room and your status
-- ('pending' until the owner approves, or 'member').
create or replace function public.request_to_join(p_code text, p_display_name text)
returns table (room_id uuid, room_name text, status text)
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into r from public.rooms where code = lower(trim(p_code));
  if not found then raise exception 'no room with that code'; end if;
  insert into public.room_members (room_id, user_id, display_name, status)
    values (r.id, auth.uid(), trim(p_display_name), case when r.owner = auth.uid() then 'member' else 'pending' end)
    on conflict on constraint room_members_pkey do nothing;
  return query
    select r.id, r.name, m.status from public.room_members m where m.room_id = r.id and m.user_id = auth.uid();
end;
$$;

-- Everyone in a room (and pending requests). Only members and the owner can
-- list; email addresses are only shown to the owner, to vet requests.
create or replace function public.list_room_members(p_room uuid)
returns table (user_id uuid, display_name text, status text, email text, is_owner boolean)
language sql stable security definer set search_path = public
as $$
  select m.user_id, m.display_name, m.status,
         case when public.is_room_owner(p_room) then u.email else null end,
         m.user_id = r.owner
  from public.room_members m
  join public.rooms r on r.id = m.room_id
  join auth.users u on u.id = m.user_id
  where m.room_id = p_room
    and (public.is_room_member(p_room) or public.is_room_owner(p_room))
    and (m.status = 'member' or public.is_room_owner(p_room))
  order by m.created_at;
$$;

-- Owner: approve a pending request.
create or replace function public.approve_member(p_room uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_room_owner(p_room) then raise exception 'only the room owner can do that'; end if;
  update public.room_members set status = 'member' where room_id = p_room and user_id = p_user;
end;
$$;

-- Owner: deny a request or remove a member. Anyone: remove yourself (leave).
create or replace function public.remove_member(p_room uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  owner_id uuid;
begin
  select owner into owner_id from public.rooms where id = p_room;
  if p_user = owner_id then raise exception 'the owner cannot be removed; delete the room instead'; end if;
  if not (public.is_room_owner(p_room) or p_user = auth.uid()) then
    raise exception 'only the room owner can do that';
  end if;
  delete from public.room_members where room_id = p_room and user_id = p_user;
end;
$$;

-- Owner: delete the room for everyone.
create or replace function public.delete_room(p_room uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_room_owner(p_room) then raise exception 'only the room owner can do that'; end if;
  delete from public.rooms where id = p_room;
end;
$$;

revoke execute on function
  public.create_room(text, text, text),
  public.request_to_join(text, text),
  public.list_room_members(uuid),
  public.approve_member(uuid, uuid),
  public.remove_member(uuid, uuid),
  public.delete_room(uuid)
  from public, anon;
grant execute on function
  public.create_room(text, text, text),
  public.request_to_join(text, text),
  public.list_room_members(uuid),
  public.approve_member(uuid, uuid),
  public.remove_member(uuid, uuid),
  public.delete_room(uuid)
  to authenticated;
