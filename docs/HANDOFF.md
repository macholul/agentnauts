# groundcrew: handoff notes

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

Claude Code hooks config (curl → `http://localhost:4747/event`) is in the
README and `docs/claude-settings.example.json`. The dev simulator (fake
agents) is on by default in dev; toggle in the HUD.

## Layout (npm workspaces)

- `shared/`: `AgentEvent`, `Intent`, pure `mapEventToIntent.ts`, bridge↔web
  protocol, room codes, signed-envelope types + WebCrypto verifier
  (`verify.ts`), Supabase project URL/anon key (`cloud.ts`).
- `server/` (event bridge, plain `node:http` + `ws`): `normalize.ts` (hook JSON
  → AgentEvent), `origin.ts` (localhost-only browser origins),
  `identity.ts` (Ed25519 key in `~/.groundcrew/identity.json`), `room.ts`
  (RoomManager: shares to a Supabase private channel with a short-lived
  access token handed over by the web app; room remembered in
  `~/.groundcrew/room.json`, never auto-resumed), `index.ts` (routes:
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
  denies / removes. Channel `groundcrew:<room uuid>`, `private: true`; RLS
  only lets approved members send/receive.
- Bridge gets only the access token (memory), never the refresh token; web
  pushes refreshed tokens. Sharing pauses ~1h after the app is closed.
- Events are signed per machine (Ed25519); browsers verify, show short IDs
  (`✓ a3f9-c21e`), namespace sessions by key. Project names aliased to
  "project N" and details stripped unless the user opts in. Consent: sharing
  only after an explicit click in the current page; never auto-resumes after a
  bridge restart; "Sharing live" badge while sharing.

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

Testing two accounts on one machine: run a second bridge with its own `HOME`
and `PORT=4748`, and a second web app on 5174 with
`VITE_BRIDGE_URL=ws://localhost:4748/ws`. Post hook JSON to
`http://localhost:4748/event` with curl to give that side an agent. Note the
bridge reads the generic `PORT` variable, which some launchers set.

## Known limits / ideas

- Supabase built-in email: a few emails per hour.
- Older Claude Code versions without `agent_id` put subagent work on the
  main astronaut.
- Nunito font loads from Google Fonts (falls back to system fonts offline).
- Ideas not started: late-join history, custom astronaut colors, GLTF art
  pass, opening a PR / merging to the default branch.

## Testing tips

- Dev-only store handle: `window.__groundcrew.store` (inject events with
  `applyEvent`, or set agent state directly for screenshots).
- Headless Chromium (Playwright) works with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`, but is slow; place
  agents directly rather than waiting for them to walk.
- To fake Supabase locally, run the web app with `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` and the bridge with `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` pointing at a small HTTP server that answers
  `/auth/v1/otp`, `/auth/v1/verify`, `/auth/v1/user`, `/rest/v1/rpc/*`,
  `/rest/v1/room_members` and `/realtime/v1/api/broadcast/*`.
- When killing test processes by pattern, don't put the pattern literally in
  the same shell command (it matches and kills the shell itself).
