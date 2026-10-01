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
  /** Your own room of one, where your computers send everything. */
  personal?: boolean;
}

/** One of your computers, connected to one room. */
export interface MyAgent {
  id: string;
  roomId: string;
  roomName: string;
  personal: boolean;
  /** The computer's public key (its ID). */
  publicKey: string;
  deviceName: string;
  shareDetails: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** A computer that may publish in a room, and whose it is. */
export interface RoomAgent {
  publicKey: string;
  userId: string;
  /** The owner's display name in that room. */
  name: string;
  deviceName: string;
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
  if (/already connected/i.test(message)) return new Error('That computer is already connected to this room by someone else.');
  if (/join the room first/i.test(message)) return new Error('You are not a member of that room.');
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

/** Your personal room (created the first time). Your computers send everything here. */
export async function myRoom(displayName: string): Promise<JoinedRoom> {
  const { data, error } = await db().rpc('my_room', { p_display_name: displayName });
  if (error) throw friendly(error);
  const room = data as { id: string; code: string; name: string };
  return { id: room.id, code: room.code, name: room.name, owner: true, status: 'member', personal: true };
}

/** Connect one of your computers to a room (or update its name and details setting). */
export async function connectAgent(roomId: string, publicKey: string, deviceName: string, shareDetails: boolean): Promise<void> {
  const { error } = await db().rpc('connect_agent', {
    p_room: roomId,
    p_public_key: publicKey,
    p_device_name: deviceName,
    p_share_details: shareDetails,
  });
  if (error) throw friendly(error);
}

/** Disconnect a computer from a room. It is cut off at once. */
export async function revokeAgent(agentId: string): Promise<void> {
  const { error } = await db().rpc('revoke_agent', { p_agent: agentId });
  if (error) throw friendly(error);
}

export async function listAgents(): Promise<MyAgent[]> {
  const { data, error } = await db().rpc('list_agents');
  if (error) throw friendly(error);
  return (
    data as {
      id: string; room_id: string; room_name: string; personal: boolean; public_key: string;
      device_name: string; share_details: boolean; created_at: string; last_seen_at: string | null;
    }[]
  ).map((a) => ({
    id: a.id,
    roomId: a.room_id,
    roomName: a.room_name,
    personal: a.personal,
    publicKey: a.public_key,
    deviceName: a.device_name,
    shareDetails: a.share_details,
    createdAt: a.created_at,
    lastSeenAt: a.last_seen_at,
  }));
}

/** The computers that may publish in a room. Events signed by any other key are dropped. */
export async function listRoomAgents(roomId: string): Promise<RoomAgent[]> {
  const { data, error } = await db().rpc('list_room_agents', { p_room: roomId });
  if (error) throw friendly(error);
  return (data as { public_key: string; user_id: string; display_name: string; device_name: string }[]).map((a) => ({
    publicKey: a.public_key,
    userId: a.user_id,
    name: a.display_name,
    deviceName: a.device_name,
  }));
}
