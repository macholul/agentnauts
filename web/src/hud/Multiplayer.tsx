import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { isValidRoomCode, keyFingerprint, normalizeRoomCode } from '@groundcrew/shared';
import { setBridgeRoom } from '../sources/bridge';
import {
  approveMember,
  createRoom,
  deleteRoom,
  listMembers,
  removeMember,
  requestToJoin,
  type RoomMember,
} from '../sources/roomsApi';
import { useSourceStore } from '../sources/sourceStore';
import { sendSignInCode, signOut, useAuthStore, verifySignInCode } from '../sources/supabase';

function shareLink(code: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
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

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="hud-section">
      <div className="hud-section__title">Multiplayer</div>
      {children}
    </section>
  );
}

/** Run an async action with a busy flag and a friendly error message. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Sign in with a one-time code sent by email (no password). */
function SignIn() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sent) void run(async () => { await sendSignInCode(email); setSent(true); });
    else void run(() => verifySignInCode(email, code));
  };

  return (
    <Section>
      <div className="hud-small hud-muted">Sign in to create or join private rooms.</div>
      <form className="hud-form" onSubmit={submit}>
        <input
          className="hud-input"
          type="email"
          placeholder="you@example.com"
          value={email}
          disabled={sent}
          onChange={(e) => setEmail(e.target.value)}
        />
        {sent && (
          <input
            className="hud-input hud-room-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code from the email"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        )}
        <button type="submit" className="hud-button" disabled={busy || !email.includes('@') || (sent && code.length < 6)}>
          {sent ? 'Sign in' : 'Email me a code'}
        </button>
        {sent && (
          <button type="button" className="hud-action hud-small" onClick={() => { setSent(false); setCode(''); }}>
            Use a different email
          </button>
        )}
      </form>
      {error && <div className="hud-note">{error}</div>}
    </Section>
  );
}

/** Signed in, not in a room: create one or ask to join one. */
function ChooseRoom({ userId, email }: { userId: string; email: string }) {
  const name = useSourceStore((s) => s.name);
  const inviteCode = useSourceStore((s) => s.inviteCode);
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const { setName, setRoom } = useSourceStore.getState();
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState(inviteCode ?? '');
  const { busy, error, run } = useAction();
  const normalized = normalizeRoomCode(code);
  const resumable = bridgeConnected ? bridge?.resumable : undefined;

  return (
    <Section>
      {resumable && (
        <div className="hud-note hud-note--ask">
          <div>
            Before the restart you shared your agents in <b>{resumable.roomName}</b> as <b>{resumable.name}</b>. Share again?
          </div>
          <div className="hud-form__row">
            <button
              className="hud-button"
              onClick={() => {
                setName(resumable.name);
                // Membership is re-checked right away; if you were removed, this is undone.
                setRoom(
                  { id: resumable.roomId, code: resumable.code, name: resumable.roomName, owner: false, status: 'member' },
                  { share: true, shareDetails: resumable.shareDetails },
                );
              }}
            >
              Resume sharing
            </button>
            <button className="hud-button hud-button--ghost" onClick={() => void setBridgeRoom(null)}>
              Forget it
            </button>
          </div>
        </div>
      )}
      <input
        className="hud-input"
        placeholder="Your name in rooms"
        value={name}
        maxLength={24}
        onChange={(e) => setName(e.target.value)}
      />
      <form
        className="hud-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setRoom(await requestToJoin(normalized, name, userId), { share: true }));
        }}
      >
        <div className="hud-small hud-muted">Join a room (the owner lets you in)</div>
        <div className="hud-form__row">
          <input
            className="hud-input hud-room-code"
            placeholder="crew-xxxx-xxxx-xxxx"
            value={code}
            maxLength={24}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="hud-button" disabled={busy || !name || !isValidRoomCode(normalized)}>
            Ask
          </button>
        </div>
      </form>
      <form
        className="hud-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setRoom(await createRoom(roomName.trim(), name), { share: true }));
        }}
      >
        <div className="hud-small hud-muted">…or start your own</div>
        <div className="hud-form__row">
          <input
            className="hud-input"
            placeholder="Room name"
            value={roomName}
            maxLength={40}
            onChange={(e) => setRoomName(e.target.value)}
          />
          <button type="submit" className="hud-button hud-button--ghost" disabled={busy || !name || !roomName.trim()}>
            Create
          </button>
        </div>
      </form>
      {error && <div className="hud-note">{error}</div>}
      <div className="hud-small hud-muted hud-your-id">
        {email} ·{' '}
        <button className="hud-action" onClick={() => void signOut()}>
          Sign out
        </button>
        {bridge?.identity && (
          <>
            {' '}
            · <IdChip publicKey={bridge.identity} title="Tell teammates this ID so they know it's really you" />
          </>
        )}
      </div>
    </Section>
  );
}

/** Members (and, for the owner, pending requests), refreshed every few seconds. */
function useMembers(roomId: string): [RoomMember[], () => void] {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listMembers(roomId)
        .then((list) => !cancelled && setMembers(list))
        .catch(() => {});
    void load();
    const handle = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [roomId, tick]);
  return [members, () => setTick((t) => t + 1)];
}

/** Inside a room (member or owner). */
function InRoom({ userId }: { userId: string }) {
  const room = useSourceStore((s) => s.room)!;
  const people = useSourceStore((s) => s.roomPeople);
  const roommates = useSourceStore((s) => s.roommates);
  const bridge = useSourceStore((s) => s.bridgeIdentity);
  const bridgeConnected = useSourceStore((s) => s.sources.bridge?.state === 'connected');
  const status = useSourceStore((s) => s.sources.room);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const sharingWanted = useSourceStore((s) => s.sharingWanted);
  const { setShareDetails, setSharing, setRoom } = useSourceStore.getState();
  const [members, refresh] = useMembers(room.id);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();

  // The members list is the source of truth for who owns the room.
  const owner = members.find((m) => m.isOwner)?.userId === userId;
  useEffect(() => {
    if (members.length > 0 && owner !== room.owner) setRoom({ ...room, owner });
  }, [owner, members.length, room, setRoom]);

  const canShare = bridgeConnected && Boolean(bridge?.cloud);
  const sharing = canShare && bridge?.room?.roomId === room.id;
  const pending = members.filter((m) => m.status === 'pending');
  const joined = members.filter((m) => m.status === 'member');
  const verified = Object.values(people).filter((p) => p.key !== bridge?.identity);
  const watchers = [...new Set(roommates.map((r) => r.name))];

  return (
    <Section>
      <div className="hud-row" title={status?.detail ?? undefined}>
        <span className={`hud-status hud-status--${status?.state ?? 'connecting'}`} />
        <span className="hud-row__label">
          {room.name}
          {room.owner && <span className="hud-agent__role"> OWNER</span>}
        </span>
        <button
          className="hud-action hud-small"
          title={room.code}
          onClick={() => {
            void navigator.clipboard?.writeText(shareLink(room.code)).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied!' : 'Invite link'}
        </button>
      </div>
      {status?.state === 'error' && <div className="hud-note">{status.detail}</div>}

      {sharing ? (
        <>
          <div className="hud-small hud-sharing">
            Sharing your agents as {bridge?.room?.name} {bridge?.identity && <IdChip publicKey={bridge.identity} />}
          </div>
          {bridge?.needsToken && <div className="hud-note">Refreshing your sign-in for the bridge…</div>}
          <label className="hud-check hud-small">
            <input type="checkbox" checked={shareDetails} onChange={(e) => setShareDetails(e.target.checked)} />
            Also share project names, files &amp; commands
          </label>
          <button className="hud-action hud-small" onClick={() => setSharing(false)}>
            Stop sharing (keep watching)
          </button>
        </>
      ) : (
        <div className="hud-note">
          {!canShare ? (
            'Watching only. Run the bridge (npm run dev) to share your own agents too.'
          ) : sharingWanted ? (
            'Starting to share…'
          ) : (
            <>
              Watching only.{' '}
              <button className="hud-action" onClick={() => setSharing(true)}>
                Share my agents here
              </button>
            </>
          )}
        </div>
      )}

      {room.owner && pending.length > 0 && (
        <div className="hud-requests">
          <div className="hud-small hud-muted">Asking to join</div>
          {pending.map((m) => (
            <div key={m.userId} className="hud-request">
              <div>
                <b>{m.name}</b> <span className="hud-muted hud-small">{m.email}</span>
              </div>
              <div className="hud-form__row">
                <button className="hud-button" disabled={busy} onClick={() => void run(async () => { await approveMember(room.id, m.userId); refresh(); })}>
                  Let in
                </button>
                <button className="hud-button hud-button--ghost" disabled={busy} onClick={() => void run(async () => { await removeMember(room.id, m.userId); refresh(); })}>
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ul className="hud-people">
        {joined.map((m) => (
          <li key={m.userId}>
            <b>{m.name}</b>
            {m.isOwner && <span className="hud-muted hud-small"> owner</span>}
            {m.userId === userId && <span className="hud-muted hud-small"> (you)</span>}
            {room.owner && !m.isOwner && (
              <button
                className="hud-action hud-small hud-remove"
                disabled={busy}
                onClick={() => void run(async () => { await removeMember(room.id, m.userId); refresh(); })}
              >
                remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {verified.length > 0 && (
        <div className="hud-small hud-muted">
          Verified IDs:{' '}
          {verified.map((p) => (
            <span key={p.key}>
              {p.name} <IdChip publicKey={p.key} />{' '}
            </span>
          ))}
        </div>
      )}
      <div className="hud-muted hud-small">{watchers.length === 0 ? 'Nobody else is watching right now.' : `Watching: ${watchers.join(', ')}`}</div>
      {error && <div className="hud-note">{error}</div>}

      <div className="hud-small hud-your-id">
        {room.owner ? (
          <button
            className="hud-action"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete "${room.name}" for everyone?`)) {
                void run(async () => { await deleteRoom(room.id); setRoom(null); });
              }
            }}
          >
            Delete room
          </button>
        ) : (
          <button className="hud-action" disabled={busy} onClick={() => void run(async () => { await removeMember(room.id, userId); setRoom(null); })}>
            Leave room
          </button>
        )}
      </div>
    </Section>
  );
}

/** HUD section: sign in, create or join private rooms, control sharing. */
export function Multiplayer() {
  const available = useAuthStore((s) => s.available);
  const loading = useAuthStore((s) => s.loading);
  const user = useAuthStore((s) => s.user);
  const room = useSourceStore((s) => s.room);
  const { setRoom } = useSourceStore.getState();
  const { busy, run } = useAction();

  if (!available) {
    return (
      <Section>
        <div className="hud-empty">Not set up in this build yet (see Multiplayer in the README).</div>
      </Section>
    );
  }
  if (loading) return <Section><div className="hud-empty">…</div></Section>;
  if (!user) return <SignIn />;
  if (!room) return <ChooseRoom userId={user.id} email={user.email} />;
  if (room.status === 'pending') {
    return (
      <Section>
        <div className="hud-note hud-note--ask">
          Asked to join <b>{room.name}</b>. Waiting for the owner to let you in…
        </div>
        <button className="hud-action hud-small" disabled={busy} onClick={() => void run(async () => { await removeMember(room.id, user.id); setRoom(null); })}>
          Cancel request
        </button>
      </Section>
    );
  }
  return <InRoom userId={user.id} />;
}
