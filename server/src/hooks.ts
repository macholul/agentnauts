/**
 * Installs and removes the Claude Code hooks that send events to the daemon.
 *
 * They live in the person's own settings file (~/.claude/settings.json), next
 * to whatever else is there. Rules:
 * - Only our own hooks are ever added, changed or removed. They are told
 *   apart by a marker at the end of the command.
 * - A file that can't be read as JSON is left alone.
 * - Installing twice changes nothing; uninstalling leaves the settings as
 *   they were.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The hook events the daemon understands, and whether they take a tool matcher. */
export const HOOK_EVENTS: readonly (readonly [event: string, perTool: boolean])[] = [
  ['PreToolUse', true],
  ['PostToolUse', true],
  ['PostToolUseFailure', true],
  ['UserPromptSubmit', false],
  ['Notification', false],
  ['Stop', false],
  ['SubagentStart', false],
  ['SubagentStop', false],
  ['SessionStart', false],
  ['SessionEnd', false],
];

/** Ends every command we install (a shell comment), so we can find ours again. */
export const HOOK_MARKER = '# agentnauts';

/** The command people pasted by hand before there was an installer. */
const LEGACY_COMMAND = /^curl -s -X POST -H 'Content-Type: application\/json' -d @- http:\/\/localhost:\d+\/event \|\| true$/;

/**
 * Pipes the hook's JSON (stdin) to the daemon. The time limits and `|| true`
 * mean a stopped or stuck daemon never breaks or slows Claude Code. The
 * daemon answers with an empty body, so nothing lands on the hook's stdout.
 *
 * A shell command on purpose: Claude Code runs it with `sh` on macOS and
 * Linux and with Git Bash on Windows. (Its no-shell form, `args`, has no way
 * to ignore curl's exit code, and a failed hook is shown to the person.)
 */
export function hookCommand(port: number): string {
  // Half a second to connect: instant when the daemon runs, and Windows takes
  // seconds to report that nothing is listening.
  return `curl -s --connect-timeout 0.5 -m 2 -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:${port}/event || true ${HOOK_MARKER}`;
}

/** Claude Code gives up on the hook after this long, should curl's own limits ever not be enough. */
const HOOK_TIMEOUT_SECONDS = 5;

export function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const text = command.trim();
  return text.endsWith(HOOK_MARKER) || LEGACY_COMMAND.test(text);
}

export type JsonObject = { [key: string]: unknown };

/** The settings file can't be changed safely; the message says why. */
export class HooksError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `hooks` section, checked to have the shape Claude Code documents. */
function hooksSection(settings: JsonObject): JsonObject {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new HooksError('its "hooks" section is not an object');
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new HooksError(`its "hooks.${event}" is not a list`);
  }
  return hooks;
}

/** Our commands in one event's groups. */
function ourCommands(groups: unknown[]): { command: string; matcher: unknown }[] {
  const found: { command: string; matcher: unknown }[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (isObject(hook) && isOurCommand(hook.command)) found.push({ command: hook.command as string, matcher: group.matcher });
    }
  }
  return found;
}

/** One event's groups without our hooks; groups left empty by that are dropped. */
function withoutOurs(groups: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const others = group.hooks.filter((hook) => !(isObject(hook) && isOurCommand(hook.command)));
    if (others.length === group.hooks.length) kept.push(group);
    else if (others.length > 0) kept.push({ ...group, hooks: others });
  }
  return kept;
}

/** No matcher, "" and "*" all mean: every tool (or session, or notification). */
const matchesEverything = (matcher: unknown) => matcher === undefined || matcher === '' || matcher === '*';

/** Settings with our hooks for `port` in every event. Returns the same object when nothing needs to change. */
export function withHooks(settings: JsonObject, port: number): JsonObject {
  const hooks = hooksSection(settings);
  const command = hookCommand(port);
  const next: JsonObject = { ...hooks };
  let changed = false;
  for (const [event, perTool] of HOOK_EVENTS) {
    const groups = (hooks[event] as unknown[] | undefined) ?? [];
    const ours = ourCommands(groups);
    if (ours.length === 1 && ours[0]!.command === command && matchesEverything(ours[0]!.matcher)) continue;
    const group = { ...(perTool ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] };
    next[event] = [...withoutOurs(groups), group];
    changed = true;
  }
  return changed ? { ...settings, hooks: next } : settings;
}

/** Settings without any of our hooks. Returns the same object when there were none. */
export function withoutHooks(settings: JsonObject): JsonObject {
  const hooks = hooksSection(settings);
  const next: JsonObject = {};
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = withoutOurs(groups as unknown[]);
    if (kept.length === (groups as unknown[]).length && kept.every((group, i) => group === (groups as unknown[])[i])) {
      next[event] = groups;
      continue;
    }
    changed = true;
    if (kept.length > 0) next[event] = kept;
  }
  if (!changed) return settings;
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(next).length > 0 ? { ...settings, hooks: next } : rest;
}

export type HooksState = 'installed' | 'outdated' | 'missing';

/** Whether new Claude Code sessions will reach a daemon on `port`. */
export function hooksState(settings: JsonObject, port: number): HooksState {
  if (withHooks(settings, port) === settings) return 'installed';
  return withoutHooks(settings) === settings ? 'missing' : 'outdated';
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Claude Code's settings file for this user. */
export function settingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'), 'settings.json');
}

interface Loaded {
  settings: JsonObject;
  /** The file's text, or null when there is no file. */
  text: string | null;
}

function load(file: string): Loaded {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, text: null };
    throw new HooksError(`it could not be read (${(error as Error).message})`);
  }
  if (text.trim() === '') return { settings: {}, text };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    throw new HooksError('it is not valid JSON');
  }
  if (!isObject(settings)) throw new HooksError('it does not hold a settings object');
  return { settings, text };
}

/** Write settings the way the file was written before: same indentation, line endings and final newline. */
function save(file: string, settings: JsonObject, previous: string | null): void {
  const indent = previous?.match(/^\{\r?\n([ \t]+)\S/)?.[1] ?? '  ';
  let text = JSON.stringify(settings, null, indent);
  if (previous === null || previous.trim() === '' || /\n\s*$/.test(previous)) text += '\n';
  if (previous?.includes('\r\n')) text = text.replace(/\n/g, '\r\n');

  try {
    // Through a link (dotfiles setups), write the file it points to.
    const target = existsSync(file) ? realpathSync(file) : file;
    mkdirSync(dirname(target), { recursive: true });
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
    // Whole file or nothing: a crash halfway must not leave broken settings.
    const temporary = `${target}.agentnauts-${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, target);
  } catch (error) {
    throw new HooksError(`it could not be written (${(error as Error).message})`);
  }
}

/** What the file says now. Throws HooksError if it can't be understood. */
export function installedHooks(file: string, port: number): HooksState {
  return hooksState(load(file).settings, port);
}

/** Add or update our hooks. Throws HooksError if the file can't be changed safely. */
export function installHooks(file: string, port: number): 'added' | 'updated' | 'unchanged' {
  const { settings, text } = load(file);
  const before = hooksState(settings, port);
  if (before === 'installed') return 'unchanged';
  save(file, withHooks(settings, port), text);
  return before === 'missing' ? 'added' : 'updated';
}

/** Remove our hooks. Throws HooksError if the file can't be changed safely. */
export function uninstallHooks(file: string): 'removed' | 'none' {
  const { settings, text } = load(file);
  const next = withoutHooks(settings);
  if (next === settings) return 'none';
  save(file, next, text);
  return 'removed';
}
