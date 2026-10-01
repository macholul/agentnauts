/**
 * Sharing your agents with a room means connecting your computers to it: one
 * row per computer per room, which that computer's daemon picks up within
 * half a minute. Stopping deletes those rows, which cuts it off at once.
 */
import { connectAgent, listAgents, revokeAgent, type MyAgent } from './roomsApi';
import { useSourceStore } from './sourceStore';

/** Load your computers and the rooms each publishes to. Call after connecting or disconnecting one. */
export async function refreshAgents(): Promise<void> {
  useSourceStore.getState().setAgents(await listAgents());
}

/** Your computers, one entry each (a computer has one row per room it publishes to). */
export function uniqueComputers(agents: MyAgent[]): MyAgent[] {
  const byKey = new Map<string, MyAgent>();
  // Prefer the personal-room row: its name is the one you gave the computer.
  for (const agent of agents) if (agent.personal || !byKey.has(agent.publicKey)) byKey.set(agent.publicKey, agent);
  return [...byKey.values()];
}

/** Milliseconds for a database timestamp. (Postgres sends microseconds, which not every browser parses.) */
export function timeOf(timestamp: string): number {
  return Date.parse(timestamp.replace(/(\.\d{3})\d+/, '$1'));
}

/**
 * A computer's daemon has not picked this connection up yet: it has not
 * checked in since the connection was made.
 */
export function isStarting(agent: MyAgent): boolean {
  return !agent.lastSeenAt || timeOf(agent.lastSeenAt) < timeOf(agent.createdAt);
}

/** Share all your computers' agents with a room (or change how much detail they send). */
export async function shareInRoom(roomId: string, details: boolean): Promise<void> {
  // Right after signing in the list may not be loaded yet.
  const agents = useSourceStore.getState().agents.length > 0 ? useSourceStore.getState().agents : await listAgents();
  for (const computer of uniqueComputers(agents)) await connectAgent(roomId, computer.publicKey, computer.deviceName, details);
  await refreshAgents();
}

/** Stop sharing with a room. You keep watching it. */
export async function stopSharingInRoom(roomId: string): Promise<void> {
  for (const agent of useSourceStore.getState().agents.filter((a) => a.roomId === roomId)) await revokeAgent(agent.id);
  await refreshAgents();
}
