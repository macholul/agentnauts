import { useShallow } from 'zustand/react/shallow';
import { selectAgentIds, useAgentStore } from '../../store/agentStore';
import { AgentActor } from './AgentActor';

/** One actor per agent in the store. Re-renders only when agents come or go. */
export function Agents() {
  const ids = useAgentStore(useShallow(selectAgentIds));
  return (
    <>
      {ids.map((id) => (
        <AgentActor key={id} id={id} />
      ))}
    </>
  );
}
