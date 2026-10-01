/**
 * Pure mapping from a normalized AgentEvent to what the astronaut should do.
 * No side effects, no clocks, no randomness: same event in, same intent out.
 */
import type { AgentEvent } from './events';
import type { Intent, StationId } from './intent';

/** Which station each known tool is performed at. */
export const TOOL_STATIONS: Readonly<Record<string, StationId>> = {
  Edit: 'fabricator',
  Write: 'fabricator',
  MultiEdit: 'fabricator',
  NotebookEdit: 'fabricator',
  Read: 'scanner',
  Grep: 'scanner',
  Glob: 'scanner',
  LS: 'scanner',
  NotebookRead: 'scanner',
  Bash: 'drill',
  BashOutput: 'drill',
  KillShell: 'drill',
  KillBash: 'drill',
  WebSearch: 'radar',
  WebFetch: 'radar',
};

/** Tools from MCP servers are named `mcp__<server>__<tool>`. They reach outside the base, like the radar. */
export const MCP_PREFIX = 'mcp__';
/**
 * Stand-in for "some MCP tool". Rooms that only get tool names get this
 * instead of the real name, so which services you use stays private.
 */
export const MCP_TOOL_GENERIC = 'mcp__tool';

export function isMcpTool(toolName: string | undefined): boolean {
  return Boolean(toolName?.startsWith(MCP_PREFIX));
}

/** "Claude Browser: preview logs" for mcp__Claude_Browser__preview_logs. */
function mcpLabel(toolName: string): string {
  const [, server = '', ...rest] = toolName.split('__');
  const words = (text: string) => text.replace(/[_-]+/g, ' ').trim();
  const tool = words(rest.join(' '));
  if (!tool) return 'Using an outside tool';
  // Connectors are often registered under an id rather than a name.
  const named = /^[0-9a-f-]{16,}$/i.test(server) ? '' : words(server);
  return named ? `${named}: ${tool}` : `Using ${tool}`;
}

/** Tools that launch a subagent (named "Task" in older Claude Code, "Agent" in newer). */
export const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent'];

export function stationForTool(toolName: string | undefined): StationId | null {
  if (!toolName) return null;
  if (isMcpTool(toolName)) return 'radar';
  return TOOL_STATIONS[toolName] ?? null;
}

const VERBS: Readonly<Record<string, string>> = {
  Edit: 'Editing',
  MultiEdit: 'Editing',
  Write: 'Writing',
  NotebookEdit: 'Editing notebook',
  Read: 'Reading',
  Grep: 'Searching',
  Glob: 'Finding files',
  LS: 'Listing',
  NotebookRead: 'Reading',
  Bash: 'Running',
  BashOutput: 'Checking a background command',
  KillShell: 'Stopping a background command',
  KillBash: 'Stopping a background command',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching',
};

/** Short HUD text for a tool call, e.g. "Editing App.tsx" or "Running npm test". */
export function describeTool(toolName: string | undefined, detail: string | undefined): string {
  if (!toolName) return 'Working';
  if (SUBAGENT_TOOLS.includes(toolName)) return detail ? `Dispatching crew: ${detail}` : 'Dispatching crew';
  if (isMcpTool(toolName)) return detail ? `${mcpLabel(toolName)} ${detail}` : mcpLabel(toolName);
  const verb = VERBS[toolName] ?? `Using ${toolName}`;
  return detail ? `${verb} ${detail}` : verb;
}

export function mapEventToIntent(event: AgentEvent): Intent {
  switch (event.type) {
    case 'tool_start':
    case 'tool_end': {
      const activity = describeTool(event.toolName, event.detail);
      const station = stationForTool(event.toolName);
      if (station) return { kind: 'work', station, activity };
      // Tools without a station (Task/Agent, TodoWrite, ...) only show in the HUD.
      return { kind: 'idle', activity };
    }
    case 'notification':
      return { kind: 'wait', activity: event.detail ?? 'Waiting for you' };
    case 'stop':
      return { kind: 'idle', activity: 'Finished, taking a break' };
    case 'user_prompt':
      return { kind: 'idle', activity: 'Thinking…' };
    case 'session_start':
      return { kind: 'idle', activity: 'Just landed' };
    case 'subagent_start':
      return { kind: 'idle', activity: event.detail ?? 'Reporting for duty' };
    case 'subagent_stop':
    case 'session_end':
      return { kind: 'leave', activity: 'Heading home' };
  }
}
