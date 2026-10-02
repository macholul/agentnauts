/**
 * The `agentnauts` command.
 *
 *   agentnauts            set up Claude Code's hooks, connect this computer to
 *                         your account if it isn't yet, and run the daemon
 *   agentnauts connect    connect this computer (opens the app in a browser)
 *   agentnauts disconnect remove this computer's connections
 *   agentnauts status     what is running, connected and installed
 *   agentnauts hooks …    install / uninstall / status of the Claude Code hooks
 *   agentnauts uninstall  disconnect, remove the hooks and this computer's key
 */
import { rmSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { keyFingerprint } from '@agentnauts/shared';
import { HELP, UsageError, parseInvocation, type Invocation } from './args';
import { openInBrowser } from './browser';
import { disconnectComputer, fetchConnections } from './cloud';
import { SettingsError, readSettings, type Settings } from './config';
import { sharingNote, type ConnectionSummary } from './connections';
import { connectLinkFor, startDaemon, type Daemon, type DaemonStatus } from './daemon';
import { HooksError, installHooks, installedHooks, settingsFile, uninstallHooks } from './hooks';
import { DATA_DIR, IDENTITY_FILE, loadIdentity, loadOrCreateIdentity } from './identity';

// Filled in by the build (see build.mjs); missing when run from source.
declare const __VERSION__: string | undefined;
const FROM_SOURCE = typeof __VERSION__ !== 'string';
const VERSION = FROM_SOURCE ? 'dev' : __VERSION__;

const HOOKS_HELP = 'https://github.com/macholul/agentnauts#connecting-claude-code';
/** How long `connect` waits for the person to finish in the browser. */
const PAIRING_WAIT_MS = 10 * 60_000;

/** Something the person has to fix; printed without a stack trace. */
class Failure extends Error {}

const say = (line = ''): void => console.log(line);
/** A path the way people write it. */
const tilde = (path: string): string => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

// ---------------------------------------------------------------------------
// Talking to a daemon that is already running
// ---------------------------------------------------------------------------

/** The daemon on this port: its status, 'other' if another program has the port, null if nothing does. */
async function runningDaemon(port: number): Promise<DaemonStatus | 'other' | null> {
  try {
    // Generous: Windows takes about two seconds to say that nothing is listening.
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5000) });
    const status = (await res.json().catch(() => null)) as Partial<DaemonStatus> | null;
    return res.ok && status && typeof status.id === 'string' && Array.isArray(status.rooms) ? ({ port, ...status } as DaemonStatus) : 'other';
  } catch (error) {
    // Nothing answering at all is the normal "not running"; anything else has the port.
    return (error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED' ? null : 'other';
  }
}

/** Tell a running daemon that this computer's rooms changed, or are about to. */
async function nudgeDaemon(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/refresh`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
}

function roomLines(rooms: ConnectionSummary[]): string[] {
  return rooms.map((room) => `"${room.roomName}" as ${room.name} (${sharingNote(room)})`);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function sayHooksProblem(file: string, error: unknown): void {
  if (!(error instanceof HooksError)) throw error;
  say(`  Claude Code hooks: ${tilde(file)} was left alone, because ${error.message}.`);
  say(`  To add them by hand, see ${HOOKS_HELP}`);
}

/** Returns false if the settings file could not be changed. */
function setUpHooks(port: number): boolean {
  const file = settingsFile();
  try {
    const result = installHooks(file, port);
    if (result === 'added') say(`  Claude Code hooks: added to ${tilde(file)}`);
    else if (result === 'updated') say(`  Claude Code hooks: updated in ${tilde(file)}`);
    else say(`  Claude Code hooks: installed`);
    return true;
  } catch (error) {
    sayHooksProblem(file, error);
    return false;
  }
}

function removeHooks(): boolean {
  const file = settingsFile();
  try {
    const result = uninstallHooks(file);
    say(result === 'removed' ? `  Claude Code hooks: removed from ${tilde(file)}` : '  Claude Code hooks: none installed');
    return true;
  } catch (error) {
    sayHooksProblem(file, error);
    return false;
  }
}

function hooksLine(port: number): string {
  const file = settingsFile();
  try {
    const state = installedHooks(file, port);
    if (state === 'installed') return `installed in ${tilde(file)}`;
    if (state === 'missing') return 'not installed (add them with: agentnauts hooks install)';
    return 'out of date (update them with: agentnauts hooks install)';
  } catch (error) {
    if (!(error instanceof HooksError)) throw error;
    return `unknown, because ${error.message} (${tilde(file)})`;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function sayPairing(id: string, link: string, open: boolean): void {
  // Only when someone is at the terminal: not when a launcher or a script started us.
  const opened = open && process.stdout.isTTY && openInBrowser(link);
  say(`  This computer is not connected to an account yet.`);
  say(opened ? '  Opening the app in your browser. If it did not open, use this link:' : '  Open this link in a browser:');
  say(`    ${link}`);
  say(`  Sign in, check that the page shows the ID ${id}, and click Connect.`);
}

async function start(invocation: Invocation, settings: Settings): Promise<void> {
  const running = await runningDaemon(settings.port);
  if (running === 'other') throw new Failure(`Port ${settings.port} is used by another program. Choose a different one with AGENTNAUTS_PORT.`);
  if (running) {
    say(`agentnauts is already running on this computer (port ${settings.port}).`);
    say('See what it is doing with: agentnauts status');
    return;
  }

  const identity = loadOrCreateIdentity();
  const stamp = () => new Date().toLocaleTimeString('en-GB');
  let daemon: Daemon;
  try {
    daemon = await startDaemon({
      settings,
      identity,
      version: VERSION,
      log: (...args) => console.log(stamp(), ...args),
      debug: invocation.verbose ? (...args) => console.log(stamp(), ...args) : () => {},
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    throw new Failure(`Port ${settings.port} is already in use. Choose a different one with AGENTNAUTS_PORT.`);
  }

  const shutdown = (): void => {
    void daemon.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  say(`agentnauts ${VERSION}`);
  say(`  listening on http://${settings.host}:${daemon.port} (Ctrl+C stops it)`);
  if (invocation.hooks) setUpHooks(daemon.port);
  if (!settings.cloud) {
    say('  no cloud configured: local mode only');
    return;
  }

  const id = keyFingerprint(identity.publicKey);
  say(`  this computer's ID: ${id}`);

  // Say where this computer stands with the account, now and whenever that changes.
  let standing: 'unknown' | 'unconnected' | 'connected' = 'unknown';
  const look = (): void => {
    if (!daemon.connections.ready) return;
    const connected = daemon.connections.summary.length > 0;
    if (connected && standing !== 'connected') {
      say(`  ${standing === 'unconnected' ? 'Connected. ' : ''}Watch your agents at ${settings.appUrl}`);
    } else if (!connected && standing === 'unknown') {
      sayPairing(id, daemon.status().connectLink, invocation.open);
    } else if (!connected && standing === 'connected') {
      say('  This computer was disconnected from your account. Connect it again with: agentnauts connect');
    }
    standing = connected ? 'connected' : 'unconnected';
  };
  // The first check for this computer's rooms started with the daemon.
  await daemon.connections.idle();
  look();
  if (standing === 'unknown') say('  Could not reach the agentnauts service. It keeps trying.');
  setInterval(look, 1000).unref();
}

async function connect(invocation: Invocation, settings: Settings): Promise<void> {
  const { cloud } = settings;
  if (!cloud) throw new Failure('No cloud is configured, so there is nothing to connect to.');
  const daemon = await runningDaemon(settings.port);
  const running = daemon && daemon !== 'other' ? daemon : null;

  // With a daemon running, it is the one that has to notice; otherwise ask the service directly.
  const identity = running ? null : loadOrCreateIdentity();
  const id = running ? running.id : keyFingerprint(identity!.publicKey);
  const link = running ? running.connectLink : connectLinkFor(settings, identity!);
  const rooms = async (): Promise<ConnectionSummary[] | null> => {
    if (running) {
      const now = await runningDaemon(settings.port);
      return now && now !== 'other' ? now.rooms : null;
    }
    const result = await fetchConnections(cloud, identity!);
    return result.ok ? result.value : null;
  };

  const already = await rooms();
  if (already === null) throw new Failure(running ? 'The daemon stopped answering.' : 'Could not reach the agentnauts service. Check your connection and try again.');
  if (already.length > 0) {
    say(`This computer (ID ${id}) is already connected. It publishes to:`);
    for (const line of roomLines(already)) say(`  ${line}`);
    say(`Rooms are joined and left in the app: ${settings.appUrl}`);
    return;
  }

  // The daemon then looks for the connection every few seconds.
  if (running) await nudgeDaemon(settings.port);
  sayPairing(id, link, invocation.open);
  say('  Waiting for you to click Connect…');
  const deadline = Date.now() + PAIRING_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(running ? 2000 : 3000);
    const now = await rooms();
    if (!now || now.length === 0) continue;
    say(`  Connected: ${roomLines(now).join(', ')}`);
    say(running ? `  Watch your agents at ${settings.appUrl}` : '  Start sending your agents with: agentnauts');
    return;
  }
  throw new Failure('Still not connected after 10 minutes. Run "agentnauts connect" to try again.');
}

async function disconnect(settings: Settings): Promise<void> {
  const identity = loadIdentity();
  if (!identity) {
    say('This computer has never been connected.');
    return;
  }
  if (!settings.cloud) throw new Failure('No cloud is configured, so there is nothing to disconnect from.');
  const result = await disconnectComputer(settings.cloud, identity);
  if (!result.ok) {
    throw new Failure(
      `Could not disconnect (${result.status || 'offline'}: ${result.error}).\n` +
        `You can also disconnect this computer in the app, under "Your computers": ${settings.appUrl}`,
    );
  }
  say(result.value === 0 ? 'This computer was not connected to anything.' : 'Disconnected. This computer no longer sends anything to your account.');
  const daemon = await runningDaemon(settings.port);
  if (daemon && daemon !== 'other') {
    await nudgeDaemon(settings.port);
    say('agentnauts is still running, with nowhere to send. Stop it with Ctrl+C in its terminal.');
  }
}

async function status(settings: Settings): Promise<void> {
  const daemon = await runningDaemon(settings.port);
  const running = daemon && daemon !== 'other' ? daemon : null;
  const identity = running ? null : loadIdentity();
  const id = running ? running.id : identity ? keyFingerprint(identity.publicKey) : null;

  let rooms: string[];
  if (running) {
    rooms = roomLines(running.rooms);
  } else if (identity && settings.cloud) {
    const result = await fetchConnections(settings.cloud, identity);
    rooms = result.ok ? roomLines(result.value) : [`unknown (could not reach the agentnauts service: ${result.error})`];
  } else {
    rooms = [];
  }
  if (rooms.length === 0) rooms = ['not connected (connect with: agentnauts connect)'];

  say(`agentnauts ${VERSION}`);
  say(
    `  daemon   ${
      running
        ? `running on port ${settings.port}${running.version === VERSION ? '' : ` (version ${running.version})`}`
        : daemon === 'other'
          ? `not running: port ${settings.port} is used by another program`
          : 'not running (start it with: agentnauts)'
    }`,
  );
  say(`  ID       ${id ?? 'none yet'}`);
  say(`  rooms    ${rooms.join('\n           ')}`);
  say(`  hooks    ${hooksLine(settings.port)}`);
  say(`  app      ${settings.appUrl}`);
}

async function uninstall(settings: Settings): Promise<void> {
  const daemon = await runningDaemon(settings.port);
  if (daemon && daemon !== 'other') throw new Failure('agentnauts is running. Stop it first (Ctrl+C in its terminal), then run this again.');

  say('Removing agentnauts from this computer');
  const identity = loadIdentity();
  if (identity && settings.cloud) {
    const result = await disconnectComputer(settings.cloud, identity);
    if (!result.ok) {
      // The key is the only way to do this later from here, so keep everything.
      throw new Failure(
        `Could not disconnect this computer (${result.status || 'offline'}: ${result.error}). Nothing was removed.\n` +
          'Try again when you are online.',
      );
    }
    say(result.value === 0 ? '  account: this computer was not connected' : '  account: this computer was disconnected');
  }
  if (!removeHooks()) process.exitCode = 1;
  if (identity) {
    rmSync(IDENTITY_FILE, { force: true });
    try {
      rmdirSync(DATA_DIR);
    } catch {
      // Something else is in there: not ours to remove.
    }
    say(`  this computer's key: removed (${tilde(DATA_DIR)})`);
  }
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.command === 'help') return say(HELP);
  if (invocation.command === 'version') return say(VERSION);
  const settings = readSettings(process.env, FROM_SOURCE);
  switch (invocation.command) {
    case 'start':
      return start(invocation, settings);
    case 'connect':
      return connect(invocation, settings);
    case 'disconnect':
      return disconnect(settings);
    case 'status':
      return status(settings);
    case 'uninstall':
      return uninstall(settings);
    case 'hooks install':
      if (!setUpHooks(settings.port)) process.exitCode = 1;
      return;
    case 'hooks uninstall':
      if (!removeHooks()) process.exitCode = 1;
      return;
    case 'hooks status':
      return say(`Claude Code hooks: ${hooksLine(settings.port)}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (error instanceof Failure || error instanceof SettingsError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
