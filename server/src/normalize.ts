/**
 * Normalize raw Claude Code hook payloads (what the hook pipes to stdin)
 * into AgentEvents. Pure: no I/O, no global state.
 *
 * Only a short `detail` (file name, command, query) is extracted from tool
 * input; the full input/output never leaves this function.
 */
import { SUBAGENT_TOOLS, makeId, type AgentEvent, type AgentEventType, type SubagentInfo } from '@agentnauts/shared';

export interface NormalizeResult {
  events: AgentEvent[];
  /** Why the payload produced no events (unknown or malformed), for logging. */
  warning?: string;
}

/** Notification types that mean "the agent is waiting on the user". */
const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

const MAX_DETAIL = 48;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncate(text: string, max = MAX_DETAIL): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return truncate(url);
  }
}

/** A short, human-readable summary of what a tool call is about. */
export function toolDetail(toolName: string | undefined, input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const path = str(input.file_path) ?? str(input.notebook_path);
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return path ? basename(path) : undefined;
    case 'Bash': {
      const command = str(input.command);
      return command ? truncate(command.split('\n')[0] ?? command) : undefined;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      return pattern ? truncate(`"${pattern}"`) : undefined;
    }
    case 'Glob':
      return str(input.pattern) ? truncate(str(input.pattern)!) : undefined;
    case 'LS':
      return str(input.path) ? basename(str(input.path)!) : undefined;
    case 'WebSearch':
      return str(input.query) ? truncate(str(input.query)!) : undefined;
    case 'WebFetch':
      return str(input.url) ? hostname(str(input.url)!) : undefined;
    default:
      if (toolName && SUBAGENT_TOOLS.includes(toolName)) {
        const what = str(input.description) ?? str(input.subagent_type);
        return what ? truncate(what) : undefined;
      }
      return path ? basename(path) : undefined;
  }
}

function notificationDetail(payload: Json): { waiting: boolean; detail: string } {
  const type = str(payload.notification_type);
  const message = str(payload.message);
  if (type) {
    const waiting = WAITING_NOTIFICATIONS.has(type);
    const detail =
      type === 'permission_prompt'
        ? 'Needs your permission'
        : type === 'idle_prompt'
          ? 'Waiting for your input'
          : message
            ? truncate(message)
            : type.replace(/_/g, ' ');
    return { waiting, detail };
  }
  // Older payloads only carry a message, e.g. "Claude needs your permission to use Bash".
  if (message) {
    return { waiting: /permission|waiting|input|needs|approve/i.test(message), detail: truncate(message) };
  }
  return { waiting: true, detail: 'Waiting for you' };
}

function subagentOf(payload: Json): SubagentInfo | undefined {
  const id = str(payload.agent_id);
  if (!id) return undefined;
  const name = str(payload.agent_type);
  return name ? { id, name } : { id };
}

/**
 * Convert one hook payload into zero or more AgentEvents.
 * Unknown or malformed payloads return no events and a warning.
 */
export function normalizeHookPayload(payload: unknown, now: number = Date.now()): NormalizeResult {
  if (!isObject(payload)) return { events: [], warning: 'payload is not a JSON object' };

  const hook = str(payload.hook_event_name);
  const sessionId = str(payload.session_id);
  if (!hook) return { events: [], warning: 'missing hook_event_name' };
  if (!sessionId) return { events: [], warning: `missing session_id (${hook})` };

  const cwd = str(payload.cwd);
  const subagent = subagentOf(payload);
  const base = {
    sessionId,
    timestamp: now,
    source: 'hooks',
    ...(cwd ? { sessionName: basename(cwd) } : {}),
  };
  const event = (type: AgentEventType, extra: Partial<AgentEvent> = {}): AgentEvent => ({
    id: makeId(),
    type,
    ...base,
    ...extra,
  });

  switch (hook) {
    case 'SessionStart':
      return { events: [event('session_start')] };

    case 'SessionEnd':
      return { events: [event('session_end')] };

    case 'UserPromptSubmit':
      return { events: [event('user_prompt')] };

    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const toolName = str(payload.tool_name);
      if (!toolName) return { events: [], warning: `${hook} without tool_name` };
      const detail = toolDetail(toolName, payload.tool_input);
      return {
        events: [
          event(hook === 'PreToolUse' ? 'tool_start' : 'tool_end', {
            toolName,
            ...(detail ? { detail } : {}),
            ...(subagent ? { subagent } : {}),
          }),
        ],
      };
    }

    case 'Notification': {
      const { waiting, detail } = notificationDetail(payload);
      if (!waiting) return { events: [], warning: `informational notification ignored (${detail})` };
      return { events: [event('notification', { detail, ...(subagent ? { subagent } : {}) })] };
    }

    case 'Stop':
      // A Stop fired inside a subagent means that subagent is done.
      return { events: [subagent ? event('subagent_stop', { subagent }) : event('stop')] };

    case 'SubagentStart': {
      if (!subagent) return { events: [], warning: 'SubagentStart without agent_id' };
      return { events: [event('subagent_start', { subagent })] };
    }

    case 'SubagentStop': {
      // Older Claude Code versions don't say which subagent stopped.
      if (!subagent) return { events: [], warning: 'SubagentStop without agent_id (needs a newer Claude Code)' };
      return { events: [event('subagent_stop', { subagent })] };
    }

    default:
      return { events: [], warning: `unknown hook_event_name "${hook}"` };
  }
}
