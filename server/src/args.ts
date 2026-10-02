/** What was typed after `agentnauts`. */
import { parseArgs } from 'node:util';

export type Command =
  | 'start'
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'hooks install'
  | 'hooks uninstall'
  | 'hooks status'
  | 'uninstall'
  | 'help'
  | 'version';

export interface Invocation {
  command: Command;
  /** Install the Claude Code hooks when starting. */
  hooks: boolean;
  /** Open the browser when this computer needs connecting. */
  open: boolean;
  /** Print every event. */
  verbose: boolean;
}

/** The command line makes no sense; the message says how. */
export class UsageError extends Error {}

export const HELP = `agentnauts: watch your Claude Code agents as astronauts on a tiny planet

Usage
  agentnauts                   start: set up Claude Code, connect this computer,
                               and send your agents to the app (Ctrl+C stops it)
  agentnauts connect           connect this computer to your account
  agentnauts disconnect        stop this computer sending anything to your account
  agentnauts status            what is running, connected and installed
  agentnauts hooks install     add the Claude Code hooks (start does this too)
  agentnauts hooks uninstall   remove them
  agentnauts hooks status      whether they are installed
  agentnauts uninstall         disconnect, remove the hooks and this computer's key

Options
  --no-hooks      start without changing Claude Code's settings
  --no-open       don't open the browser
  --verbose       print every event as it arrives
  -v, --version
  -h, --help

Environment
  AGENTNAUTS_PORT   port the hooks talk to on this computer (default 4747)
`;

const COMMANDS: readonly Command[] = ['start', 'connect', 'disconnect', 'status', 'hooks install', 'hooks uninstall', 'hooks status', 'uninstall', 'help', 'version'];

export function parseInvocation(argv: readonly string[]): Invocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      allowNegative: true,
      options: {
        hooks: { type: 'boolean', default: true },
        open: { type: 'boolean', default: true },
        verbose: { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message.split('. ')[0]!);
  }
  const { values, positionals } = parsed;
  const typed = positionals.join(' ') || 'start';
  const command = values.help ? 'help' : values.version ? 'version' : COMMANDS.find((c) => c === typed);
  if (!command) throw new UsageError(typed === 'hooks' ? 'Say which: hooks install, hooks uninstall or hooks status' : `Unknown command "${typed}"`);
  return { command, hooks: values.hooks, open: values.open, verbose: values.verbose };
}
