# agentnauts

Watch your Claude Code agents as little astronauts working on a tiny planet.
Every session becomes an astronaut that walks to a station for what the agent
is doing: editing files, reading and searching, running commands, using the
web. When an agent needs you, its astronaut waits on the landing pad.

This package is the part that runs on your computer. It takes events from
Claude Code's hooks and sends them to the agentnauts app, where you (and
teammates you share a room with) watch.

## Use it

```bash
npx agentnauts
```

The first time, this:

1. adds hooks to Claude Code's settings (`~/.claude/settings.json`), next to
   whatever is already there;
2. opens the app (<https://agentnauts.vercel.app>) in your browser, where
   you sign in and connect this computer (check that the page shows the same
   ID as the terminal);
3. keeps running and sends your agents to the app. `Ctrl+C` stops it.

Claude Code sessions you start after that show up in the app.

## Commands

| Command | What it does |
| --- | --- |
| `agentnauts` | Set up the hooks, connect this computer if needed, and run |
| `agentnauts connect` | Connect this computer to your account |
| `agentnauts disconnect` | Stop this computer sending anything to your account |
| `agentnauts status` | What is running, connected and installed |
| `agentnauts hooks install` | Add the Claude Code hooks (start does this too) |
| `agentnauts hooks uninstall` | Remove them; your other hooks and settings stay |
| `agentnauts uninstall` | Disconnect, remove the hooks and this computer's key |

Options for `agentnauts`: `--no-hooks` (leave Claude Code's settings alone),
`--no-open` (don't open the browser), `--verbose` (print every event).

`AGENTNAUTS_PORT` changes the port the hooks talk to on your computer
(default 4747).

## What leaves your computer

- Your own room in the app (only you can watch it) gets tool names, project
  folder names, file names and commands.
- A room you share with others gets only tool names and states ("Edit",
  "waiting"), unless you choose to share details there.
- Code, prompts and Claude's replies are never sent. Nothing is stored:
  events are relayed to the open pages and gone.

The daemon never holds your account's sign-in. This computer has its own key
(`~/.agentnauts/identity.json`) that can do one thing: send events to the
rooms you connected it to. Disconnecting it, in the app or with
`agentnauts disconnect`, cuts it off at once.

## Requirements

Node.js 20.19 or newer, and `curl` (the hooks use it; it ships with macOS,
most Linux systems, and Git for Windows).

Source, issues and how it works: <https://github.com/macholul/agentnauts>
