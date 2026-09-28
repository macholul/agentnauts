import { keyFingerprint } from '@groundcrew/shared';
import { useSourceStore } from '../sources/sourceStore';

/** Always-visible reminder while your agents are being shared with a room. */
export function SharingBadge() {
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const connected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  if (!connected || !bridge?.room) return null;
  return (
    <div className="sharing-badge" role="status">
      <span className="sharing-badge__dot" />
      Sharing live in <b>{bridge.room}</b> as <b>{bridge.name}</b>
      {bridge.identity && <span className="sharing-badge__id">{keyFingerprint(bridge.identity)}</span>}
      {bridge.shareDetails && <span className="sharing-badge__warn">+ files &amp; commands</span>}
    </div>
  );
}
