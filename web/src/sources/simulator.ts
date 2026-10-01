/**
 * Fake event source for development: plays realistic Claude Code-like
 * sequences for two agents (read, search, edit, run, stop, pause), now and
 * then launches subagents, asks for permission, or ends and restarts a
 * session.
 */
import { makeId, type AgentEvent, type AgentEventType } from '@agentnauts/shared';
import { StatusEmitter, type AgentEventSource, type EventSink, type SourceStatus } from './types';

const FILES = [
  'App.tsx',
  'store.ts',
  'Scene.tsx',
  'index.ts',
  'README.md',
  'package.json',
  'terrain.ts',
  'api/routes.ts',
  'utils/format.ts',
  'Astronaut.tsx',
];
const PATTERNS = ['"useFrame"', 'TODO', '"applyEvent"', 'export function', 'zustand', 'onStatus'];
const GLOBS = ['src/**/*.tsx', '**/*.test.ts', 'server/**/*.ts'];
const COMMANDS = ['npm test', 'npm run build', 'git status', 'npm run typecheck', 'ls -la', 'git diff --stat', 'npx vite build'];
const QUERIES = ['three.js instanced mesh', 'zustand v5 selectors', 'react-three-fiber useFrame delta', 'vite env variables'];
const URLS = ['threejs.org', 'docs.pmnd.rs', 'developer.mozilla.org', 'vitejs.dev'];
const SUBAGENT_TYPES = ['Explore', 'general-purpose', 'code-reviewer', 'Plan'];

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
const between = (min: number, max: number) => min + Math.random() * (max - min);
const chance = (p: number) => Math.random() < p;

interface ToolStep {
  tool: string;
  detail: string;
}

function toolStep(tool: string): ToolStep {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return { tool, detail: pick(FILES) };
    case 'Grep':
      return { tool, detail: pick(PATTERNS) };
    case 'Glob':
      return { tool, detail: pick(GLOBS) };
    case 'Bash':
      return { tool, detail: pick(COMMANDS) };
    case 'WebSearch':
      return { tool, detail: pick(QUERIES) };
    case 'WebFetch':
      return { tool, detail: pick(URLS) };
    default:
      return { tool, detail: '' };
  }
}

/** A plausible task: look around, change something, check it. */
function randomTask(): string[] {
  const templates: string[][] = [
    ['Read', 'Grep', 'Read', 'Edit', 'Bash'],
    ['Glob', 'Read', 'Read', 'Edit', 'Edit', 'Bash', 'Bash'],
    ['Grep', 'Read', 'Edit', 'Bash', 'Edit', 'Bash'],
    ['WebSearch', 'WebFetch', 'Read', 'Write', 'Bash'],
    ['Read', 'Bash', 'Read', 'Edit'],
    ['Bash', 'Read', 'Grep', 'Edit', 'Bash'],
  ];
  return pick(templates);
}

/** How long a tool "runs" before its PostToolUse. */
function toolDuration(tool: string): number {
  switch (tool) {
    case 'Bash':
      return between(3000, 7000);
    case 'WebSearch':
    case 'WebFetch':
      return between(3000, 6000);
    case 'Edit':
    case 'Write':
      return between(2500, 5000);
    default:
      return between(1800, 4000);
  }
}

class Aborted extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface SessionContext {
  sessionId: string;
  sessionName: string;
  emit: (type: AgentEventType, extra?: Partial<AgentEvent>) => void;
  signal: AbortSignal;
}

export class SimulatorSource implements AgentEventSource {
  readonly id = 'simulator';
  readonly label = 'Simulator';
  private status = new StatusEmitter();
  private controller: AbortController | null = null;

  onStatus(listener: (status: SourceStatus) => void): () => void {
    return this.status.subscribe(listener);
  }

  start(sink: EventSink): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.status.set({ state: 'running', detail: 'Two fake agents' });

    const run = async (delay: number, names: string[], sessionsBeforeRest: [number, number]) => {
      try {
        await sleep(delay, controller.signal);
        let round = 0;
        for (;;) {
          const name = names[round % names.length]!;
          round++;
          await this.runSession(sink, name, controller.signal, Math.round(between(...sessionsBeforeRest)));
          // Session over: stay away for a bit, then a new session starts.
          await sleep(between(12000, 25000), controller.signal);
        }
      } catch (error) {
        if (!(error instanceof Aborted)) console.error('[simulator]', error);
      }
    };

    // A long-running main agent and a second one that comes and goes.
    void run(300, ['nova-app'], [1000, 1000]);
    void run(7000, ['orion-api', 'lyra-docs'], [2, 4]);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.status.set({ state: 'stopped' });
  }

  private async runSession(sink: EventSink, sessionName: string, signal: AbortSignal, tasks: number): Promise<void> {
    const sessionId = makeId('sim');
    const ctx: SessionContext = {
      sessionId,
      sessionName,
      signal,
      emit: (type, extra = {}) =>
        sink({ id: makeId(), sessionId, sessionName, type, timestamp: Date.now(), source: 'simulator', ...extra }),
    };

    ctx.emit('session_start');
    await sleep(3000, signal);

    for (let task = 0; task < tasks; task++) {
      ctx.emit('user_prompt');
      await sleep(between(800, 2000), signal);

      const steps = randomTask();
      // Sometimes delegate part of the work to subagents first.
      if (chance(0.3)) await this.runSubagents(ctx);

      for (const tool of steps) {
        const step = toolStep(tool);
        // Occasionally ask for permission before risky tools.
        if ((tool === 'Bash' || tool === 'Write') && chance(0.15)) {
          ctx.emit('notification', { detail: `Needs permission to use ${tool}` });
          await sleep(between(5000, 9000), signal);
        }
        ctx.emit('tool_start', { toolName: step.tool, detail: step.detail });
        await sleep(toolDuration(tool), signal);
        ctx.emit('tool_end', { toolName: step.tool, detail: step.detail });
        await sleep(between(400, 2200), signal);
      }

      ctx.emit('stop');
      // Now and then the agent waits for the user's next message.
      if (chance(0.25)) {
        await sleep(between(1500, 3000), signal);
        ctx.emit('notification', { detail: 'Waiting for your input' });
        await sleep(between(6000, 10000), signal);
      } else {
        // Idle long enough to wander around.
        await sleep(between(10000, 18000), signal);
      }
    }

    ctx.emit('session_end');
  }

  /** Launch one or two subagents in parallel and wait for them to finish. */
  private async runSubagents(ctx: SessionContext): Promise<void> {
    const count = chance(0.35) ? 2 : 1;
    const agentType = pick(SUBAGENT_TYPES);
    const crews = Array.from({ length: count }, () => ({ id: makeId('agent'), name: agentType }));

    ctx.emit('tool_start', { toolName: 'Task', detail: agentType });
    await Promise.all(
      crews.map(async (crew, index) => {
        await sleep(index * 900, ctx.signal);
        const subagent = { id: crew.id, name: crew.name };
        ctx.emit('subagent_start', { subagent });
        await sleep(2600, ctx.signal); // landing
        const tools = Array.from({ length: Math.round(between(3, 6)) }, () =>
          pick(['Read', 'Grep', 'Glob', 'Read', 'WebSearch', 'WebFetch', 'Bash']),
        );
        for (const tool of tools) {
          const step = toolStep(tool);
          ctx.emit('tool_start', { toolName: step.tool, detail: step.detail, subagent });
          await sleep(toolDuration(tool) * 0.8, ctx.signal);
          ctx.emit('tool_end', { toolName: step.tool, detail: step.detail, subagent });
          await sleep(between(300, 1200), ctx.signal);
        }
        ctx.emit('subagent_stop', { subagent });
      }),
    );
    ctx.emit('tool_end', { toolName: 'Task', detail: agentType });
    await sleep(between(500, 1500), ctx.signal);
  }
}
