import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useAgentStore } from './store/agentStore';
import './index.css';

declare global {
  interface Window {
    /** Dev-only handle for poking at the store from the console. */
    __agentnauts?: { store: typeof useAgentStore };
  }
}

if (import.meta.env.DEV) window.__agentnauts = { store: useAgentStore };

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
