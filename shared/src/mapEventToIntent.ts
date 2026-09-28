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
  Bash: 'drill',
  WebSearch: 'radar',
  WebFetch: 'radar',
};

/** Tools that launch a subagent (named "Task" in older Claude Code, "Agent" in newer). */
export const SUBAGENT_TOOLS: readonly string[] = ['Task', 'Agent'];

export function stationForTool(toolName: string | undefined): StationId | null {
  if (!toolName) return null;
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
  Bash: 'Running',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching',
};

/** Short HUD text for a tool call, e.g. "Editing App.tsx" or "Running npm test". */
export function describeTool(toolName: string | undefined, detail: string | undefined): string {
  if (!toolName) return 'Working';
  if (SUBAGENT_TOOLS.includes(toolName)) return detail ? `Dispatching crew: ${detail}` : 'Dispatching crew';
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
      // Unknown tools (MCP tools, Task/Agent, TodoWrite, ...) don't have a station.
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
