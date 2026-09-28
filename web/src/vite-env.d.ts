/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the event bridge WebSocket URL (default ws://<host>:4747/ws). */
  readonly VITE_BRIDGE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
