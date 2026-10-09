import { Guide } from './hud/Guide';
import { Hud } from './hud/Hud';
import { SharingBadge } from './hud/SharingBadge';
import { Scene } from './scene/Scene';
import { useAuthStore } from './sources/supabase';
import { useEventSources, useIsVisitor } from './sources/useEventSources';
import { useAgentClock } from './store/useAgentClock';

export function App() {
  useAgentClock();
  useEventSources();
  const visitor = useIsVisitor();
  // Wait for a saved sign-in before choosing between the landing card and the panel.
  const restoring = useAuthStore((s) => s.loading);
  return (
    <div className="app">
      <Scene />
      {!restoring && !visitor && <Hud />}
      <Guide />
      <SharingBadge />
    </div>
  );
}
