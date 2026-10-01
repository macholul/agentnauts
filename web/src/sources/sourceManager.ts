/**
 * Connects AgentEventSources to the agent store. This is the only place that
 * knows both about sources and about the store.
 */
import type { AgentEvent } from '@agentnauts/shared';
import { useAgentStore } from '../store/agentStore';
import { useSourceStore } from './sourceStore';
import type { AgentEventSource } from './types';

/**
 * Start a source and route its events into the store. Returns a function
 * that stops the source (and, optionally, sends its astronauts home).
 */
export function attachSource(source: AgentEventSource, options: { clearOnDetach?: boolean } = {}): () => void {
  const sources = useSourceStore.getState();
  sources.upsertSource({ id: source.id, label: source.label });

  const unsubscribe = source.onStatus((status) => {
    useSourceStore.getState().upsertSource({
      id: source.id,
      label: source.label,
      state: status.state,
      detail: status.detail ?? null,
    });
  });

  source.start((event: AgentEvent) => {
    const now = Date.now();
    useSourceStore.getState().countEvent(source.id, now);
    // Tag events with the delivering source so its agents can be cleared together.
    useAgentStore.getState().applyEvent({ ...event, source: source.id }, now);
  });

  return () => {
    source.stop();
    unsubscribe();
    if (options.clearOnDetach) useAgentStore.getState().clear(source.id);
  };
}
