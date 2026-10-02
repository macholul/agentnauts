# agentnauts: handoff notes

Renamed from groundcrew on 2026-10-01 (the name was taken on npm). The
GitHub repo and the local folder may still carry the old name.

Context for the next Claude Code session (the previous one ran in the cloud
and ended here). Branch: `claude/optimistic-rubin-lyogwk` on
`macholul/groundcrew`, fully pushed, no PR opened yet.

## What it is

A cartoon 3D visualizer for Claude Code agents (inspired by Pixel Agents,
Astroneer-like pastel style, everything built from primitives). Each Claude
Code session is an astronaut on an angled bird's-eye view of a planet surface;
it walks to a station for each tool (fabricator = Edit/Write, scanner =
Read/Grep/Glob, drill = Bash, radar = WebSearch/WebFetch), waits on the
landing pad with a "!" when Claude needs the user, wanders when idle.
Subagents drop in as smaller crew astronauts. Private multiplayer rooms let
teammates see each other's astronauts.

## Run it

```bash
npm install
npm run dev        # bridge on :4747 + web on http://localhost:5173
npm run typecheck  # strict TS (TypeScript 7) in all workspaces
npm test           # 26 tests (shared + server, incl. database access rules)
npm run build
```

Claude Code hooks (curl → `http://127.0.0.1:4747/event`) are installed with
`npm run agentnauts -- hooks install`; see the README. The dev simulator (fake
agents) is on by default in dev; toggle in the HUD.

## Layout (npm workspaces)

- `shared/`: `AgentEvent`, `Intent`, pure `mapEventToIntent.ts`, bridge↔web
  protocol, room codes, signed-envelope types + WebCrypto verifier
  (`verify.ts`), Supabase project URL/anon key (`cloud.ts`).
- `server/` (event bridge, plain `node:http` + `ws`): `normalize.ts` (hook JSON
  → AgentEvent), `origin.ts` (localhost-only browser origins),
  `identity.ts` (Ed25519 key in `~/.agentnauts/identity.json`), `room.ts`
  (RoomManager: shares to a Supabase private channel with a short-lived
  access token handed over by the web app; room remembered in
  `~/.agentnauts/room.json`, never auto-resumed), `index.ts` (routes:
  `POST /event`, `GET /health`, `GET|PUT|DELETE /room`, `POST /room/token`,
  `WS /ws`).
- `web/` (Vite + React 19 + three + R3F + drei + zustand):
  - `world/config.ts`: every position/scale/camera limit in one place
    (`STATION_SCALE` 1.65, `PAD_SCALE` 1.3, `SURFACE`, seeded decorations).
  - `world/terrain.ts`, `navigation.ts`: height field (flat base, hills
    outside; flat zones under stations/pad cancel everything), waypoint
    pathing.
  - `store/agentStore.ts`: agents map, plain data only; scene reads with
    `getState()` in `useFrame`.
  - `scene/`: `PlanetSurface` (faceted jittered grid + canvas ground
    texture), `GroundClutter`, `Decorations` (seeded variants),
    `stations/*`, `agents/AgentActor` (behavior) + `Astronaut` (visual, driven
    by a pose ref so it can become GLTF), `textures.ts`.
  - `sources/`: `AgentEventSource` interface; `bridge.ts`, `simulator.ts`,
    `room.ts` (private channel, verifies signatures, drops replays),
    `supabase.ts` (auth), `roomsApi.ts` (RPC wrappers), `sourceStore.ts`,
    `useEventSources.ts` (wiring, membership polling, bridge sync/tokens).
  - `hud/`: `Hud.tsx`, `Multiplayer.tsx`, `SharingBadge.tsx`.
- `supabase/migrations/20260928000000_private_rooms.sql`: rooms,
  room_members, RLS, `realtime.messages` policies, RPCs (`create_room`,
  `request_to_join`, `list_room_members`, `approve_member`, `remove_member`,
  `delete_room`). Tested in `server/src/db.test.ts` with PGlite + stub
  auth/realtime schemas.

## Multiplayer design (short)

- Sign in with Supabase email magic link (implicit flow; default email, no
  SMTP needed). A code field exists for when a template has `{{ .Token }}`.
- Owner creates a room; others ask with the code/invite link; owner lets in /
  denies / removes. Channel `agentnauts:<room uuid>`, `private: true`; RLS
  only lets approved members send/receive.
- Bridge gets only the access token (memory), never the refresh token; web
  pushes refreshed tokens. Sharing pauses ~1h after the app is closed.
- Events are signed per machine (Ed25519); browsers verify, show short IDs
  (`✓ a3f9-c21e`), namespace sessions by key. Project names aliased to
  "project N" and details stripped unless the user opts in. Consent: sharing
  only after an explicit click in the current page; never auto-resumes after a
  bridge restart; "Sharing live" badge while sharing.

## Phase 1 of the roadmap: cloud data path (2026-10-01)

See `docs/ROADMAP.md` for the plan. What changed from the notes below:

- The page no longer talks to the daemon. Events go daemon → Supabase
  Realtime → page. `web/src/sources/bridge.ts` is local mode only
  (`VITE_LOCAL_BRIDGE=1`).
- The daemon holds no account session. `server/src/connections.ts` asks the
  `agent-auth` Edge Function (`supabase/functions/agent-auth/index.ts`) for a
  send-only token per room, using a signature from `identity.ts`. Rooms it
  publishes to are rows in `project_agents` for its public key
  (`supabase/migrations/20261001010000_agents.sql`). `PUT /room`,
  `/room/token` and `~/.agentnauts/room.json` are gone.
- Everyone has a personal room (`my_room` RPC) that their computers publish
  to with full details. Sharing into a team room connects the same computers
  to that room (details stripped unless opted in).
- Pairing: the daemon prints `…/#connect=<public key>&device=<name>`; the
  signed-in page shows the key's short ID and calls `connect_agent`.
- Late joiners: the daemon resends its current agents every 20 seconds
  (`agent_snapshot` broadcast); the page adds the ones it doesn't have.
- On the real Supabase project: the migrations are applied, `agent-auth` is
  deployed, and the secret `AGENT_JWT_SECRET` (legacy JWT secret) is set.
  `npm run check:cloud -w server` checks a connected computer end to end.
- Verified live: a send-only token is accepted in its own room, refused in
  others, cannot use the REST API, and is refused at once after its row is
  deleted. The whole flow with two accounts on one Mac (pair both computers,
  join a room, share, a scripted agent on the second daemon) was run on
  2026-10-01; Supabase accepted every event in the personal and shared rooms.
- Learned in that run: Supabase's gateway answers 403 to requests whose body
  looks like an attack (a piped shell command, SQL). Events with command
  text were being dropped, so the signed content is now sent as base64url
  (envelope `v: 3`). Don't put readable commands or file contents in any
  request to Supabase.
- Joining or creating a room shares your agents there automatically (your
  computers are connected to the room); a daemon with agents checks in every
  30 seconds, so that takes effect within half a minute.
- MCP tools (`mcp__…`) go to the radar; in rooms without details they are
  reported under one generic name.

## Phase 2 of the roadmap: the npm tool (2026-10-02)

- `server/` is now the package `agentnauts` (`bin: dist/cli.js`, one bundled
  file, `ws` as its only dependency). `server/src/index.ts` is gone:
  `cli.ts` is the command, `daemon.ts` the daemon (`startDaemon`), `args.ts`
  the argument parsing, `config.ts` the settings, `hooks.ts` the hooks
  installer, `browser.ts` opens the pairing link.
- Commands: `agentnauts` (start), `connect`, `disconnect`, `status`,
  `hooks install|uninstall|status`, `uninstall`. From the repo:
  `npm run agentnauts -- <command>`. `npm run dev` starts the daemon with
  `--no-hooks --no-open --verbose`.
- Settings are `AGENTNAUTS_PORT`, `AGENTNAUTS_HOST`,
  `AGENTNAUTS_ALLOWED_ORIGINS`, `AGENTNAUTS_APP_URL`,
  `AGENTNAUTS_SUPABASE_URL`, `AGENTNAUTS_SUPABASE_ANON_KEY`. The generic
  `PORT`, `HOST`, `SUPABASE_URL` are ignored and no `.env` is loaded.
- The hooks installer recognizes its own hooks by `# agentnauts` at the end
  of the command (and the old hand-pasted command), and never touches
  anything else in `~/.claude/settings.json`. The hook is a shell command on
  purpose: the no-shell `args` form can't ignore curl's exit code.
  `docs/claude-settings.example.json` is generated from the installer and a
  test keeps them equal.
- `agentnauts disconnect`: `agent-auth` takes `action: "disconnect"` with a
  proof signed for that (`agentDisconnectMessage`), and calls `agent_logout`
  (`supabase/migrations/20261002000000_agent_logout.sql`, service role only).
  Applied and deployed on the real project (function version 3).
- The daemon refuses requests whose `Host` header is not a local name (DNS
  rebinding), in addition to the Origin check.
- `npm run smoke -w server` packs the package, installs the tarball into an
  empty project and runs every command with a throwaway home folder and a
  stand-in service. CI runs typecheck, tests, build and the smoke test on
  Linux, macOS and Windows.
- When trying commands by hand, set `HOME` to a scratch folder: `hooks
  install`, `disconnect` and `uninstall` act on the real settings file and
  the real key otherwise.
- Not done: releasing to npm (waits for the hosted app, since
  `CLOUD.appUrl` is still `http://localhost:5173`), and a person trying it on
  Windows.
- Hosting is prepared, not done: `vercel.json` (repo root) builds
  `web/dist` on Vercel with no dashboard settings, forbids showing the app
  inside another site's frame (the Connect button registers a computer, so
  it must not be clickable through a disguised page) and caches the hashed
  assets. When the app has an address, put it in `CLOUD.appUrl`
  (`shared/src/cloud.ts`) and in Supabase's Site URL and Redirect URLs. Run
  from source, the daemon keeps linking to `http://localhost:5173`
  (`readSettings(env, fromSource)` in `server/src/config.ts`).

## Status: verified live (2026-10-01)

Tested on a real Mac against the real Supabase project:

- Single player with real Claude Code sessions (global hooks in
  `~/.claude/settings.json`); motion is smooth on a real GPU.
- Multiplayer end to end: magic-link sign-in, create room, ask to join, let
  in, share from both sides, astronauts appear in each other's world. The
  private channel accepts sends with the user's token (no 401/403).
- Dashboard setup that was needed: migration SQL, Site URL
  `http://localhost:5173`, Redirect URLs `http://localhost:5173/**` (plus
  `http://localhost:5174/**` for the two-accounts-on-one-machine test),
  Realtime "Allow public access" off.

Found and fixed during that test:

- `SessionEnd` (and `UserPromptSubmit`, `SubagentStart`,
  `PostToolUseFailure`) are now in the standard hooks config; without
  `SessionEnd` closed sessions stayed for 30 minutes.
- A second open tab on the same bridge switched sharing off right away. Only
  the page that started (or adopted) sharing stops it now.
- The join field takes a pasted invite link; rooms have a "Copy code" button.
- Browsers in a room now show the same world: wandering, landing spots,
  colors, look-around and station animations come from the agent id and a
  shared wall clock (`web/src/world/sync.ts`), not `Math.random()` or page
  uptime. Not synced: free-spinning parts, walk cycles, simulator agents.

Testing two accounts on one machine: run a second daemon with its own `HOME`,
`AGENTNAUTS_PORT=4748` and `AGENTNAUTS_APP_URL=http://localhost:5174`, and a
second web app on 5174. Post hook JSON to `http://localhost:4748/event` with
curl to give that side an agent.

## Known limits / ideas

- Supabase built-in email: a few emails per hour.
- Older Claude Code versions without `agent_id` put subagent work on the
  main astronaut.
- Nunito font loads from Google Fonts (falls back to system fonts offline).
- Ideas not started: late-join history, custom astronaut colors, GLTF art
  pass, opening a PR / merging to the default branch.

## Testing tips

- Dev-only store handle: `window.__agentnauts.store` (inject events with
  `applyEvent`, or set agent state directly for screenshots).
- Headless Chromium (Playwright) works with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`, but is slow; place
  agents directly rather than waiting for them to walk.
- To fake Supabase locally, run the web app with `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` and the daemon with `AGENTNAUTS_SUPABASE_URL` /
  `AGENTNAUTS_SUPABASE_ANON_KEY` pointing at a small HTTP server that answers
  `/auth/v1/otp`, `/auth/v1/verify`, `/auth/v1/user`, `/rest/v1/rpc/*`,
  `/rest/v1/room_members` and `/realtime/v1/api/broadcast/*`.
- When killing test processes by pattern, don't put the pattern literally in
  the same shell command (it matches and kills the shell itself).
