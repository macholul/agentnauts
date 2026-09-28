import { useState } from 'react';
import { generateRoomCode, isValidRoomCode, keyFingerprint, normalizeRoomCode } from '@groundcrew/shared';
import { setBridgeRoom } from '../sources/bridge';
import { supabaseSettings } from '../sources/room';
import { useSourceStore } from '../sources/sourceStore';

const newRoomCode = () => generateRoomCode((n) => window.crypto.getRandomValues(new Uint32Array(n)));

function shareLink(room: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', room);
  return url.toString();
}

/** Short, readable ID chip for a public key. */
function IdChip({ publicKey, title }: { publicKey: string; title?: string }) {
  return (
    <span className="hud-id" title={title ?? 'Verified ID: only this person can send events with it'}>
      ✓ {keyFingerprint(publicKey)}
    </span>
  );
}

/** HUD section: join or leave a shared room, control sharing, see who's here. */
export function Multiplayer() {
  const room = useSourceStore((s) => s.room);
  const name = useSourceStore((s) => s.name);
  const roommates = useSourceStore((s) => s.roommates);
  const people = useSourceStore((s) => s.roomPeople);
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const status = useSourceStore((s) => s.sources.room);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const sharingWanted = useSourceStore((s) => s.sharingWanted);
  const { joinRoom, leaveRoom, setShareDetails, setSharing } = useSourceStore.getState();
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

  const canShare = bridgeConnected && Boolean(bridge?.cloud);
  const sharing = canShare && Boolean(room) && bridge?.room === room;
  const resumable = canShare && !bridge?.room ? bridge?.resumable : undefined;

  // Remembered room from before a restart: ask before sharing again.
  const resumePrompt = resumable && (
    <div className="hud-note hud-note--ask">
      <div>
        Before the restart you shared your agents in <b className="hud-room-code">{resumable.room}</b> as{' '}
        <b>{resumable.name}</b>. Share again?
      </div>
      <div className="hud-form__row">
        <button className="hud-button" onClick={() => joinRoom(resumable.room, resumable.name, resumable.shareDetails)}>
          Resume sharing
        </button>
        <button className="hud-button hud-button--ghost" onClick={() => void setBridgeRoom(null)}>
          Forget it
        </button>
      </div>
    </div>
  );

  if (!room) {
    const code = normalizeRoomCode(draftRoom);
    const roomOk = isValidRoomCode(code);
    const nameOk = draftName.trim().length > 0;
    return (
      <section className="hud-section">
        <div className="hud-section__title">Multiplayer</div>
        {resumePrompt}
        <form
          className="hud-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (roomOk && nameOk) joinRoom(code, draftName);
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
              className="hud-input hud-room-code"
              placeholder="crew-xxxx-xxxx-xxxx"
              value={draftRoom}
              maxLength={24}
              onChange={(e) => setDraftRoom(e.target.value)}
            />
            <button type="button" className="hud-button hud-button--ghost" onClick={() => setDraftRoom(newRoomCode())}>
              New
            </button>
          </div>
          {draftRoom && !roomOk && <div className="hud-small hud-muted">Room codes look like crew-xxxx-xxxx-xxxx. Use New or paste one.</div>}
          <button type="submit" className="hud-button" disabled={!roomOk || !nameOk}>
            Join room
          </button>
        </form>
        {bridge?.identity && (
          <div className="hud-small hud-muted hud-your-id">
            Your ID <IdChip publicKey={bridge.identity} title="Tell teammates this ID so they know it's really you" />
          </div>
        )}
      </section>
    );
  }

  const others = Object.values(people).filter((p) => p.key !== bridge?.identity);
  const watchers = [...new Set(roommates.map((r) => r.name))];

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
      {status?.state === 'error' && <div className="hud-note">{status.detail}</div>}

      {sharing ? (
        <>
          <div className="hud-small hud-sharing">
            Sharing your agents as {bridge?.name} {bridge?.identity && <IdChip publicKey={bridge.identity} />}
          </div>
          <label className="hud-check hud-small">
            <input type="checkbox" checked={shareDetails} onChange={(e) => setShareDetails(e.target.checked)} />
            Also share project names, files &amp; commands
          </label>
          <button className="hud-action hud-small" onClick={() => setSharing(false)}>
            Stop sharing (keep watching)
          </button>
        </>
      ) : (
        resumePrompt || (
          <div className="hud-note">
            {!canShare
              ? 'Watching only. Run the bridge (npm run dev) to share your own agents too.'
              : sharingWanted
                ? 'Starting to share…'
                : (
                  <>
                    Watching only.{' '}
                    <button className="hud-action" onClick={() => setSharing(true)}>
                      Share my agents here
                    </button>
                  </>
                )}
          </div>
        )
      )}

      {others.length > 0 && (
        <ul className="hud-people">
          {others.map((p) => (
            <li key={p.key}>
              <b>{p.name}</b> <IdChip publicKey={p.key} />
            </li>
          ))}
        </ul>
      )}
      <div className="hud-muted hud-small">
        {watchers.length === 0 ? 'Nobody else is watching yet.' : `Watching: ${watchers.join(', ')}`}
      </div>
    </section>
  );
}
