/**
 * Private-room operations. All of them run as the signed-in user; the
 * database (supabase/migrations) decides what that user may do.
 */
import { generateRoomCode } from '@agentnauts/shared';
import { getSupabase } from './supabase';

export interface JoinedRoom {
  id: string;
  code: string;
  name: string;
  /** You own it (can approve and remove people). */
  owner: boolean;
  status: 'pending' | 'member';
}

export interface RoomMember {
  userId: string;
  name: string;
  status: 'pending' | 'member';
  /** Only visible to the room owner. */
  email: string | null;
  isOwner: boolean;
}

function db() {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Multiplayer is not set up in this build');
  return supabase;
}

/** Turn database errors into something a person can act on. */
function friendly(error: { message: string }): Error {
  const message = error.message;
  if (/no room/i.test(message)) return new Error('No room with that code.');
  if (/JWT|not authenticated|sign in/i.test(message)) return new Error('Please sign in again.');
  return new Error(message);
}

export async function createRoom(name: string, displayName: string): Promise<JoinedRoom> {
  const code = generateRoomCode((n) => window.crypto.getRandomValues(new Uint32Array(n)));
  const { data, error } = await db().rpc('create_room', { p_code: code, p_name: name, p_display_name: displayName });
  if (error) throw friendly(error);
  const room = data as { id: string; code: string; name: string };
  return { id: room.id, code: room.code, name: room.name, owner: true, status: 'member' };
}

export async function requestToJoin(code: string, displayName: string, userId: string): Promise<JoinedRoom> {
  const { data, error } = await db().rpc('request_to_join', { p_code: code, p_display_name: displayName });
  if (error) throw friendly(error);
  const row = (data as { room_id: string; room_name: string; status: 'pending' | 'member' }[])[0];
  if (!row) throw new Error('No room with that code.');
  const owner = await isOwner(row.room_id, userId);
  return { id: row.room_id, code, name: row.room_name, owner, status: row.status };
}

async function isOwner(roomId: string, userId: string): Promise<boolean> {
  const { data } = await db().from('rooms').select('owner').eq('id', roomId).maybeSingle();
  return (data as { owner?: string } | null)?.owner === userId;
}

/** Your current status in a room, or null if you're no longer in it. */
export async function myStatus(roomId: string, userId: string): Promise<'pending' | 'member' | null> {
  const { data, error } = await db()
    .from('room_members')
    .select('status')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw friendly(error);
  return (data as { status?: 'pending' | 'member' } | null)?.status ?? null;
}

export async function listMembers(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await db().rpc('list_room_members', { p_room: roomId });
  if (error) throw friendly(error);
  return (data as { user_id: string; display_name: string; status: 'pending' | 'member'; email: string | null; is_owner: boolean }[]).map(
    (m) => ({ userId: m.user_id, name: m.display_name, status: m.status, email: m.email, isOwner: m.is_owner }),
  );
}

export async function approveMember(roomId: string, userId: string): Promise<void> {
  const { error } = await db().rpc('approve_member', { p_room: roomId, p_user: userId });
  if (error) throw friendly(error);
}

/** Owner: deny/remove someone. Anyone: pass your own id to leave. */
export async function removeMember(roomId: string, userId: string): Promise<void> {
  const { error } = await db().rpc('remove_member', { p_room: roomId, p_user: userId });
  if (error) throw friendly(error);
}

export async function deleteRoom(roomId: string): Promise<void> {
  const { error } = await db().rpc('delete_room', { p_room: roomId });
  if (error) throw friendly(error);
}
