# groundcrew

A cartoon 3D visualizer for AI coding agents. Every Claude Code session becomes a
little astronaut working on a floating chunk of alien planet: it walks to the
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

**Optional extra hooks.** The bridge also understands `SubagentStart` (crew
drop in as soon as a subagent launches rather than on its first tool call),
`SessionEnd` (the commander flies home when you quit) and `UserPromptSubmit`
(shows "Thinking…"). Add them with the same command if you like. Sessions that
go quiet for 30 minutes fly home on their own.

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
| no events for ~8 s                           | wanders around the chunk, pauses, looks around                  |
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

- *Multiplayer*: the store holds only plain data (ids, states, station names,
  `[x, y, z]` positions) so it can be synced later. A Supabase Realtime feed
  becomes another `AgentEventSource`; the scene doesn't change.
- *Art pass*: the astronaut is driven entirely by an `AstronautPose` ref
  (`idle` / `walk` / `work` / `wait` / `fly`, speed, station). A GLTF model
  just maps those modes to animation clips. Stations are separate components
  that receive an `activity` ref (0..1).

## Configuration

| Variable           | Where  | Default               | Purpose                                                   |
| ------------------ | ------ | --------------------- | --------------------------------------------------------- |
| `PORT`             | server | `4747`                | Bridge port (update the hook URL and `VITE_BRIDGE_URL` too) |
| `HOST`             | server | `127.0.0.1`           | Bind address. Use `0.0.0.0` to open it to your LAN        |
| `ALLOWED_ORIGINS`  | server | localhost pages only  | Extra browser origins allowed to connect, comma separated |
| `GROUNDCREW_QUIET` | server | unset                 | `1` silences per-event logging                            |
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
