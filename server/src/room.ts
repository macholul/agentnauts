/**
 * What leaves this computer for a room, and how it is signed.
 *
 * Privacy rules enforced here:
 * - By default only tool names and states leave the machine: file names,
 *   commands, queries and project folder names are replaced or removed, and
 *   tools from MCP servers are all called the same (which services you use
 *   is your business). Your own personal room, and rooms where you opted
 *   in, get the details.
 * - Every message is signed with this machine's key, so nobody else can post
 *   as this computer.
 */
import {
  ENVELOPE_VERSION,
  MCP_TOOL_GENERIC,
  isMcpTool,
  type AgentEvent,
  type RoomEnvelope,
  type RoomSharing,
  type SignedRoomContent,
  type SignedRoomSnapshot,
} from '@agentnauts/shared';
import type { Identity } from './identity';

/**
 * Stable stand-ins for project folder names ("project 1", "project 2"...), so
 * others can tell your sessions apart without learning what you work on.
 */
export class ProjectAliases {
  private aliases = new Map<string, string>();

  alias(project: string): string {
    let alias = this.aliases.get(project);
    if (!alias) {
      alias = `project ${this.aliases.size + 1}`;
      this.aliases.set(project, alias);
    }
    return alias;
  }
}

/** One event as a room gets to see it. */
function sharedEvent(event: AgentEvent, room: RoomSharing, aliases: ProjectAliases): AgentEvent {
  if (room.shareDetails) return event;
  const { detail: _detail, sessionName, toolName, ...rest } = event;
  return {
    ...rest,
    ...(toolName ? { toolName: isMcpTool(toolName) ? MCP_TOOL_GENERIC : toolName } : {}),
    ...(sessionName ? { sessionName: aliases.alias(sessionName) } : {}),
  };
}

/** What actually leaves the machine for one event (before signing). Pure, for testing. */
export function toRoomContent(event: AgentEvent, room: RoomSharing, key: string, aliases: ProjectAliases): SignedRoomContent {
  return { room: room.roomId, owner: room.name, key, event: sharedEvent(event, room, aliases) };
}

/** The same for a snapshot of the agents this computer has right now. */
export function toRoomSnapshot(events: AgentEvent[], room: RoomSharing, key: string, aliases: ProjectAliases): SignedRoomSnapshot {
  return { room: room.roomId, owner: room.name, key, events: events.map((event) => sharedEvent(event, room, aliases)) };
}

/**
 * Serialize, encode and sign content into the wire envelope. Encoding keeps
 * commands and file names from being read as attacks by Supabase's gateway.
 */
export function signRoomContent(content: SignedRoomContent | SignedRoomSnapshot, identity: Identity): RoomEnvelope {
  const data = Buffer.from(JSON.stringify(content), 'utf8').toString('base64url');
  return { v: ENVELOPE_VERSION, data, sig: identity.sign(data) };
}
