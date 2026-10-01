-- The product is now called agentnauts. Room channels move from
-- 'groundcrew:<room uuid>' to 'agentnauts:<room uuid>'.
-- Run this in the Supabase SQL editor after the private-rooms migration.

create or replace function public.topic_room_id()
returns uuid
language plpgsql stable
as $$
declare
  t text := realtime.topic();
begin
  if t ~ '^agentnauts:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return substr(t, 12)::uuid;
  end if;
  return null;
end;
$$;

-- Same rules as before, under names without the old product name.
drop policy if exists "groundcrew members receive" on realtime.messages;
drop policy if exists "room members receive" on realtime.messages;
create policy "room members receive" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_member(public.topic_room_id())
  );

drop policy if exists "groundcrew members send" on realtime.messages;
drop policy if exists "room members send" on realtime.messages;
create policy "room members send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_member(public.topic_room_id())
  );
