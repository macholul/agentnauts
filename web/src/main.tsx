import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useSourceStore } from './sources/sourceStore';
import { useAuthStore } from './sources/supabase';
import { useAgentStore } from './store/agentStore';
import './index.css';

declare global {
  interface Window {
    /** Dev-only handle for poking at the stores from the console (e.g. to see a signed-in state). */
    __agentnauts?: { store: typeof useAgentStore; sources: typeof useSourceStore; auth: typeof useAuthStore };
  }
}

if (import.meta.env.DEV) window.__agentnauts = { store: useAgentStore, sources: useSourceStore, auth: useAuthStore };

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
