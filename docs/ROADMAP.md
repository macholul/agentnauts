# Roadmap: from local project to a published product

## Context

The app (then called groundcrew) works end to end, but only on one machine:
the web app runs on `localhost:5173`, the bridge on `localhost:4747`, hooks
are pasted into `~/.claude/settings.json` by hand, and a browser page hands
the bridge its sign-in token. To be a real product it needs a hosted web app
anyone can open, and a one-command way to connect Claude Code sessions to it.

Decisions made with the user:

- **Data path: through the cloud.** The npm tool sends events to Supabase;
  the website shows them from any device. Nothing local needs to be reachable
  from the browser.
- **The daemon never holds the user's account session.** It gets a separate
  credential per room: publish-only, tied to that one room, revocable on its
  own. A stolen laptop or a departed teammate is cut off by revoking that one
  row, without touching the person's account or other rooms.
- **Free and open source at launch.** No billing.
- **Sign-in (web app only): GitHub, plus email link** as fallback.
- **New name: agentnauts.** `groundcrew` is taken on npm, and `groundcrew-cli`
  is an existing tool for monitoring Copilot agents. `agentnauts` was free on
  npm when chosen (2026-10-01).

## Target shape

```
Claude Code hooks ─curl─> local daemon (npm tool)
                          holds one agent credential per room it publishes to
                                │ 1. swaps credential for a 1-hour, send-only token
                                │    (one small Edge Function)
                                │ 2. sends signed events to that room's channel
                                v
                          Supabase Realtime (private channels)
                                │
                                v
              hosted web app: signed in with the user's own session,
              subscribes to the rooms the user is a member of
```

**Everything is a room.** Each user gets a personal room of one, created at
sign-up, for watching their own agents. Team rooms work as today. "Sharing
into a room" means the daemon has a live agent credential for it; "stop
sharing" means revoking it.

**`project_agents` table:** `id`, `user_id`, `room_id`, credential,
`device_name`, `share_details`, `created_at`, `last_seen_at`, `revoked_at`.

- Credential: the machine's existing Ed25519 public key (from
  `server/src/identity.ts`), with the daemon proving it holds the private key.
  No secret passes through the browser. (Alternative with the same table and
  flow: an opaque token shown once, stored as a hash.)
- Revoked by: the user (a "connected computers" list in the app), or
  automatically when the membership ends (owner removes them, they leave, the
  room is deleted).
- The exchanged token's identity is the agent row, not the user, so every
  existing access rule and RPC denies it by default. One new rule lets it
  send to its own room's channel while the row is not revoked, checked on
  every send.

What changes from today:

| Today | Target |
|---|---|
| Web page talks to the bridge over `ws://localhost:4747` | Web page only talks to Supabase |
| Page hands the bridge the user's access token | Daemon has its own per-room, publish-only credential |
| Bridge publishes only when sharing into one room | Daemon publishes to each room it is connected to (personal room: full details; team rooms: stripped unless opted in) |
| Page sees nothing until the next event | Page gets a snapshot of current agents when it opens |
| Hooks pasted by hand | Tool installs and removes them |

What stays: hook normalizing (`server/src/normalize.ts`), signed envelopes and
verification (`server/src/identity.ts`, `shared/src/verify.ts`), details
stripping and project aliases (`toRoomContent`, `ProjectAliases` in
`server/src/room.ts`), rooms and their RPCs
(`supabase/migrations/…_private_rooms.sql`), the 3D scene and store, the
shared-clock sync (`web/src/world/sync.ts`), the simulator (becomes the
signed-out demo).

## Phases

Each phase ends with something testable. Order is by risk: the cloud data
path is the biggest change, so it goes first and is tested locally before
anything is published.

### Phase 0: Groundwork (small)

- Pick the new name (done: agentnauts) and rename the code in one pass.
- Add a LICENSE (MIT). Set GitHub's default branch to `main`.
- CI on GitHub Actions: typecheck, test, build on every push.
- Keep the current Supabase project for development; create a second one for
  production.

Done when: name chosen, CI green on `main`.

### Phase 1: Cloud data path with scoped agent credentials (largest)

Goal: with the web app still run locally, agents reach it through Supabase
only, the local WebSocket source is off, and the daemon holds no user session.

- **Database** (new migration next to the rooms one):
  - personal room per user (created on first sign-in).
  - `project_agents` as above; RPCs `connect_agent`, `revoke_agent`,
    `list_agents`; revocation cascades from `remove_member` / `delete_room`.
  - access rule on `realtime.messages`: an agent token may send to its own
    room's topic only, while not revoked. It cannot receive room traffic.
- **Edge Function `agent-auth`**: checks the agent's proof (signature over a
  fresh challenge), checks the row is live, returns a 1-hour send-only token,
  updates `last_seen_at`.
- **Daemon** (`server/src/room.ts`, `index.ts`): drop the token hand-over
  routes (`PUT /room`, `POST /room/token`); keep a list of connected rooms;
  refresh each room's token before it expires; publish to each. For
  snapshots, listen on a tiny per-room "who's here" topic and reply with
  current agents.
- **Web** (`web/src/sources/`): cloud source built from `room.ts`;
  `useEventSources.ts` loses the bridge token sync; the Multiplayer panel's
  share switch becomes connect/revoke; a "connected computers" list;
  `bridge.ts` stays as a dev-only local mode.
- **Pairing** (minimal version for this phase): the daemon prints a link
  carrying its public key and a short fingerprint; the signed-in page shows
  the fingerprint, the user picks a room and confirms.
- **Protocol** (`shared/src/protocol.ts`): version field in the envelope.
- Tests: `server/src/db.test.ts` (PGlite) for the new rules: agent token can
  send only to its room, cannot call any RPC, is refused after revoke, and is
  revoked when the member is removed.

Done when: two accounts on one Mac (the two-daemon setup from
`docs/HANDOFF.md`) see each other with no page talking to localhost; a page
opened late shows the agents already there; revoking an agent in the app
stops its events at once while the user stays signed in and their other
rooms keep working.

### Phase 2: The npm tool (medium)

Goal: `npx <name>` takes a new user from nothing to an astronaut on screen.

- New publishable package built from `server/` with `shared/` bundled in
  (esbuild is already used for the server build).
- Commands: default/`start` (pair if needed, install hooks if needed, run the
  daemon, print the app link), `connect` (pair with another room),
  `disconnect`, `hooks install`, `hooks uninstall`, `status`.
- Pairing polish: the tool opens the browser itself and waits until the agent
  row exists.
- Hooks installer: merges into `~/.claude/settings.json` without touching
  other settings, marks its entries so uninstall removes only those, and uses
  the full hook list from `docs/claude-settings.example.json`.
- Replace the generic `PORT` variable with a product-specific one (launchers
  set `PORT`).
- Check on macOS, Linux and Windows (hooks use `curl … || true`).

Done when: on a clean user account, one command pairs, installs hooks, and a
new Claude Code session shows up in the web app; `hooks uninstall` and
`disconnect` leave no trace.

### Phase 3: Hosted web app (medium)

Goal: a public URL.

- Static hosting for the Vite build (Cloudflare Pages or Vercel free tier),
  on the new domain, deployed from `main` by CI.
- Signed out: landing page with the live simulator world as the demo and a
  "connect Claude Code" block showing the one command.
- Signed in with no agents: onboarding state that waits for the first event.
- Real invite URLs (`/r/<code>`) and the pairing page (`/connect`).
- Production Supabase: migrations and the Edge Function deployed with the
  Supabase CLI, GitHub sign-in app, mail service for email links (Supabase's
  own mailer sends a few per hour), Site URL and redirects, Realtime public
  access off.
- Phone and small-screen layout for the HUD.

Done when: a second person, on their own computer, goes from the landing page
to seeing their agents, then joins a room with the user.

### Phase 4: Hardening and private beta (medium)

- Security review: access rules, the Edge Function, the pairing page (a
  malicious link must not be able to register someone else's key without the
  user seeing and confirming the fingerprint), RPC rate limits, room size cap.
- Usage against free-tier limits (Realtime messages and connections, function
  calls); drop or batch events if needed.
- Privacy page and terms: what is sent (tool names by default, details only
  when opted in), that nothing is stored, how to delete an account (add an
  account-delete RPC).
- "Your tool is out of date" notice driven by the protocol version.
- Error reporting for the web app; a status line in the tool.
- 5 to 10 beta users; fix what they hit.

Done when: beta users connect without help and no open security findings.

### Phase 5: Public launch (small)

- Publish the npm package with provenance from CI; version and changelog flow.
- README rewritten for users (install, privacy, self-hosting pointer); the
  current developer notes move to `docs/`.
- Launch post and demo clip.

### Later (not in the launch)

Daemon auto-start from a hook; history and stats; custom astronaut colors;
GLTF art pass; other agent tools (Codex, Cursor); stream overlay; paid team
features. Persistence and billing are deliberately out: "nothing is stored"
is a selling point at launch.

## Risks to watch

- **The Edge Function holds the project's signing secret** and mints tokens;
  it is the one piece of server code and the main target of the Phase 4
  review. It must only ever issue send-only tokens for a live agent row.
- **Realtime quotas** on the free tier: one copy of each event per connected
  room. Measured in Phase 4.
- **Name not reserved yet**: the npm package, the domain and the GitHub repo
  name are only free, not taken by us, until someone registers them.
- **Old tool, new site**: handled by the protocol version from Phase 1.

## Verification

- Every phase: `npm run typecheck`, `npm test`, `npm run build`.
- Phase 1: the two-account, two-daemon test on one Mac, with the page's
  localhost source disabled; access rules in `server/src/db.test.ts`; a
  manual check that a revoked agent gets refused and that an agent token
  cannot call `create_room` or read a channel.
- Phase 2: run the packed tarball (`npm pack`, then `npx ./<file>.tgz`) with a
  throwaway `HOME`; compare `~/.claude/settings.json` before and after
  install and uninstall.
- Phase 3: open the deployed URL in the browser pane and in a phone-sized
  viewport; full sign-in, pairing and room flow against production.
