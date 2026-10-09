/**
 * The shared Supabase client for the browser: sign-in (GitHub, or a link by
 * email) and the private-room API. The session is kept in this browser's
 * storage and never leaves it.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { create } from 'zustand';
import { resolveCloud } from '@agentnauts/shared';

export interface CloudUser {
  id: string;
  email: string;
  /** A name the account came with (the GitHub username), to suggest as the name in rooms. */
  name: string | null;
}

interface AuthState {
  /** Supabase configured for this build. */
  available: boolean;
  /** Still restoring a saved session. */
  loading: boolean;
  user: CloudUser | null;
  accessToken: string | null;
  /** Signing in with GitHub is switched on in the Supabase project. */
  github: boolean;
  /** Why the last sign-in didn't work, when the provider sent people back with an error. */
  signInError: string | null;
}

export const useAuthStore = create<AuthState>()(() => ({
  available: false,
  loading: true,
  user: null,
  accessToken: null,
  github: false,
  signInError: null,
}));

/** The error a sign-in provider put in the address when sending people back, if any (and tidy the address). */
function readSignInError(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const error = params.get('error_description')?.replace(/\+/g, ' ') ?? null;
  if (error) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return error;
}

function accountName(metadata: Record<string, unknown> | undefined): string | null {
  for (const key of ['user_name', 'preferred_username', 'name', 'full_name']) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

let client: SupabaseClient | null = null;

/** The Supabase client, or null if this build has no project configured. */
export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const cloud = resolveCloud(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
  if (!cloud) {
    useAuthStore.setState({ available: false, loading: false });
    return null;
  }
  client = createClient(cloud.url, cloud.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'agentnauts.auth' },
  });
  useAuthStore.setState({ available: true, signInError: readSignInError() });
  // Which sign-in methods the project has switched on (public, no account needed).
  void fetch(`${cloud.url}/auth/v1/settings`, { headers: { apikey: cloud.key } })
    .then((res) => (res.ok ? res.json() : null))
    .then((settings: { external?: { github?: boolean } } | null) => useAuthStore.setState({ github: settings?.external?.github === true }))
    .catch(() => {});
  const apply = (session: Session | null) => {
    const user = session?.user;
    useAuthStore.setState({
      loading: false,
      user: user ? { id: user.id, email: user.email ?? '', name: accountName(user.user_metadata) } : null,
      accessToken: session?.access_token ?? null,
    });
    // Private channels authorize with the user's token.
    void client?.realtime.setAuth(session?.access_token ?? null);
  };
  void client.auth.getSession().then(({ data }) => apply(data.session));
  client.auth.onAuthStateChange((_event, session) => apply(session));
  return client;
}

/** Sign in with GitHub: off to GitHub and back to this page. Creates the account on first use. */
export async function signInWithGitHub(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Multiplayer is not set up in this build');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    // Come back to this exact page (keeps an invite link's ?room=).
    options: { redirectTo: window.location.href.split('#')[0] },
  });
  if (error) throw error;
}

/** Email a sign-in link (plus a code if the email template has one). Creates the account on first use. */
export async function sendSignInCode(email: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Multiplayer is not set up in this build');
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    // Come back to this exact page (keeps an invite link's ?room=).
    options: { shouldCreateUser: true, emailRedirectTo: window.location.href.split('#')[0] },
  });
  if (error) throw error;
}

export async function verifySignInCode(email: string, code: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Multiplayer is not set up in this build');
  const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await getSupabase()?.auth.signOut();
}
