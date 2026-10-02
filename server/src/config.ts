/**
 * Settings from the environment. Every variable carries the product's name:
 * generic ones (PORT, HOST, SUPABASE_URL) are set by launchers and other
 * projects' shells, and this tool runs inside all of them.
 */
import { CLOUD, DEFAULT_BRIDGE_PORT, resolveCloud, type CloudSettings } from '@agentnauts/shared';

export interface Settings {
  port: number;
  /** Bind address. Loopback only by default: events include file names and commands. */
  host: string;
  /** Extra browser origins allowed to use local mode. */
  extraOrigins: string[];
  /** Where the web app lives. */
  appUrl: string;
  cloud: CloudSettings | null;
}

export class SettingsError extends Error {}

/** Where the web app runs while developing (web/vite.config.ts). */
const DEV_APP_URL = 'http://localhost:5173';

/**
 * `fromSource`: running from this repository rather than the published
 * build, so links go to the local web app instead of the hosted one.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env, fromSource = false): Settings {
  const rawPort = env.AGENTNAUTS_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_BRIDGE_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new SettingsError(`AGENTNAUTS_PORT must be a port number, not "${rawPort}"`);
  }
  return {
    port,
    host: env.AGENTNAUTS_HOST?.trim() || '127.0.0.1',
    extraOrigins: (env.AGENTNAUTS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    appUrl: (env.AGENTNAUTS_APP_URL?.trim() || (fromSource ? DEV_APP_URL : CLOUD.appUrl)).replace(/\/+$/, ''),
    cloud: resolveCloud(env.AGENTNAUTS_SUPABASE_URL, env.AGENTNAUTS_SUPABASE_ANON_KEY),
  };
}
