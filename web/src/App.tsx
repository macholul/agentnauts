import { Scene } from './scene/Scene';
import { useAgentClock } from './store/useAgentClock';

export function App() {
  useAgentClock();
  return (
    <div className="app">
      <Scene />
    </div>
  );
}
