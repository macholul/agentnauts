/**
 * AgentEvent: the normalized shape of everything that happens to an agent.
 *
 * Raw Claude Code hook payloads are converted into this shape by the server
 * (see server/src/normalize.ts). The fake simulator emits it directly. Any
 * future source (e.g. Supabase Realtime for multiplayer) only has to produce
 * AgentEvents; nothing downstream cares where they came from.
 */

export type AgentEventType =
  /** A Claude Code session started (or resumed). */
  | 'session_start'
  /** A Claude Code session ended. The commander leaves the chunk. */
  | 'session_end'
  /** A tool is about to run. */
  | 'tool_start'
  /** A tool finished running (successfully or not). */
  | 'tool_end'
  /** The agent needs the user: permission prompt, idle prompt, etc. */
  | 'notification'
  /** The user submitted a prompt; the agent is thinking. */
  | 'user_prompt'
  /** The agent finished its turn. */
  | 'stop'
  /** A subagent was launched. `subagent` is always set. */
  | 'subagent_start'
  /** A subagent finished. `subagent` is always set. */
  | 'subagent_stop';

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'session_start',
  'session_end',
  'tool_start',
  'tool_end',
  'notification',
  'user_prompt',
  'stop',
  'subagent_start',
  'subagent_stop',
];

export interface SubagentInfo {
  /** Stable id for the subagent within its session (Claude Code's agent_id). */
  id: string;
  /** Display name, e.g. the subagent type ("Explore", "general-purpose"). */
  name?: string;
}

export interface AgentEvent {
  /** Unique id of this event (for dedup and debugging). */
  id: string;
  /** The session the event belongs to. One session = one commander astronaut. */
  sessionId: string;
  type: AgentEventType;
  /** Tool name for tool_start / tool_end (e.g. "Read", "Bash"). */
  toolName?: string;
  /**
   * Short, human-readable detail for the HUD: a file name, a command, a
   * search query. Never the full tool input.
   */
  detail?: string;
  /** Set when the event happened inside (or is about) a subagent. */
  subagent?: SubagentInfo;
  /** Optional display name for the session, e.g. the project folder name. */
  sessionName?: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Where the event came from, e.g. "hooks" or "simulator". */
  source?: string;
}

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && (AGENT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Minimal structural check for events arriving over the network. It does not
 * validate every field, only what the frontend relies on.
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.sessionId === 'string' &&
    isAgentEventType(v.type) &&
    typeof v.timestamp === 'number'
  );
}

let idCounter = 0;

/**
 * Short unique-enough id. Deliberately avoids crypto.randomUUID, which is
 * missing in non-secure browser contexts (e.g. opening the app over a LAN IP).
 */
export function makeId(prefix = 'ev'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
