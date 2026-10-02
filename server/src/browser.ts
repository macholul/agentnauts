/**
 * Opens a link in the person's browser. Best effort: the link is always
 * printed too, so nothing depends on this working.
 */
import { spawn } from 'node:child_process';

/** The program that opens a URL on this system, or null when there is no screen to open it on. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [command: string, args: string[]] | null {
  // Over SSH the browser would open on a screen nobody is looking at.
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === 'darwin') return ['open', [url]];
  // Not `cmd /c start`: cmd would cut the link at its "&".
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return ['xdg-open', [url]];
}

/** True when a browser was asked to open the link (not whether it did). */
export function openInBrowser(url: string): boolean {
  const launcher = browserCommand(url);
  if (!launcher) return false;
  try {
    const child = spawn(launcher[0], launcher[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
