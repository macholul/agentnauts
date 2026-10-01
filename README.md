# groundcrew

A cartoon 3D visualizer for AI coding agents. Every Claude Code session becomes a
little astronaut working on a base on an alien planet, seen from above: it walks to the
**fabricator** to edit files, the **scanner** to read and search, the **drill**
to run shell commands and the **radar dish** to search the web. When the agent
needs you, its astronaut waits on the landing pad with a big **!** over its head.
Subagents drop in as smaller crew astronauts and fly off when they're done.

Inspired by Pixel Agents, but in 3D, with a soft pastel, Astroneer-like toy
style (all art is original, built from primitives).

![groundcrew screenshot](docs/screenshot.jpg)

## Quick start

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev          # event bridge on :4747 + web app on :5173
```

Open <http://localhost:5173>. In dev the **simulator** is on, so two fake
agents start working right away. Toggle it in the HUD (top left); the choice is
remembered. Production builds (`npm start`, served on :4173) start with it off.

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm run dev`       | Event bridge (`tsx watch`) and Vite dev server together             |
| `npm run web`       | Only the web app                                                    |
| `npm run server`    | Only the event bridge                                               |
| `npm run typecheck` | Strict TypeScript check of all workspaces                           |
| `npm test`          | Unit tests (event→intent mapping, hook normalization, origin check) |
| `npm run build`     | Typecheck, then build `web/dist` and `server/dist`                  |
| `npm start`         | Build, then run the bundled bridge and `vite preview`               |

## Connecting Claude Code

1. Start the bridge (`npm run dev` or `npm run server`). It listens on port 4747.
2. Add these hooks to `.claude/settings.json` in your project, or to
   `~/.claude/settings.json` to watch every project. (The same file is in
   [`docs/claude-settings.example.json`](docs/claude-settings.example.json).)
   If the file already has a `hooks` section, merge these entries into it.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST -H 'Content-Type: application/json' -d @- http://localhost:4747/event || true"
          }
        ]
      }
    ]
  }
}
```

3. Start (or restart) Claude Code. Its astronaut lands on the pad and gets to
   work. The HUD shows **Claude Code: connected** and counts incoming events.

Each hook pipes the hook's JSON (stdin) to the bridge. `|| true` means a stopped
bridge never breaks Claude Code: curl fails fast with "connection refused" and
the hook still exits 0. The bridge replies with an empty body, so nothing ends
up on the hook's stdout.

`SessionEnd` makes the commander fly home when you quit, `SubagentStart` drops
crew in as soon as a subagent launches, and `UserPromptSubmit` shows
"Thinking…". Sessions that go quiet for 30 minutes fly home on their own.

### Try it without Claude Code

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"session_id":"demo","cwd":"/tmp/my-project","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}' \
  http://localhost:4747/event
```

## What the astronauts do

| Event                                        | Astronaut                                                       |
| -------------------------------------------- | --------------------------------------------------------------- |
| `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | walks to the **fabricator** (orange) and works                  |
| `Read`, `Grep`, `Glob`, `LS`                 | **scanner** (teal)                                              |
| `Bash`                                       | **drill** (yellow)                                              |
| `WebSearch`, `WebFetch`                      | **radar dish** (pink)                                           |
| `Notification` (permission / input needed)   | goes to the **landing pad**, shows a floating **!**             |
| `Stop`, unknown tools (MCP, `Task`, …)       | idle                                                            |
| no events for ~8 s                           | wanders around the base, pauses, looks around                   |
| tool call inside a subagent (`agent_id`)     | a smaller **crew** astronaut drops in and does it               |
| `SubagentStop`                               | that crew astronaut jetpacks away                               |

Stations react while someone works at them: glowing ground ring, faster
machinery, sparks, data bits or dust.

## Architecture

```
Claude Code hooks ──curl POST /event──▶ server/ (event bridge, :4747)
                                          │ normalize.ts: hook JSON → AgentEvent
                                          ▼
                                   WebSocket /ws (broadcast)
                                          │
web/  ┌───────────────────────────────────▼───────────────────────────────┐
      │ sources/   BridgeSource · SimulatorSource · (future: Supabase…)   │
      │            all implement AgentEventSource; attachSource() is the  │
      │            only glue to the store                                 │
      │                       │ AgentEvent                                │
      │ store/     applyEvent → mapEventToIntent (shared, pure)           │
      │            zustand map of agents: plain serializable data only    │
      │                       │ getState() in useFrame                    │
      │ scene/     AgentActor (pathing, turning, lifecycle flights)       │
      │              └─ Astronaut (visual, driven by a pose ref)          │
      │            stations react via useStationActivity refs             │
      │ hud/       status, simulator toggle, agent list                   │
      └───────────────────────────────────────────────────────────────────┘
```

**Workspaces**

- `shared/`: `AgentEvent` (normalized event), `Intent`, the pure
  `mapEventToIntent` function, and the WebSocket message protocol.
- `server/`: plain `node:http` + `ws`. `POST /event`, `GET /health`, `WS /ws`.
  Unknown or malformed payloads are logged and ignored, never fatal.
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

- *Multiplayer*: private rooms are just another `AgentEventSource` (`sources/room.ts`);
  the scene doesn't know events are remote. The store holds only plain data,
  so it stays easy to sync.
- *Art pass*: the astronaut is driven entirely by an `AstronautPose` ref
  (`idle` / `walk` / `work` / `wait` / `fly`, speed, station). A GLTF model
  just maps those modes to animation clips. Stations are separate components
  that receive an `activity` ref (0..1).

## Multiplayer (private rooms)

Share a room with teammates and everyone's astronauts work on the same base.
Rooms are private: you sign in, and the room's owner decides who gets in.

```
your Claude Code ──hooks──▶ your bridge ──▶ your browser (local, as before)
                                 │
                                 └──signed events──▶ private room ──▶ members' browsers
```

**Using it** (Multiplayer panel in the HUD):

1. **Sign in** with your email: click the link Supabase emails you (no password).
2. **Create a room**, or **ask to join** one with its code / invite link.
3. The owner sees your request (name + email) and clicks **Let in** or
   **Deny**. Owners can remove people and delete the room later.
4. Once you're in, your browser tells your local bridge to share your agents
   there. Other people's astronauts show up labelled `name · project`.

**How it's hosted:** one [Supabase](https://supabase.com) project serves
everyone using this build: sign-in, the room/member tables, and Realtime
private channels (events are relayed, never stored). **One-time setup for the
maintainer only:**

1. Create a free Supabase project and paste its project URL and anon
   (publishable) key into [`shared/src/cloud.ts`](shared/src/cloud.ts)
   (Project Settings → API). The anon key is meant to be public.
2. Run [`supabase/migrations/20260928000000_private_rooms.sql`](supabase/migrations/20260928000000_private_rooms.sql)
   in the SQL editor. It creates the tables, the access rules and the
   join/approve functions.
3. Authentication → Sign In / Providers: keep **Email** enabled. In
   Authentication → URL Configuration, set the Site URL to where people open
   the app (e.g. `http://localhost:5173`) and add it under Redirect URLs, so
   the sign-in link in the email brings people back to it. The built-in email
   sender is rate-limited (a few emails per hour); for bigger teams add your
   own SMTP. With SMTP set up you can also add `{{ .Token }}` to the Magic
   Link template, and the app accepts the code from the email as well.
4. Realtime → Settings: turn **off** "Allow public access", so only signed-in
   members can use channels at all.

The access rules are tested against a real Postgres in `server/src/db.test.ts`
(run with `npm test`).

**Privacy and identity.**

- *Only people the owner lets in* can see or post anything in a room. That's
  enforced by the database (row level security on Realtime channels), not by
  the app. Knowing a room code only lets you *ask*. Email addresses are shown
  to the room owner only.
- *Nothing is shared until you choose to*, and a "Sharing live" badge stays
  at the top of the screen while you are. **Stop sharing** keeps you watching.
- *Sharing never resumes on its own.* The bridge remembers your room, but after
  a restart it waits until you click **Resume sharing** in the app.
- *Your bridge never gets your login.* The app hands it a short-lived access
  token (kept in memory, refreshed while the app is open). If the app stays
  closed for about an hour, sharing pauses until you open it again.
- *Minimal by default.* Only tool names and states are sent (e.g. "Edit",
  "waiting"). Project folder names become "project 1", "project 2"; file
  names, commands and search queries are dropped. Tick **Also share project
  names, files & commands** to include them. Code, prompts and Claude's replies
  are never sent.
- *Nobody can pose as you.* Each bridge creates an Ed25519 key pair once
  (`~/.groundcrew/identity.json`, readable only by you) and signs every event;
  browsers drop anything with a bad signature, and signed messages can't be
  replayed into another room. Your short ID (e.g. `✓ a3f9-c21e`) is shown in
  the panel so teammates can recognise the real you.

## Configuration

| Variable           | Where  | Default               | Purpose                                                   |
| ------------------ | ------ | --------------------- | --------------------------------------------------------- |
| `PORT`             | server | `4747`                | Bridge port (update the hook URL and `VITE_BRIDGE_URL` too) |
| `HOST`             | server | `127.0.0.1`           | Bind address. Use `0.0.0.0` to open it to your LAN        |
| `ALLOWED_ORIGINS`  | server | localhost pages only  | Extra browser origins allowed to connect, comma separated |
| `GROUNDCREW_QUIET` | server | unset                 | `1` silences per-event logging                            |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | server | `shared/src/cloud.ts` | Use a different Supabase project |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | web | `shared/src/cloud.ts` | Use a different Supabase project |
| `VITE_BRIDGE_URL`  | web    | `ws://<page host>:4747/ws` | Where the browser connects                           |

The bridge only listens on loopback by default, and only accepts browser
connections from `localhost` pages (hook `curl` calls send no `Origin` and are
always accepted). That's because events include file names and commands.

## Troubleshooting

- **HUD says "offline"**: the bridge isn't running or is on another port. Run
  `npm run server` and check `curl http://localhost:4747/health`.
- **Events arrive but nothing moves**: check the bridge log. Unknown payloads
  are logged with a preview.
- **Subagent work shows up on the main astronaut**: older Claude Code versions
  don't include `agent_id` in hook payloads, so subagent tool calls can't be
  told apart. Update Claude Code.
- **Opening the app from another device**: start the bridge with
  `HOST=0.0.0.0 ALLOWED_ORIGINS=http://<your-ip>:5173 npm run server` and the
  web app with `npm run dev -w web -- --host`.
