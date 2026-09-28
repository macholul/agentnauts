/**
 * Plain-data view of the event sources for the HUD: status, counters and the
 * simulator toggle. The sources themselves live in sourceManager.ts.
 */
import { create } from 'zustand';
import type { SourceState } from './types';

export interface SourceInfo {
  id: string;
  label: string;
  state: SourceState;
  detail: string | null;
  eventCount: number;
  lastEventAt: number | null;
}

const SIMULATOR_KEY = 'groundcrew.simulator';

function readSimulatorPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(SIMULATOR_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  // On by default while developing, off in production builds.
  return import.meta.env.DEV;
}

interface SourceStoreState {
  sources: Record<string, SourceInfo>;
  simulatorEnabled: boolean;
  setSimulatorEnabled: (enabled: boolean) => void;
  upsertSource: (info: Pick<SourceInfo, 'id' | 'label'> & Partial<SourceInfo>) => void;
  countEvent: (id: string, at: number) => void;
}

export const useSourceStore = create<SourceStoreState>()((set) => ({
  sources: {},
  simulatorEnabled: readSimulatorPreference(),

  setSimulatorEnabled: (enabled) => {
    try {
      window.localStorage.setItem(SIMULATOR_KEY, enabled ? 'on' : 'off');
    } catch {
      // Ignore: the toggle still works for this page load.
    }
    set({ simulatorEnabled: enabled });
  },

  upsertSource: (info) =>
    set((s) => {
      const prev = s.sources[info.id];
      const next: SourceInfo = {
        id: info.id,
        label: info.label,
        state: info.state ?? prev?.state ?? 'stopped',
        detail: info.detail !== undefined ? info.detail : (prev?.detail ?? null),
        eventCount: info.eventCount ?? prev?.eventCount ?? 0,
        lastEventAt: info.lastEventAt ?? prev?.lastEventAt ?? null,
      };
      return { sources: { ...s.sources, [info.id]: next } };
    }),

  countEvent: (id, at) =>
    set((s) => {
      const prev = s.sources[id];
      if (!prev) return s;
      return { sources: { ...s.sources, [id]: { ...prev, eventCount: prev.eventCount + 1, lastEventAt: at } } };
    }),
}));
