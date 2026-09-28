/**
 * Agent store: every astronaut on the chunk, keyed by id.
 *
 * Only plain, serializable data lives here (ids, states, station names,
 * positions as [x, y, z]) so the whole map can later be synced over the
 * network. Three.js objects stay in component refs. The scene reads this
 * store with getState() inside useFrame and reports back through the
 * `arrived` / `landed` / `removeAgent` actions.
 */
import { create } from 'zustand';
import {
  mapEventToIntent,
  type AgentEvent,
  type Intent,
  type IntentKind,
  type StationId,
} from '@groundcrew/shared';
import { LANDING_PAD, STATIONS, type Vec3 } from '../world/config';
import { randomPointNear, randomWanderPoint } from '../world/navigation';
import { groundHeight } from '../world/terrain';

export type AgentRole = 'commander' | 'crew';
export type AgentState = 'idle' | 'walking' | 'working' | 'waiting';
/** arriving = dropping in from the sky, leaving = flying off. */
export type Lifecycle = 'arriving' | 'active' | 'leaving';

export interface Agent {
  /** Store key: the session id for commanders, `${sessionId}/${subagentId}` for crew. */
  id: string;
  sessionId: string;
  /** Commander id for crew; null for commanders. */
  parentId: string | null;
  name: string;
  role: AgentRole;
  color: string;
  state: AgentState;
  lifecycle: Lifecycle;
  /** What the agent is trying to do (from the latest event). */
  intent: IntentKind;
  /** Target station when intent is 'work'. */
  station: StationId | null;
  /** Index of the standing slot at the station or pad. */
  slot: number | null;
  /** HUD text, e.g. "Editing App.tsx". */
  activity: string;
  toolName: string | null;
  /** Where the astronaut is heading; null when standing still. */
  destination: Vec3 | null;
  /** Yaw to face once there (null keeps the current heading). */
  facing: number | null;
  /** Bumped whenever the destination changes so the scene re-plans its path. */
  moveSeq: number;
  /** Last known position, reported by the scene when a move ends. */
  position: Vec3;
  /** Where the astronaut touches down when arriving. */
  landingSpot: Vec3;
  lastEventAt: number;
  /** When the current state began (ms epoch). */
  stateSince: number;
  /** When an idle astronaut may next wander off (ms epoch). */
  nextWanderAt: number | null;
  spawnedAt: number;
  /** Event source that created this agent (e.g. "simulator", "hooks"). */
  source: string | null;
}

/** Idle this long without events and astronauts start wandering around. */
export const IDLE_AFTER_MS = 8_000;
/** Once at a station, work at least this long before the idle timeout applies. */
export const MIN_WORK_MS = 3_000;
/** Commanders nobody has heard from in this long fly home. */
export const STALE_AFTER_MS = 30 * 60_000;
/** Crew whose SubagentStop never arrived fly home after this long. */
export const CREW_STALE_AFTER_MS = 5 * 60_000;

/** Ordered for contrast: the first few sessions get clearly different colors. */
const COMMANDER_COLORS = ['#5b8def', '#ff6b8b', '#20b8a6', '#f59f00', '#8a6cff', '#56b35f', '#ff7a45', '#3fb5e8'];

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mix two #rrggbb colors. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function pickCommanderColor(sessionId: string, agents: Record<string, Agent>): string {
  const used = new Set(Object.values(agents).filter((a) => a.role === 'commander').map((a) => a.color));
  const free = COMMANDER_COLORS.find((color) => !used.has(color));
  return free ?? COMMANDER_COLORS[hashString(sessionId) % COMMANDER_COLORS.length]!;
}

export function crewId(sessionId: string, subagentId: string): string {
  return `${sessionId}/${subagentId}`;
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || '????';
}

/** Lowest standing slot not taken by another agent headed to the same place. */
function pickSlot(
  agents: Record<string, Agent>,
  self: string,
  matches: (a: Agent) => boolean,
  slotCount: number,
): number {
  const taken = new Set<number>();
  for (const a of Object.values(agents)) {
    if (a.id !== self && a.slot !== null && matches(a)) taken.add(a.slot);
  }
  for (let i = 0; i < slotCount; i++) if (!taken.has(i)) return i;
  return taken.size % slotCount;
}

function withGround(p: Vec3): Vec3 {
  return [p[0], groundHeight(p[0], p[2]), p[2]];
}

export interface SpawnOptions {
  sessionId: string;
  subagentId?: string;
  name?: string;
  role?: AgentRole;
  source?: string | null;
  now?: number;
}

interface AgentStoreState {
  agents: Record<string, Agent>;
  /** Apply a normalized event: spawns agents as needed and updates intents. */
  applyEvent: (event: AgentEvent, now?: number) => void;
  /** Create an agent (no-op if it already exists). Returns the agent id. */
  spawnAgent: (options: SpawnOptions) => string;
  /** Remove an agent immediately (the scene calls this after the leave animation). */
  removeAgent: (id: string) => void;
  /** Start the leave animation for an agent and its crew. */
  dismissAgent: (id: string) => void;
  /** Scene: the drop-in animation finished. */
  landed: (id: string, position: Vec3, now?: number) => void;
  /** Scene: the astronaut reached the destination of move `moveSeq`. */
  arrived: (id: string, moveSeq: number, position: Vec3, now?: number) => void;
  /** Timers: idle timeouts, wandering, stale sessions. Called a few times per second. */
  tick: (now?: number) => void;
  /** Remove everyone (e.g. when switching sources). */
  clear: (source?: string) => void;
}

type Agents = Record<string, Agent>;

function createAgent(agents: Agents, options: SpawnOptions): Agent {
  const now = options.now ?? Date.now();
  const role: AgentRole = options.role ?? (options.subagentId ? 'crew' : 'commander');
  const id = options.subagentId ? crewId(options.sessionId, options.subagentId) : options.sessionId;
  const parent = options.subagentId ? agents[options.sessionId] : undefined;

  let color: string;
  let name: string;
  if (role === 'commander') {
    color = pickCommanderColor(options.sessionId, agents);
    name = options.name ?? `Agent ${shortId(options.sessionId)}`;
  } else {
    // Crew wear a lighter version of their commander's colors.
    color = mixHex(parent?.color ?? '#8a6cff', '#ffffff', 0.35);
    const base = options.name ?? 'Crew';
    const siblings = Object.values(agents).filter((a) => a.parentId === options.sessionId && a.name.startsWith(base));
    name = siblings.length > 0 ? `${base} ${siblings.length + 1}` : base;
  }

  // Commanders touch down on the pad; crew land around it. Pick the
  // candidate spot farthest from everyone else so nobody lands on a head.
  const others = Object.values(agents).map((a) => a.position);
  let landingSpot: Vec3 = LANDING_PAD.position;
  let bestClearance = -1;
  for (let i = 0; i < 8; i++) {
    const candidate =
      role === 'commander'
        ? randomPointNear(LANDING_PAD.position, 0, LANDING_PAD.radius - 0.45)
        : randomPointNear(LANDING_PAD.position, LANDING_PAD.radius + 0.5, LANDING_PAD.radius + 2.2);
    const clearance = Math.min(Infinity, ...others.map((p) => Math.hypot(p[0] - candidate[0], p[2] - candidate[2])));
    if (clearance > bestClearance) {
      bestClearance = clearance;
      landingSpot = candidate;
    }
  }

  return {
    id,
    sessionId: options.sessionId,
    parentId: options.subagentId ? options.sessionId : null,
    name,
    role,
    color,
    state: 'idle',
    lifecycle: 'arriving',
    intent: 'idle',
    station: null,
    slot: null,
    activity: role === 'commander' ? 'Just landed' : 'Reporting for duty',
    toolName: null,
    destination: null,
    facing: null,
    moveSeq: 0,
    position: landingSpot,
    landingSpot,
    lastEventAt: now,
    stateSince: now,
    nextWanderAt: now + IDLE_AFTER_MS,
    spawnedAt: now,
    source: options.source ?? null,
  };
}

/** Set a new destination (the scene will plan a path and walk there). */
function moveTo(agent: Agent, destination: Vec3 | null, facing: number | null): Agent {
  return {
    ...agent,
    destination: destination ? withGround(destination) : null,
    facing,
    moveSeq: agent.moveSeq + 1,
    state: destination ? 'walking' : agent.state,
  };
}

function startLeaving(agent: Agent, now: number): Agent {
  return {
    ...agent,
    lifecycle: 'leaving',
    intent: 'leave',
    station: null,
    slot: null,
    destination: null,
    activity: 'Heading home',
    lastEventAt: now,
    moveSeq: agent.moveSeq + 1,
  };
}

/** Turn an intent into agent changes. */
function applyIntent(agents: Agents, agent: Agent, intent: Intent, event: AgentEvent, now: number): Agent {
  // Already flying home: let it go. A later event for the same id respawns it.
  if (agent.lifecycle === 'leaving') return agent;

  let next: Agent = {
    ...agent,
    lastEventAt: now,
    activity: intent.activity,
    toolName: event.toolName ?? null,
  };

  // Tool completions only keep the current activity alive; they never move
  // anyone (parallel tool calls would otherwise make astronauts ping-pong).
  if (event.type === 'tool_end') {
    return { ...next, activity: agent.state === 'working' || agent.state === 'walking' ? agent.activity : next.activity };
  }

  switch (intent.kind) {
    case 'work': {
      const station = STATIONS[intent.station];
      if (agent.intent === 'work' && agent.station === intent.station && agent.slot !== null) {
        return next; // already there or on the way
      }
      const slot = pickSlot(agents, agent.id, (a) => a.intent === 'work' && a.station === intent.station, station.approach.length);
      next = { ...next, intent: 'work', station: intent.station, slot };
      return moveTo(next, station.approach[slot] ?? station.approach[0]!, station.workYaw);
    }
    case 'wait': {
      if (agent.intent === 'wait' && agent.slot !== null) return next;
      const slot = pickSlot(agents, agent.id, (a) => a.intent === 'wait', LANDING_PAD.slots.length);
      next = { ...next, intent: 'wait', station: null, slot };
      return moveTo(next, LANDING_PAD.slots[slot] ?? LANDING_PAD.position, LANDING_PAD.waitYaw);
    }
    case 'idle': {
      next = { ...next, intent: 'idle', station: null, slot: null, nextWanderAt: now + IDLE_AFTER_MS };
      // Stop walking toward a station; stand wherever we are.
      if (agent.intent !== 'idle' && agent.destination) next = moveTo(next, null, null);
      if (!next.destination) next.state = 'idle';
      return next;
    }
    case 'leave':
      return startLeaving(next, now);
  }
}

function patchAgents(agents: Agents, updates: Agent[]): Agents {
  if (updates.length === 0) return agents;
  const next = { ...agents };
  for (const a of updates) next[a.id] = a;
  return next;
}

export const useAgentStore = create<AgentStoreState>()((set, get) => ({
  agents: {},

  spawnAgent: (options) => {
    const agents = get().agents;
    const id = options.subagentId ? crewId(options.sessionId, options.subagentId) : options.sessionId;
    if (agents[id]) return id;
    const agent = createAgent(agents, options);
    set({ agents: { ...agents, [id]: agent } });
    return id;
  },

  applyEvent: (event, now = Date.now()) => {
    const { agents } = get();
    const intent = mapEventToIntent(event);
    const sessionName = event.sessionName;

    const working = { ...agents };
    let commander = working[event.sessionId];

    // Nothing to do for a session we never saw that is already over.
    if (!commander && (event.type === 'session_end' || event.type === 'subagent_stop')) return;

    if (!commander) {
      commander = createAgent(working, {
        sessionId: event.sessionId,
        ...(sessionName ? { name: sessionName } : {}),
        source: event.source ?? null,
        now,
      });
      working[commander.id] = commander;
    } else if (sessionName && commander.name !== sessionName && commander.name.startsWith('Agent ')) {
      commander = { ...commander, name: sessionName };
      working[commander.id] = commander;
    }

    if (event.type === 'session_end') {
      const leaving = Object.values(working)
        .filter((a) => (a.id === commander.id || a.parentId === commander.id) && a.lifecycle !== 'leaving')
        .map((a) => startLeaving(a, now));
      set({ agents: patchAgents(working, leaving) });
      return;
    }

    if (event.subagent) {
      const id = crewId(event.sessionId, event.subagent.id);
      let crew = working[id];
      if (!crew) {
        if (event.type === 'subagent_stop') return;
        crew = createAgent(working, {
          sessionId: event.sessionId,
          subagentId: event.subagent.id,
          ...(event.subagent.name ? { name: event.subagent.name } : {}),
          source: event.source ?? null,
          now,
        });
      }
      working[id] = applyIntent(working, crew, intent, event, now);
      // The commander is busy supervising while crew work.
      working[commander.id] = { ...commander, lastEventAt: now };
      set({ agents: working });
      return;
    }

    working[commander.id] = applyIntent(working, commander, intent, event, now);
    set({ agents: working });
  },

  removeAgent: (id) => {
    const { agents } = get();
    if (!agents[id]) return;
    const next = { ...agents };
    delete next[id];
    set({ agents: next });
  },

  dismissAgent: (id) => {
    const { agents } = get();
    const now = Date.now();
    const leaving = Object.values(agents)
      .filter((a) => (a.id === id || a.parentId === id) && a.lifecycle !== 'leaving')
      .map((a) => startLeaving(a, now));
    set({ agents: patchAgents(agents, leaving) });
  },

  landed: (id, position, now = Date.now()) => {
    const agent = get().agents[id];
    if (!agent || agent.lifecycle !== 'arriving') return;
    set({
      agents: {
        ...get().agents,
        [id]: {
          ...agent,
          lifecycle: 'active',
          position,
          // If an event arrived mid-flight we already have somewhere to be.
          state: agent.destination ? 'walking' : agent.state === 'walking' ? 'idle' : agent.state,
          nextWanderAt: agent.nextWanderAt ?? now + IDLE_AFTER_MS,
        },
      },
    });
  },

  arrived: (id, moveSeq, position, now = Date.now()) => {
    const agent = get().agents[id];
    if (!agent || agent.moveSeq !== moveSeq || agent.lifecycle !== 'active') return;
    const state: AgentState = agent.intent === 'work' ? 'working' : agent.intent === 'wait' ? 'waiting' : 'idle';
    // Pause a few seconds (look around) before wandering again.
    const pause = 2500 + Math.random() * 4000;
    set({
      agents: {
        ...get().agents,
        [id]: {
          ...agent,
          position,
          destination: null,
          state,
          stateSince: now,
          nextWanderAt: state === 'idle' ? Math.max(now + pause, agent.lastEventAt + IDLE_AFTER_MS) : null,
        },
      },
    });
  },

  tick: (now = Date.now()) => {
    const { agents } = get();
    const updates: Agent[] = [];
    for (const agent of Object.values(agents)) {
      if (agent.lifecycle !== 'active') continue;
      const quietFor = now - agent.lastEventAt;

      if (quietFor > (agent.role === 'commander' ? STALE_AFTER_MS : CREW_STALE_AFTER_MS)) {
        updates.push(startLeaving(agent, now));
        continue;
      }

      // Working with no news for a while: the agent is probably thinking.
      if (agent.state === 'working' && quietFor > IDLE_AFTER_MS && now - agent.stateSince > MIN_WORK_MS) {
        updates.push({
          ...agent,
          intent: 'idle',
          station: null,
          slot: null,
          state: 'idle',
          stateSince: now,
          activity: 'Idle',
          nextWanderAt: now + 500 + Math.random() * 1500,
        });
        continue;
      }

      if (
        agent.state === 'idle' &&
        agent.intent === 'idle' &&
        !agent.destination &&
        agent.nextWanderAt !== null &&
        now >= agent.nextWanderAt &&
        quietFor >= IDLE_AFTER_MS
      ) {
        const target = randomWanderPoint(agent.position);
        updates.push({ ...moveTo(agent, target, null), activity: 'Wandering', nextWanderAt: null });
      }
    }
    if (updates.length > 0) set({ agents: patchAgents(agents, updates) });
  },

  clear: (source) => {
    const { agents } = get();
    if (!source) {
      set({ agents: {} });
      return;
    }
    const now = Date.now();
    const leaving = Object.values(agents)
      .filter((a) => a.source === source && a.lifecycle !== 'leaving')
      .map((a) => startLeaving(a, now));
    set({ agents: patchAgents(agents, leaving) });
  },
}));

/** Selector helpers. */
export const selectAgentIds = (s: { agents: Record<string, Agent> }) => Object.keys(s.agents);
