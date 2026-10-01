import { useSourceStore } from '../sources/sourceStore';

/** Always-visible reminder while your computers are sending your agents to a shared room. */
export function SharingBadge() {
  const agents = useSourceStore((s) => s.agents);
  const name = useSourceStore((s) => s.name);
  const shared = agents.filter((a) => !a.personal);
  if (shared.length === 0) return null;
  const rooms = [...new Set(shared.map((a) => a.roomName))];
  return (
    <div className="sharing-badge" role="status">
      <span className="sharing-badge__dot" />
      Sharing live in <b>{rooms.join(', ')}</b> as <b>{name}</b>
      {shared.some((a) => a.shareDetails) && <span className="sharing-badge__warn">+ files &amp; commands</span>}
    </div>
  );
}
