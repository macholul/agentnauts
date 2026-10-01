import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { cleanDeviceName, isValidRoomCode, keyFingerprint, normalizeRoomCode, type PairingRequest } from '@agentnauts/shared';
import {
  approveMember,
  connectAgent,
  createRoom,
  deleteRoom,
  listMembers,
  removeMember,
  requestToJoin,
  revokeAgent,
  type MyAgent,
  type RoomMember,
} from '../sources/roomsApi';
import { isStarting, refreshAgents, shareInRoom, stopSharingInRoom, timeOf, uniqueComputers } from '../sources/sharing';
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
    <span className="hud-id" title={title ?? 'Verified ID: only this computer can send events with it'}>
      ✓ {keyFingerprint(publicKey)}
    </span>
  );
}

function Section({ title = 'Room', children }: { title?: string; children: ReactNode }) {
  return (
    <section className="hud-section">
      <div className="hud-section__title">{title}</div>
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

/**
 * Sign in by email, no password. The email has a sign-in link (and a code
 * too, if the Supabase email template includes one); clicking the link signs
 * this browser in and every open agentnauts tab updates by itself.
 */
function SignIn() {
  const pairing = useSourceStore((s) => s.pairing);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [useCode, setUseCode] = useState(false);
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!sent) void run(async () => { await sendSignInCode(email); setSent(true); });
    else if (useCode) void run(() => verifySignInCode(email, code));
  };

  return (
    <Section title="Account">
      {pairing ? (
        <div className="hud-note hud-note--ask">
          Sign in to connect this computer <IdChip publicKey={pairing.key} title="Check that the terminal shows the same ID" />
        </div>
      ) : (
        <div className="hud-small hud-muted">Sign in to see your agents here and join private rooms.</div>
      )}
      <form className="hud-form" onSubmit={submit}>
        <input
          className="hud-input"
          type="email"
          placeholder="you@example.com"
          value={email}
          disabled={sent}
          onChange={(e) => setEmail(e.target.value)}
        />
        {!sent && (
          <button type="submit" className="hud-button" disabled={busy || !email.includes('@')}>
            Email me a sign-in link
          </button>
        )}
        {sent && (
          <div className="hud-note hud-note--ask">
            Check your inbox and click the link in the email from Supabase, in this browser. This page signs in by
            itself.
          </div>
        )}
        {sent && useCode && (
          <div className="hud-form__row">
            <input
              className="hud-input hud-room-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code from the email"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 10))}
            />
            <button type="submit" className="hud-button" disabled={busy || code.length < 6}>
              Sign in
            </button>
          </div>
        )}
        {sent && (
          <div className="hud-small">
            {!useCode && (
              <>
                <button type="button" className="hud-action" onClick={() => setUseCode(true)}>
                  Got a code instead?
                </button>
                {' · '}
              </>
            )}
            <button type="button" className="hud-action" disabled={busy} onClick={() => void run(() => sendSignInCode(email))}>
              Resend
            </button>
            {' · '}
            <button type="button" className="hud-action" onClick={() => { setSent(false); setCode(''); setUseCode(false); }}>
              Different email
            </button>
          </div>
        )}
      </form>
      {error && <div className="hud-note">{error}</div>}
    </Section>
  );
}

function lastSeen(agents: MyAgent[], publicKey: string): string {
  const times = agents.filter((a) => a.publicKey === publicKey && a.lastSeenAt).map((a) => timeOf(a.lastSeenAt!));
  if (times.length === 0) return 'not seen yet';
  const minutes = Math.floor((Date.now() - Math.max(...times)) / 60_000);
  if (minutes < 2) return 'seen just now';
  if (minutes < 90) return `seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `seen ${hours} h ago` : `seen ${Math.round(hours / 24)} days ago`;
}

/**
 * A computer asking to be connected (you opened the link its daemon printed).
 * Connecting registers its public key for your personal room; the computer
 * never gets your sign-in.
 */
function Pairing({ pairing }: { pairing: PairingRequest }) {
  const personal = useSourceStore((s) => s.personalRoom);
  const already = useSourceStore((s) => s.agents.some((a) => a.personal && a.publicKey === pairing.key));
  const [device, setDevice] = useState(pairing.device || 'My computer');
  const { busy, error, run } = useAction();
  const done = () => {
    useSourceStore.getState().setPairing(null);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };
  useEffect(() => {
    if (already) done();
  }, [already]);

  return (
    <Section title="Connect a computer">
      <div className="hud-note hud-note--ask">
        <div>
          A computer wants to send its agents to your account. Check that its terminal shows this ID:{' '}
          <IdChip publicKey={pairing.key} title="If the terminal shows a different ID, don't connect" />
        </div>
        <input
          className="hud-input"
          placeholder="Name for this computer"
          value={device}
          maxLength={40}
          onChange={(e) => setDevice(e.target.value)}
        />
        <div className="hud-form__row">
          <button
            className="hud-button"
            disabled={busy || !personal || !cleanDeviceName(device)}
            onClick={() =>
              void run(async () => {
                await connectAgent(personal!.id, pairing.key, cleanDeviceName(device), true);
                await refreshAgents();
                done();
              })
            }
          >
            Connect
          </button>
          <button className="hud-button hud-button--ghost" disabled={busy} onClick={done}>
            Not now
          </button>
        </div>
      </div>
      {error && <div className="hud-note">{error}</div>}
    </Section>
  );
}

/** Your connected computers. Disconnecting one cuts it off everywhere, at once. */
function Computers() {
  const agents = useSourceStore((s) => s.agents);
  const { busy, error, run } = useAction();
  const computers = uniqueComputers(agents);

  return (
    <Section title="Your computers">
      {computers.length === 0 ? (
        <div className="hud-empty">None connected yet. Start the agentnauts daemon on your computer and open the link it prints.</div>
      ) : (
        <ul className="hud-people">
          {computers.map((computer) => (
            <li key={computer.publicKey}>
              <b>{computer.deviceName}</b> <IdChip publicKey={computer.publicKey} title="This computer's ID" />{' '}
              <span className="hud-muted hud-small">{lastSeen(agents, computer.publicKey)}</span>
              <button
                className="hud-action hud-small hud-remove"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Disconnect "${computer.deviceName}"? It stops sending its agents right away.`)) return;
                  void run(async () => {
                    for (const agent of agents.filter((a) => a.publicKey === computer.publicKey)) await revokeAgent(agent.id);
                    await refreshAgents();
                  });
                }}
              >
                disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="hud-note">{error}</div>}
    </Section>
  );
}

/** Signed in, not in a room: create one or ask to join one. */
function ChooseRoom({ userId, email }: { userId: string; email: string }) {
  const name = useSourceStore((s) => s.name);
  const inviteCode = useSourceStore((s) => s.inviteCode);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const { setName, setRoom } = useSourceStore.getState();
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState(inviteCode ?? '');
  const { busy, error, run } = useAction();
  const normalized = normalizeRoomCode(code);

  return (
    <Section>
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
          void run(async () => {
            const room = await requestToJoin(normalized, name, userId);
            setRoom(room);
            // Already a member (your own room, or let in before): share right away.
            if (room.status === 'member') await shareInRoom(room.id, shareDetails);
          });
        }}
      >
        <div className="hud-small hud-muted">Join a room (the owner lets you in)</div>
        <div className="hud-form__row">
          <input
            className="hud-input hud-room-code"
            placeholder="crew-xxxx-xxxx-xxxx or invite link"
            value={code}
            maxLength={200}
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
          void run(async () => {
            const room = await createRoom(roomName.trim(), name);
            setRoom(room);
            await shareInRoom(room.id, shareDetails);
          });
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
      <div className="hud-small hud-muted">
        Once you're in a room, your agents are shared with it: tool names only, unless you choose more. You can stop
        sharing and keep watching.
      </div>
      <div className="hud-small hud-muted hud-your-id">
        {email} ·{' '}
        <button className="hud-action" onClick={() => void signOut()}>
          Sign out
        </button>
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
  const agents = useSourceStore((s) => s.agents);
  const name = useSourceStore((s) => s.name);
  const status = useSourceStore((s) => s.sources.room);
  const shareDetails = useSourceStore((s) => s.shareDetails);
  const { setShareDetails, setRoom } = useSourceStore.getState();
  const [members, refresh] = useMembers(room.id);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const { busy, error, run } = useAction();

  // The members list is the source of truth for who owns the room.
  const owner = members.find((m) => m.isOwner)?.userId === userId;
  useEffect(() => {
    if (members.length > 0 && owner !== room.owner) setRoom({ ...room, owner });
  }, [owner, members.length, room, setRoom]);

  // Sharing here means your computers are connected to this room too.
  const computers = uniqueComputers(agents);
  const here = agents.filter((a) => a.roomId === room.id);
  const sharing = here.length > 0;
  const starting = here.filter(isStarting);
  const notShared = computers.filter((c) => !here.some((a) => a.publicKey === c.publicKey));
  const share = (details: boolean) => run(() => shareInRoom(room.id, details));
  // Until each computer has picked the room up, look more often than usual.
  const waiting = starting.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const handle = window.setInterval(() => void refreshAgents().catch(() => {}), 3000);
    return () => window.clearInterval(handle);
  }, [waiting]);
  const pending = members.filter((m) => m.status === 'pending');
  const joined = members.filter((m) => m.status === 'member');
  const verified = Object.values(people).filter((p) => !agents.some((a) => a.publicKey === p.key));
  const watchers = [...new Set(roommates.map((r) => r.name))];
  const copy = (what: 'code' | 'link', text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };

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
          onClick={() => copy('code', room.code)}
        >
          {copied === 'code' ? 'Copied!' : 'Copy code'}
        </button>
        <button
          className="hud-action hud-small"
          title={shareLink(room.code)}
          onClick={() => copy('link', shareLink(room.code))}
        >
          {copied === 'link' ? 'Copied!' : 'Invite link'}
        </button>
      </div>
      {status?.state === 'error' && <div className="hud-note">{status.detail}</div>}

      {sharing ? (
        <>
          {waiting ? (
            <div className="hud-note hud-note--ask">
              Starting to share… waiting for {starting.map((a) => a.deviceName).join(', ')}. A computer picks this up
              within half a minute while agentnauts is running on it.
            </div>
          ) : (
            <div className="hud-small hud-sharing">
              Sharing your agents as {name}{' '}
              {here.map((a) => (
                <IdChip key={a.id} publicKey={a.publicKey} title={a.deviceName} />
              ))}
            </div>
          )}
          {notShared.length > 0 && (
            <button className="hud-action hud-small" disabled={busy} onClick={() => void share(here.every((a) => a.shareDetails))}>
              Also share {notShared.map((c) => c.deviceName).join(', ')}
            </button>
          )}
          <label className="hud-check hud-small">
            <input
              type="checkbox"
              checked={here.every((a) => a.shareDetails)}
              disabled={busy}
              onChange={(e) => {
                setShareDetails(e.target.checked);
                void share(e.target.checked);
              }}
            />
            Also share project names, files &amp; commands
          </label>
          <button className="hud-action hud-small" disabled={busy} onClick={() => void run(() => stopSharingInRoom(room.id))}>
            Stop sharing (keep watching)
          </button>
        </>
      ) : (
        <div className="hud-note">
          {computers.length === 0 ? (
            'Watching only. Connect a computer to share your own agents too.'
          ) : (
            <>
              Watching only.{' '}
              <button className="hud-action" disabled={busy} onClick={() => void share(shareDetails)}>
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

/** A shared room: pick one, wait to be let in, or be in it. */
function RoomPanel({ userId, email }: { userId: string; email: string }) {
  const room = useSourceStore((s) => s.room);
  const { setRoom } = useSourceStore.getState();
  const { busy, run } = useAction();

  if (!room) return <ChooseRoom userId={userId} email={email} />;
  if (room.status === 'pending') {
    return (
      <Section>
        <div className="hud-note hud-note--ask">
          Asked to join <b>{room.name}</b>. Waiting for the owner to let you in…
        </div>
        <button className="hud-action hud-small" disabled={busy} onClick={() => void run(async () => { await removeMember(room.id, userId); setRoom(null); })}>
          Cancel request
        </button>
      </Section>
    );
  }
  return <InRoom userId={userId} />;
}

/** HUD sections for a signed-in person: connect computers, share a room. */
export function Multiplayer() {
  const available = useAuthStore((s) => s.available);
  const loading = useAuthStore((s) => s.loading);
  const user = useAuthStore((s) => s.user);
  const pairing = useSourceStore((s) => s.pairing);

  if (!available) {
    return (
      <Section title="Account">
        <div className="hud-empty">Not set up in this build yet (see the README).</div>
      </Section>
    );
  }
  if (loading) return <Section title="Account"><div className="hud-empty">…</div></Section>;
  if (!user) return <SignIn />;
  return (
    <>
      {pairing && <Pairing pairing={pairing} />}
      <Computers />
      <RoomPanel userId={user.id} email={user.email} />
    </>
  );
}
