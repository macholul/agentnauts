/**
 * How the daemon talks to Supabase. It has no account session: it proves it
 * owns this computer's key, gets a send-only token for each room the key is
 * connected to, and posts signed events to those rooms' channels.
 */
import {
  agentAuthMessage,
  agentDisconnectMessage,
  parseAgentConnections,
  roomTopic,
  type AgentConnection,
  type CloudSettings,
} from '@agentnauts/shared';
import type { Identity } from './identity';

const TIMEOUT_MS = 8000;

export type CloudResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string; detail?: string };
    return body.detail ?? body.error ?? body.message ?? res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

/** Ask the agent-auth function for this computer's rooms and tokens. */
export async function fetchConnections(
  cloud: CloudSettings,
  identity: Identity,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<CloudResult<AgentConnection[]>> {
  const timestamp = now();
  try {
    const res = await fetchFn(`${cloud.url}/functions/v1/agent-auth`, {
      method: 'POST',
      headers: { apikey: cloud.key, Authorization: `Bearer ${cloud.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: identity.publicKey,
        timestamp,
        signature: identity.sign(agentAuthMessage(identity.publicKey, timestamp)),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await errorText(res) };
    const connections = parseAgentConnections(await res.json());
    return connections ? { ok: true, value: connections } : { ok: false, status: 502, error: 'unexpected answer from agent-auth' };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}

/**
 * Disconnect this computer from every room it publishes to. Answers with how
 * many connections were removed.
 */
export async function disconnectComputer(
  cloud: CloudSettings,
  identity: Identity,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<CloudResult<number>> {
  const timestamp = now();
  try {
    const res = await fetchFn(`${cloud.url}/functions/v1/agent-auth`, {
      method: 'POST',
      headers: { apikey: cloud.key, Authorization: `Bearer ${cloud.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'disconnect',
        publicKey: identity.publicKey,
        timestamp,
        signature: identity.sign(agentDisconnectMessage(identity.publicKey, timestamp)),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: await errorText(res) };
    const removed = ((await res.json()) as { disconnected?: unknown } | null)?.disconnected;
    return typeof removed === 'number' ? { ok: true, value: removed } : { ok: false, status: 502, error: 'unexpected answer from agent-auth' };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}

/** Post one broadcast to a room's private channel with that room's token. */
export async function publish(
  cloud: CloudSettings,
  connection: Pick<AgentConnection, 'roomId' | 'token'>,
  event: string,
  payload: unknown,
  fetchFn: typeof fetch = fetch,
  topic: string = roomTopic(connection.roomId),
): Promise<CloudResult<null>> {
  const url = `${cloud.url}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}?private=true`;
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { apikey: cloud.key, Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 202) return { ok: true, value: null };
    return { ok: false, status: res.status, error: await errorText(res) };
  } catch (error) {
    return { ok: false, status: 0, error: (error as Error).message };
  }
}
