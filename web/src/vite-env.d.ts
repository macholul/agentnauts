/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" also reads events straight from a daemon on this machine (local mode, no account needed). */
  readonly VITE_LOCAL_BRIDGE?: string;
  /** Override the local daemon's WebSocket URL (default ws://<host>:4747/ws). */
  readonly VITE_BRIDGE_URL?: string;
  /** Supabase project URL, enables multiplayer rooms. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon / publishable key (safe to expose in the browser). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
