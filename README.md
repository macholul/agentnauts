# agentnauts

A cartoon 3D visualizer for AI coding agents. Every Claude Code session becomes a
little astronaut working on a base on an alien planet, seen from above: it walks to the
**fabricator** to edit files, the **scanner** to read and search, the **drill**
to run shell commands and the **radar dish** to search the web or use outside
tools (MCP). When the agent
needs you, its astronaut waits on the landing pad with a big **!** over its head.
Subagents drop in as smaller crew astronauts and fly off when they're done.

Inspired by Pixel Agents, but in 3D, with a soft pastel, Astroneer-like toy
style (all art is original, built from primitives).

The app is hosted at <https://agentnauts.vercel.app>.

![agentnauts screenshot](docs/screenshot.jpg)

## Quick start

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev          # daemon on :4747 + web app on :5173
```

Open <http://localhost:5173>. In dev the **simulator** is on, so two fake
agents start working right away. Toggle it in the HUD (top left); the choice is
remembered. Production builds (`npm start`, served on :4173) start with it off.

To see your real Claude Code sessions:

1. **Sign in** in the HUD (a link is emailed to you, no password).
2. **Connect this computer**: `npm run agentnauts -- connect` opens the app
   with this computer's link. Check that the page shows the same ID as the
   terminal, and click **Connect**.
3. **Add the hooks**: `npm run agentnauts -- hooks install` (see
   [Connecting Claude Code](#connecting-claude-code)).

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Daemon (`tsx watch`) and Vite dev server together                   |
| `npm run web`       | Only the web app                                                    |
| `npm run server`    | Only the daemon                                                     |
| `npm run agentnauts -- <command>` | The `agentnauts` command from source (`status`, `connect`, `hooks install`, …) |
| `npm run typecheck` | Strict TypeScript check of all workspaces                           |
| `npm test`          | Unit tests, including the database access rules                     |
| `npm run build`     | Typecheck, then build `web/dist` and `server/dist/cli.js`           |
| `npm start`         | Build, then run the bundled daemon and `vite preview`               |
| `npm run smoke -w server` | Pack the npm package, install it in an empty project and run it with a throwaway home folder |
| `npm run check:cloud -w server` | Check this computer's connection against the real Supabase project |

## The `agentnauts` command

`server/` is the npm package [`agentnauts`](server/README.md): the daemon and
the command that sets everything up. Once the web app is hosted, this is all
a user runs:

```bash
npx agentnauts
```

| Command | What it does |
| --- | --- |
| `agentnauts` | Add the hooks, connect this computer if it isn't yet (opens the app in a browser and waits), then run the daemon |
| `agentnauts connect` | Connect this computer to your account |
| `agentnauts disconnect` | Remove this computer's connections, in every room |
| `agentnauts status` | Whether the daemon runs, the computer's ID, the rooms it publishes to, the hooks |
| `agentnauts hooks install` / `uninstall` / `status` | Manage the Claude Code hooks |
| `agentnauts uninstall` | Disconnect, remove the hooks and this computer's key |

`--no-hooks` leaves Claude Code's settings alone, `--no-open` doesn't open the
browser, `--verbose` prints every event. In this repo `npm run dev` passes
all three, so developing never changes your own Claude Code settings.

The package is not released yet: the published `agentnauts` on npm is still
a placeholder (see [`docs/ROADMAP.md`](docs/ROADMAP.md)). `npm pack -w server`
builds the real one, which opens the hosted app.

## Connecting Claude Code

`agentnauts` (or `agentnauts hooks install`) adds one hook per event to
`~/.claude/settings.json`, so every Claude Code session on this computer
shows up. This is what it writes for each event (`matcher` only on the
three tool events):

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "curl -s --connect-timeout 0.5 -m 2 -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:4747/event || true # agentnauts",
      "timeout": 5
    }
  ]
}
```

The hook pipes the hook's JSON (stdin) to the daemon. `|| true` and the time
limits mean a stopped or stuck daemon never breaks or slows Claude Code: curl
fails fast with "connection refused" and the hook still exits 0. The daemon
replies with an empty body, so nothing ends up on the hook's stdout.

The installer only ever touches its own hooks, which it recognizes by the
`# agentnauts` at the end of the command (and the exact command older
versions of this README had you paste). Your other settings and hooks stay
as they are, `agentnauts hooks uninstall` leaves the file as it was, and a
settings file that isn't valid JSON is left alone. To add the hooks by hand
instead (for example to one project's `.claude/settings.json`), copy
[`docs/claude-settings.example.json`](docs/claude-settings.example.json).

The events: `PreToolUse`, `PostToolUse` and `PostToolUseFailure` move the
astronaut between stations, `Notification` sends it to the landing pad,
`SessionStart` / `SessionEnd` make the commander land and fly home,
`SubagentStart` / `SubagentStop` do the same for crew, `UserPromptSubmit`
shows "Thinking…" and `Stop` ends a turn. Sessions that go quiet for 30
minutes fly home on their own.

On Windows, Claude Code runs hooks with Git Bash (it comes with Git for
Windows), which the command needs.

### Try it without Claude Code

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","cwd":"/tmp/my-project","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}' \
  http://127.0.0.1:4747/event
```

## What the astronauts do

| Event                                        | Astronaut                                                       |
| -------------------------------------------- | --------------------------------------------------------------- |
| `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | walks to the **fabricator** (orange) and works                  |
| `Read`, `Grep`, `Glob`, `LS`                 | **scanner** (teal)                                              |
| `Bash`                                       | **drill** (yellow)                                              |
| `WebSearch`, `WebFetch`, MCP tools (`mcp__…`) | **radar dish** (pink)                                          |
| `Notification` (permission / input needed)   | goes to the **landing pad**, shows a floating **!**             |
| `Stop`, tools without a station (`Task`, `TodoWrite`, …) | idle; the HUD still says what it is doing           |
| no events for ~8 s                           | wanders around the base, pauses, looks around                   |
| tool call inside a subagent (`agent_id`)     | a smaller **crew** astronaut drops in and does it               |
| `SubagentStop`                               | that crew astronaut jetpacks away                               |

Stations react while someone works at them: glowing ground ring, faster
machinery, sparks, data bits or dust.

## Architecture

```
Claude Code hooks ──curl POST /event──▶ server/ (daemon, :4747)
                                          │ normalize.ts: hook JSON → AgentEvent
                                          │ connections.ts: sign, one send-only
                                          │   token per room (from agent-auth)
                                          ▼
                              Supabase Realtime (private channels)
                                          │
web/  ┌───────────────────────────────────▼───────────────────────────────┐
      │ sources/   RoomSource (your personal room, a shared room) ·        │
      │            SimulatorSource · BridgeSource (local mode)            │
      │            all implement AgentEventSource; attachSource() is the  │
      │            only glue to the store                                 │
      │                       │ AgentEvent                                │
      │ store/     applyEvent → mapEventToIntent (shared, pure)           │
      │            zustand map of agents: plain serializable data only    │
      │                       │ getState() in useFrame                    │
      │ scene/     AgentActor (pathing, turning, lifecycle flights)       │
      │              └─ Astronaut (visual, driven by a pose ref)          │
      │            stations react via useStationActivity refs             │
      │ hud/       status, computers, rooms, agent list                   │
      └───────────────────────────────────────────────────────────────────┘
```

The page never talks to the daemon (except in local mode): everything goes
through Supabase, so the app can be hosted anywhere and opened on any device.

**Workspaces**

- `shared/`: `AgentEvent` (normalized event), `Intent`, the pure
  `mapEventToIntent` function, signed-message and pairing-link formats.
- `server/`: the npm package `agentnauts`. `cli.ts` is the command,
  `hooks.ts` the hooks installer, `daemon.ts` the daemon: plain `node:http` +
  `ws` with `POST /event`, `GET /health`, `GET /status`, `POST /refresh`,
  `WS /ws` (local mode). Unknown or malformed payloads are logged and
  ignored, never fatal. `npm run build` bundles it, with `shared/`, into the
  one published file, `dist/cli.js`.
- `supabase/`: migrations (rooms, agent credentials, access rules) and the
  `agent-auth` Edge Function.
- `web/`: Vite + React + TypeScript, three.js via `@react-three/fiber` and
  `@react-three/drei`, zustand.

**Key files**

- `web/src/world/config.ts`: every station position, approach point, the
  landing pad, decorations, palette and camera limits.
- `web/src/world/terrain.ts`, `navigation.ts`: terrain height function
  (shared by the mesh and the feet) and waypoint pathing around obstacles.
- `web/src/store/agentStore.ts`: agents keyed by session id (crew:
  `sessionId/agentId`), `applyEvent` / `spawnAgent` / `removeAgent`, idle and
  wander timers.
- `web/src/scene/agents/AgentActor.tsx`: per-frame behavior; reads the store
  with `getState()` and moves using `delta`.
- `web/src/scene/agents/Astronaut.tsx` and `scene/stations/*`: visuals only.

**Design rules that keep future work open**

- *Rooms*: a room is just another `AgentEventSource` (`sources/room.ts`);
  the scene doesn't know events are remote. The store holds only plain data,
  so it stays easy to sync.
- *Art pass*: the astronaut is driven entirely by an `AstronautPose` ref
  (`idle` / `walk` / `work` / `wait` / `fly`, speed, station). A GLTF model
  just maps those modes to animation clips. Stations are separate components
  that receive an `activity` ref (0..1).

## Accounts, computers and rooms

Your computers send your agents to **your personal room**, which only you can
watch. Share a **room** with teammates and everyone's astronauts work on the
same base. Rooms are private: the room's owner decides who gets in.

```
your Claude Code ──hooks──▶ your daemon ──signed events──▶ your personal room ──▶ your browser
                                 │
                                 └──signed, details removed──▶ shared room ──▶ members' browsers
```

**Using it** (HUD, top left):

1. **Sign in** with your email: click the link Supabase emails you (no password).
2. **Connect a computer**: run `agentnauts` (or `agentnauts connect`) on it;
   the app opens with that computer's link. Compare the ID with the terminal
   and click **Connect**. It shows up under **Your computers**; **disconnect**
   there, or `agentnauts disconnect` on the computer, cuts it off at once.
3. **Create a room**, or **ask to join** one with its code / invite link. The
   owner sees your request (name + email) and clicks **Let in** or **Deny**.
   Owners can remove people and delete the room later.
4. Once you're in a room, your computers are connected to it too and your
   agents are shared there (a computer picks this up within half a minute).
   **Stop sharing** keeps you watching. Other people's astronauts show up
   labelled `name · project`.

**How a computer is trusted.** The daemon never holds your account session.
Each computer has an Ed25519 key pair (`~/.agentnauts/identity.json`,
readable only by you). Connecting a computer registers its *public* key for
one room. To publish, the daemon signs a timestamp with its private key and
the `agent-auth` function answers with a one-hour token for each room that
key is connected to. Such a token can do exactly one thing: send events to
that room's channel. It cannot read the room, see your other rooms or change
anything, and it stops working the moment the computer is disconnected,
removed from the room, or the room is deleted. A computer can also
disconnect itself (`agentnauts disconnect`): it signs a request for exactly
that, and the function removes that key's connections.

**How it's hosted:** one [Supabase](https://supabase.com) project serves
everyone using this build: sign-in, the tables, the `agent-auth` function and
Realtime private channels (events are relayed, never stored). **One-time
setup for the maintainer only:**

1. Create a free Supabase project and paste its project URL and anon
   (publishable) key into [`shared/src/cloud.ts`](shared/src/cloud.ts)
   (Project Settings → API). The anon key is meant to be public.
2. Run the files in [`supabase/migrations`](supabase/migrations), in order,
   in the SQL editor.
3. Deploy [`supabase/functions/agent-auth`](supabase/functions/agent-auth/index.ts)
   as an Edge Function named `agent-auth`, and add the secret
   `AGENT_JWT_SECRET` (Edge Functions → Secrets) with the project's legacy
   JWT secret (Project Settings → JWT Keys).
4. Authentication → Sign In / Providers: keep **Email** enabled. In
   Authentication → URL Configuration, set the Site URL to where people open
   the app (e.g. `http://localhost:5173`) and add it under Redirect URLs, so
   the sign-in link in the email brings people back to it. The built-in email
   sender is rate-limited (a few emails per hour); for bigger teams add your
   own SMTP. With SMTP set up you can also add `{{ .Token }}` to the Magic
   Link template, and the app accepts the code from the email as well.
5. Realtime → Settings: turn **off** "Allow public access", so only signed-in
   members can use channels at all.

**Hosting the web app.** `npm run build -w web` makes a static site in
`web/dist`, so any static host works. This build is on Vercel, as the project
`agentnauts`, which redeploys on every push to `main`; the settings are in
[`vercel.json`](vercel.json), so a fork only needs to import the repository.
The site's address goes in two places: `CLOUD.appUrl` in
[`shared/src/cloud.ts`](shared/src/cloud.ts), so the published tool opens it
(run from this repo, the daemon keeps linking to `http://localhost:5173`),
and Supabase's Authentication → URL Configuration, as the Site URL and as
`https://<address>/**` under Redirect URLs. Keep `http://localhost:5173/**`
in that list for development.

`npm run check:cloud -w server` checks a connected computer against the real
project. The access rules are tested against a real Postgres in
`server/src/db.test.ts`, and the function in `server/src/agentAuth.test.ts`
(run with `npm test`).

**Privacy and identity.**

- *Only you* can watch your personal room. *Only people the owner lets in*
  can watch a shared room. That's enforced by the database (row level
  security on Realtime channels), not by the app. Knowing a room code only
  lets you *ask*. Email addresses are shown to the room owner only.
- *Nothing is shared with others until you join or create a room*, and a
  "Sharing live" badge stays at the top of the screen while you are sharing.
  **Stop sharing** keeps you watching.
- *Minimal by default.* A shared room gets only tool names and states (e.g.
  "Edit", "waiting"). Project folder names become "project 1", "project 2";
  file names, commands and search queries are dropped, and MCP tools are all
  reported as "an outside tool", without the service's name. Tick **Also
  share project names, files & commands** to include them. Your personal room
  gets those details. Code, prompts and Claude's replies are never sent.
- *Nobody can pose as you.* Every event is signed by the computer it came
  from. Browsers drop anything with a bad signature or from a key that isn't
  connected to the room, and signed messages can't be replayed into another
  room. A computer's short ID (e.g. `✓ a3f9-c21e`) is shown in the panel.
- *Nothing is stored.* Events pass through Realtime and are gone. Every 20
  seconds a daemon resends which agents it has, so a page opened later can
  show them.

**Local mode.** To use the app with no account and nothing leaving your
machine, start the web app with `VITE_LOCAL_BRIDGE=1`. The page then reads
events straight from the daemon on `localhost:4747`.

## Configuration

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `AGENTNAUTS_PORT` | daemon | `4747` | Daemon port. The hooks carry it, so run `agentnauts hooks install` with the same value |
| `AGENTNAUTS_HOST` | daemon | `127.0.0.1` | Bind address. Use `0.0.0.0` to open it to your LAN |
| `AGENTNAUTS_ALLOWED_ORIGINS` | daemon | localhost pages only | Extra browser origins allowed to connect, comma separated |
| `AGENTNAUTS_APP_URL` | daemon | `shared/src/cloud.ts` (run from this repo: `http://localhost:5173`) | Where the web app lives, for the link the daemon opens and prints |
| `AGENTNAUTS_SUPABASE_URL`, `AGENTNAUTS_SUPABASE_ANON_KEY` | daemon | `shared/src/cloud.ts` | Use a different Supabase project |
| `CLAUDE_CONFIG_DIR` | daemon | `~/.claude` | Claude Code's own variable for where its settings live; the hooks installer follows it |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | web | `shared/src/cloud.ts` | Use a different Supabase project |
| `VITE_LOCAL_BRIDGE` | web | unset | `1` reads events straight from a daemon on this machine |
| `VITE_BRIDGE_URL` | web | `ws://<page host>:4747/ws` | Where local mode connects |

The daemon's variables all carry the product's name on purpose: it runs
inside other projects' shells and under launchers, which set `PORT`, `HOST`
or `SUPABASE_URL` for their own reasons. It reads no `.env` file either.

The daemon only listens on loopback by default, only answers requests
addressed to this computer, and only accepts browser connections from
`localhost` pages (hook `curl` calls send no `Origin` and are always
accepted). That's because events include file names and commands.

## Troubleshooting

- **No astronauts for your sessions**: `agentnauts status` says whether the
  daemon is running, which rooms this computer publishes to and whether the
  hooks are installed. The computer should also be listed under **Your
  computers** in the HUD. A page opened after a session started shows it
  within 20 seconds.
- **The daemon says "not published"**: the computer was disconnected in the
  app, or its clock is more than two minutes off. (Events travel encoded
  because Supabase's gateway refuses requests whose text looks like an attack,
  which shell commands and SQL often do; see `signRoomContent` in
  `server/src/room.ts`.)
- **Events arrive but nothing moves**: run the daemon with `--verbose` and
  check its log. Unknown payloads are logged with a preview.
- **Subagent work shows up on the main astronaut**: older Claude Code versions
  don't include `agent_id` in hook payloads, so subagent tool calls can't be
  told apart. Update Claude Code.
