/**
 * The guide card. For visitors it is the landing page, over the demo crew:
 * what this is, the one command, sign-in. After signing in it walks through
 * the first steps: confirm a computer that asked to connect, connect one,
 * wait for the first Claude Code session.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useViewInsets } from '../scene/viewInsets';
import { uniqueComputers } from '../sources/sharing';
import { useSourceStore } from '../sources/sourceStore';
import { useAuthStore } from '../sources/supabase';
import { useIsVisitor } from '../sources/useEventSources';
import { useAgentStore } from '../store/agentStore';
import { IdChip, Pairing, SignInForm } from './Multiplayer';
import './guide.css';

const COMMAND = 'npx agentnauts';
const REPO_URL = 'https://github.com/macholul/agentnauts';
/** "Just watching": don't ask again to connect a computer. */
const NO_COMPUTER_KEY = 'agentnauts.justWatching';
/** Narrower than this, cards are sheets along the bottom (same width as in guide.css). */
const SHEET_QUERY = '(max-width: 900px)';

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'on';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, 'on');
  } catch {
    // Storage unavailable: it only lasts for this page load.
  }
}

/**
 * A guide card. It tells the camera how much of the screen it covers, so the
 * world is framed in the rest: beside it when docked on the left, above it
 * when it is a sheet along the bottom (narrow screens). A card in the middle
 * of a wide screen sits over empty ground and leaves the camera alone.
 */
function Card({ dock, className, label, children }: { dock: 'left' | 'middle'; className: string; label: string; children: ReactNode }) {
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const sheet = window.matchMedia(SHEET_QUERY);
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (sheet.matches) useViewInsets.setState({ left: 0, bottom: Math.max(0, window.innerHeight - rect.top) });
      else useViewInsets.setState({ left: dock === 'left' ? rect.right + 16 : 0, bottom: 0 });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    sheet.addEventListener('change', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      sheet.removeEventListener('change', update);
      useViewInsets.setState({ left: 0, bottom: 0 });
    };
  }, [dock]);
  return (
    <section ref={card} className={`guide ${className}`} aria-label={label}>
      {children}
    </section>
  );
}

/** The one command, with a copy button. */
function Command() {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(COMMAND).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="guide-command">
      <code>{COMMAND}</code>
      <button type="button" className="guide-copy" onClick={copy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

/** For visitors: what this is and how to start, next to the demo crew. */
function Landing() {
  const pairing = useSourceStore((s) => s.pairing);
  const invited = useSourceStore((s) => s.inviteCode !== null);
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button type="button" className="guide-pill" onClick={() => setOpen(true)}>
        <span className="hud-logo" aria-hidden />
        Get started with agentnauts
      </button>
    );
  }

  return (
    <Card dock="left" className="guide--landing" label="Get started">
      <div className="guide-top">
        <span className="guide-brand">
          <span className="hud-logo" aria-hidden />
          agentnauts
        </span>
        <button type="button" className="guide-hide" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>

      {pairing ? (
        <>
          <h1 className="guide-title">Connect this computer</h1>
          <p className="guide-lead">
            Sign in to connect the computer that opened this page. Then check that it shows the same ID as your
            terminal: <IdChip publicKey={pairing.key} title="If your terminal shows a different ID, don't connect" />
          </p>
          <SignInForm />
        </>
      ) : invited ? (
        <>
          <h1 className="guide-title">You're invited to a room</h1>
          <p className="guide-lead">
            Sign in to ask to join. Once the room's owner lets you in, you see each other's Claude Code agents as
            astronauts on this planet.
          </p>
          <SignInForm />
          <p className="guide-hint">
            To bring your own agents, run <code>{COMMAND}</code> on your computer.
          </p>
        </>
      ) : (
        <>
          <h1 className="guide-title">Watch your Claude Code agents at work</h1>
          <p className="guide-lead">
            Every Claude Code session becomes a little astronaut on this planet. It walks to a station for what it is
            doing, and waits on the landing pad when it needs you. The crew here now is a demo.
          </p>
          <ol className="guide-steps">
            <li>
              <b>Run this on your computer</b>
              <Command />
              <span className="guide-hint">
                It sets up Claude Code and opens this page to connect your computer. Needs Node.js 20.19 or newer.
              </span>
            </li>
            <li>
              <b>Sign in</b>
              <SignInForm />
            </li>
            <li>
              <span>
                <b>Start Claude Code.</b> Your astronauts land here. Share a room to see your team's too.
              </span>
            </li>
          </ol>
        </>
      )}

      <footer className="guide-footer">
        File contents, prompts and Claude's replies never leave your computer, and agent activity is relayed live,
        never stored.{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          Open source on GitHub
        </a>
      </footer>
    </Card>
  );
}

/** Signed in: whatever comes next on the way to seeing your own agents. */
function FirstSteps() {
  const pairing = useSourceStore((s) => s.pairing);
  const loaded = useSourceStore((s) => s.agentsLoaded);
  const computers = uniqueComputers(useSourceStore((s) => s.agents));
  // Astronauts flying home (the demo crew after signing in) don't count.
  const emptyWorld = useAgentStore((s) => Object.values(s.agents).every((a) => a.lifecycle === 'leaving'));
  const [justWatching, setJustWatching] = useState(() => readFlag(NO_COMPUTER_KEY));

  const step = pairing
    ? 'confirm'
    : !loaded
      ? null
      : computers.length === 0
        ? justWatching
          ? null
          : 'connect'
        : emptyWorld
          ? 'wait'
          : null;

  if (step === 'confirm' && pairing) {
    return (
      <Card key="confirm" dock="middle" className="guide--step" label="Connect a computer">
        <Pairing pairing={pairing} />
      </Card>
    );
  }
  if (step === 'connect') {
    return (
      <Card key="connect" dock="middle" className="guide--step" label="Connect your computer">
        <h2 className="guide-heading">Connect your computer</h2>
        <p className="guide-text">
          Run this in a terminal on the computer where you use Claude Code. It sets up Claude Code and opens this page
          to connect it.
        </p>
        <Command />
        <div className="guide-row">
          <span className="guide-hint">Needs Node.js 20.19 or newer.</span>
          <button
            type="button"
            className="hud-action guide-hint"
            onClick={() => {
              writeFlag(NO_COMPUTER_KEY);
              setJustWatching(true);
            }}
          >
            I'm just watching
          </button>
        </div>
      </Card>
    );
  }
  if (step === 'wait') {
    return (
      <div
        className="guide-waiting"
        role="status"
        title="Astronauts land here as soon as a Claude Code session does something, while agentnauts runs on that computer."
      >
        <span className="guide-waiting__dot" aria-hidden />
        Waiting for Claude Code on {computers.map((c) => c.deviceName).join(', ')}
      </div>
    );
  }
  return null;
}

export function Guide() {
  const visitor = useIsVisitor();
  const signedIn = useAuthStore((s) => s.user !== null);
  if (visitor) return <Landing />;
  if (signedIn) return <FirstSteps />;
  return null;
}
