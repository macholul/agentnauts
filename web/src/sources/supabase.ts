/**
 * The shared Supabase client for the browser: sign-in (one-time email code)
 * and the private-room API. The session is kept in this browser's storage;
 * only short-lived access tokens are ever handed to the local bridge.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { create } from 'zustand';
import { resolveCloud } from '@agentnauts/shared';

export interface CloudUser {
  id: string;
  email: string;
}

interface AuthState {
  /** Supabase configured for this build. */
  available: boolean;
  /** Still restoring a saved session. */
  loading: boolean;
  user: CloudUser | null;
  accessToken: string | null;
}

export const useAuthStore = create<AuthState>()(() => ({
  available: false,
  loading: true,
  user: null,
  accessToken: null,
}));

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
  useAuthStore.setState({ available: true });
  const apply = (session: Session | null) => {
    useAuthStore.setState({
      loading: false,
      user: session?.user ? { id: session.user.id, email: session.user.email ?? '' } : null,
      accessToken: session?.access_token ?? null,
    });
    // Private channels authorize with the user's token.
    void client?.realtime.setAuth(session?.access_token ?? null);
  };
  void client.auth.getSession().then(({ data }) => apply(data.session));
  client.auth.onAuthStateChange((_event, session) => apply(session));
  return client;
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
