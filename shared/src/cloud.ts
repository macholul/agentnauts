/**
 * The one Supabase project that relays multiplayer rooms for everyone using
 * this build of groundcrew. The maintainer fills this in once
 * (Supabase dashboard → Project Settings → API); users never touch it.
 *
 * The anon / publishable key is designed to be public, so committing it is
 * fine. Environment variables override these values (SUPABASE_URL /
 * SUPABASE_ANON_KEY for the bridge, VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * for the web app), e.g. to point a fork at its own project.
 */
export const CLOUD = {
  supabaseUrl: '',
  supabaseAnonKey: '',
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
