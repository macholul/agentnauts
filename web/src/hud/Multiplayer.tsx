import { useState } from 'react';
import { isValidRoomCode } from '@groundcrew/shared';
import { supabaseSettings } from '../sources/room';
import { useSourceStore } from '../sources/sourceStore';

/** Readable random room code, long enough to be hard to guess. */
function newRoomCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const values = new Uint32Array(12);
  window.crypto.getRandomValues(values);
  const chars = Array.from(values, (v) => alphabet[v % alphabet.length]).join('');
  return `crew-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

function shareLink(room: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', room);
  return url.toString();
}

/** HUD section: join or leave a shared room and see who else is watching. */
export function Multiplayer() {
  const room = useSourceStore((s) => s.room);
  const name = useSourceStore((s) => s.name);
  const roommates = useSourceStore((s) => s.roommates);
  const bridgeIdentity = useSourceStore((s) => s.bridgeIdentity);
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const setShareDetails = useSourceStore((s) => s.setShareDetails);
  const status = useSourceStore((s) => s.sources.room);
  const joinRoom = useSourceStore((s) => s.joinRoom);
  const leaveRoom = useSourceStore((s) => s.leaveRoom);
  const [draftRoom, setDraftRoom] = useState('');
  const [draftName, setDraftName] = useState(name);
  const [copied, setCopied] = useState(false);

  if (!supabaseSettings()) {
    return (
      <section className="hud-section">
        <div className="hud-section__title">Multiplayer</div>
        <div className="hud-empty">Not set up in this build yet (see Multiplayer in the README).</div>
      </section>
    );
  }

  if (!room) {
    const roomOk = isValidRoomCode(draftRoom);
    const nameOk = draftName.trim().length > 0;
    return (
      <section className="hud-section">
        <div className="hud-section__title">Multiplayer</div>
        <form
          className="hud-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (roomOk && nameOk) joinRoom(draftRoom.trim(), draftName);
          }}
        >
          <input
            className="hud-input"
            placeholder="Your name"
            value={draftName}
            maxLength={24}
            onChange={(e) => setDraftName(e.target.value)}
          />
          <div className="hud-form__row">
            <input
              className="hud-input"
              placeholder="Room code"
              value={draftRoom}
              maxLength={48}
              onChange={(e) => setDraftRoom(e.target.value.trim())}
            />
            <button type="button" className="hud-button hud-button--ghost" onClick={() => setDraftRoom(newRoomCode())}>
              New
            </button>
          </div>
          <button type="submit" className="hud-button" disabled={!roomOk || !nameOk}>
            Join room
          </button>
        </form>
      </section>
    );
  }

  const sharing = bridgeConnected && bridgeIdentity?.room === room;
  return (
    <section className="hud-section">
      <div className="hud-section__title">Multiplayer</div>
      <div className="hud-row" title={status?.detail ?? undefined}>
        <span className={`hud-status hud-status--${status?.state ?? 'connecting'}`} />
        <span className="hud-row__label hud-room-code">{room}</span>
        <button
          className="hud-action hud-small"
          onClick={() => {
            void navigator.clipboard?.writeText(shareLink(room)).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <button className="hud-action hud-small" onClick={leaveRoom}>
          Leave
        </button>
      </div>
      <div className="hud-muted hud-small">
        {roommates.length === 0
          ? 'Nobody else here yet.'
          : `Also watching: ${[...new Set(roommates.map((r) => r.name))].join(', ')}`}
      </div>
      {sharing ? (
        <>
          <div className="hud-small hud-sharing">Sharing your agents as {bridgeIdentity?.name}</div>
          <label className="hud-check hud-small">
            <input type="checkbox" checked={shareDetails} onChange={(e) => setShareDetails(e.target.checked)} />
            Also share file names &amp; commands
          </label>
        </>
      ) : (
        <div className="hud-note">
          {bridgeConnected
            ? 'Watching only: your bridge is pinned to another room.'
            : 'Watching only. Run the bridge (npm run dev) to share your own agents too.'}
        </div>
      )}
    </section>
  );
}
