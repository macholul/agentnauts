import { Hud } from './hud/Hud';
import { Scene } from './scene/Scene';
import { useEventSources } from './sources/useEventSources';
import { useAgentClock } from './store/useAgentClock';

export function App() {
  useAgentClock();
  useEventSources();
  return (
    <div className="app">
      <Scene />
      <Hud />
    </div>
  );
}
