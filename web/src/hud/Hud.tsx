import { useMemo, useState } from 'react';
import { STATION_IDS } from '@groundcrew/shared';
import { useAgentStore, type Agent } from '../store/agentStore';
import { useSourceStore, type SourceInfo } from '../sources/sourceStore';
import { STATIONS } from '../world/config';
import { Multiplayer } from './Multiplayer';
import './hud.css';

const STATE_LABEL: Record<Agent['state'], string> = {
  idle: 'idle',
  walking: 'walking',
  working: 'working',
  waiting: 'needs you',
};

function stateColor(agent: Agent): string {
  if (agent.lifecycle !== 'active') return '#9b93c4';
  if (agent.state === 'working' && agent.station) return STATIONS[agent.station].accent;
  if (agent.state === 'waiting') return '#ffb020';
  if (agent.state === 'walking') return '#8f7fe0';
  return '#a9a3c9';
}

function stateText(agent: Agent): string {
  if (agent.lifecycle === 'arriving') return 'landing';
  if (agent.lifecycle === 'leaving') return 'leaving';
  if (agent.state === 'walking' && agent.intent === 'work' && agent.station) return `→ ${STATIONS[agent.station].label}`;
  if (agent.state === 'walking' && agent.intent === 'idle') return 'wandering';
  return STATE_LABEL[agent.state];
}

function AgentRow({ agent }: { agent: Agent }) {
  return (
    <li className={`hud-agent hud-agent--${agent.role}`}>
      <span className="hud-agent__dot" style={{ background: agent.color }} />
      <div className="hud-agent__body">
        <div className="hud-agent__top">
          <span className="hud-agent__name" title={agent.name}>
            {agent.name}
          </span>
          {agent.role === 'commander' && <span className="hud-agent__role">CMD</span>}
          <span className="hud-agent__state" style={{ color: stateColor(agent), borderColor: stateColor(agent) }}>
            {stateText(agent)}
          </span>
        </div>
        <div className="hud-agent__activity" title={agent.activity}>
          {agent.activity}
        </div>
      </div>
    </li>
  );
}

const CONNECTION_TEXT: Record<SourceInfo['state'], string> = {
  stopped: 'off',
  connecting: 'connecting…',
  connected: 'connected',
  disconnected: 'offline',
  running: 'running',
  error: 'error',
};

function SourceRow({ source }: { source: SourceInfo }) {
  return (
    <div className="hud-row" title={source.detail ?? undefined}>
      <span className={`hud-status hud-status--${source.state}`} />
      <span className="hud-row__label">{source.label}</span>
      <span className="hud-row__value">
        {CONNECTION_TEXT[source.state]}
        {source.eventCount > 0 && <span className="hud-row__count"> · {source.eventCount} events</span>}
      </span>
    </div>
  );
}

/** Commanders first, each followed by its crew. */
function orderAgents(agents: Record<string, Agent>): Agent[] {
  const all = Object.values(agents);
  const commanders = all.filter((a) => a.role === 'commander').sort((a, b) => a.spawnedAt - b.spawnedAt);
  const ordered: Agent[] = [];
  for (const commander of commanders) {
    ordered.push(commander);
    ordered.push(...all.filter((a) => a.parentId === commander.id).sort((a, b) => a.spawnedAt - b.spawnedAt));
  }
  // Orphaned crew (commander already gone), just in case.
  ordered.push(...all.filter((a) => a.role === 'crew' && !agents[a.parentId ?? '']));
  return ordered;
}

/** Small overlay: connection status, simulator toggle, active agents. */
export function Hud() {
  const agents = useAgentStore((s) => s.agents);
  const sources = useSourceStore((s) => s.sources);
  const simulatorEnabled = useSourceStore((s) => s.simulatorEnabled);
  const setSimulatorEnabled = useSourceStore((s) => s.setSimulatorEnabled);
  const [collapsed, setCollapsed] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  const ordered = useMemo(() => orderAgents(agents), [agents]);
  const connections = Object.values(sources).filter((s) => s.id !== 'simulator' && s.id !== 'room');
  const waiting = ordered.filter((a) => a.state === 'waiting').length;

  return (
    <aside className={`hud ${collapsed ? 'hud--collapsed' : ''}`}>
      <header className="hud-header">
        <button className="hud-title" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          <span className="hud-logo" aria-hidden />
          groundcrew
          {waiting > 0 && <span className="hud-badge">{waiting}</span>}
          <span className="hud-chevron" aria-hidden>
            {collapsed ? '▸' : '▾'}
          </span>
        </button>
      </header>

      {!collapsed && (
        <>
          <section className="hud-section">
            {connections.map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
            <label className="hud-row hud-toggle">
              <span className={`hud-status hud-status--${simulatorEnabled ? 'running' : 'stopped'}`} />
              <span className="hud-row__label">Simulator</span>
              <input
                type="checkbox"
                checked={simulatorEnabled}
                onChange={(e) => setSimulatorEnabled(e.target.checked)}
              />
              <span className="hud-switch" aria-hidden />
            </label>
          </section>

          <section className="hud-section">
            <div className="hud-section__title">
              Crew <span className="hud-muted">{ordered.length}</span>
            </div>
            {ordered.length === 0 ? (
              <div className="hud-empty">No agents yet. Start the simulator or a Claude Code session.</div>
            ) : (
              <ul className="hud-agents">
                {ordered.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </ul>
            )}
          </section>

          <Multiplayer />

          <section className="hud-section hud-legend">
            <button className="hud-section__title hud-link" onClick={() => setLegendOpen((o) => !o)}>
              Stations {legendOpen ? '▾' : '▸'}
            </button>
            {legendOpen && (
              <ul>
                {STATION_IDS.map((id) => (
                  <li key={id}>
                    <span className="hud-agent__dot" style={{ background: STATIONS[id].accent }} />
                    <b>{STATIONS[id].label}</b> <span className="hud-muted">{STATIONS[id].description}</span>
                  </li>
                ))}
                <li>
                  <span className="hud-agent__dot" style={{ background: '#ffb020' }} />
                  <b>Landing pad</b> <span className="hud-muted">Waiting for you</span>
                </li>
              </ul>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
