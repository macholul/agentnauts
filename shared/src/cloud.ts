/**
 * The one Supabase project that relays multiplayer rooms for everyone using
 * this build of agentnauts. The maintainer fills this in once
 * (Supabase dashboard → Project Settings → API); users never touch it.
 *
 * The anon / publishable key is designed to be public, so committing it is
 * fine. Environment variables override these values (SUPABASE_URL /
 * SUPABASE_ANON_KEY for the bridge, VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * for the web app), e.g. to point a fork at its own project.
 */
export const CLOUD = {
  /**
   * Where the hosted web app lives; the published tool opens and prints links
   * to it. (Run from source, the daemon links to the local dev server
   * instead.) Override with AGENTNAUTS_APP_URL.
   */
  appUrl: 'https://agentnauts.vercel.app',
  supabaseUrl: 'https://ukcwdorzglnawnjfeazz.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVrY3dkb3J6Z2xuYXduamZlYXp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MDEwMTMsImV4cCI6MjEwNjE3NzAxM30.vStCSfebALGb-3jf3RllvVGLJu4NitbJ3UzLMVrO510',
};

export interface CloudSettings {
  url: string;
  key: string;
}

/** Overrides first, then the built-in project. Null when neither is set. */
export function resolveCloud(urlOverride?: string, keyOverride?: string): CloudSettings | null {
  const url = (urlOverride?.trim() || CLOUD.supabaseUrl).trim();
  const key = (keyOverride?.trim() || CLOUD.supabaseAnonKey).trim();
  return url && key ? { url, key } : null;
}
