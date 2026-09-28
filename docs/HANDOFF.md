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

## Status: what is NOT verified yet (do this first)

The cloud sandbox could not reach `*.supabase.co`, so the live Supabase path
was only tested against a local fake. Pending, in this order:

1. User must finish dashboard setup (see README → Multiplayer):
   run the migration SQL in the SQL editor; Authentication → URL
   Configuration: Site URL `http://localhost:5173` and Redirect URL
   `http://localhost:5173/**`; Realtime → Settings: turn off "Allow public
   access". (Email templates can't be edited without custom SMTP; not needed.)
2. Then test for real: sign in (magic link), create a room, second browser
   with another email asks to join, owner lets in, both share, astronauts
   appear across browsers. Watch the HUD status dot and browser console.
   Likely spots to debug if something fails:
   - `web/src/sources/room.ts`: private channel subscribe / `realtime.setAuth()`.
   - `server/src/room.ts`: `httpSend` to a private channel with the user's
     token (401/403 means RLS or token problem).
   - RLS policies on `realtime.messages` (the `topic_room_id()` helper parses
     `groundcrew:<uuid>`).
   - `list_room_members` joins `auth.users` (security definer); if it errors,
     check grants.
3. Real GPU check: headless testing ran at ~2 FPS in software rendering;
   motion smoothness was never seen on real hardware.

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
