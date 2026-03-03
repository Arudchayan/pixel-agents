# Pixel Agents

A VS Code extension that turns your coding agents into animated pixel art characters in a virtual office.

Each runtime session you connect (Claude Code or OpenCode) spawns a character that walks around, sits at desks, and visually reflects what the agent is doing - typing when writing code, reading when searching files, waiting when it needs your attention.

This is the source code for the free [Pixel Agents extension for VS Code](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) — you can install it directly from the marketplace with the full furniture catalog included.


![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **Multi-runtime support** — run with Claude Code or OpenCode
- **One agent, one character** — every connected runtime session gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **System-wide session adoption** — when the panel opens, recent running sessions are discovered and adopted automatically (including external sessions started outside VS Code)
- **Runtime indicator** — top-left summary shows active Claude/OpenCode session counts (and external count)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — Task tool sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters. These are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.109.0 or later
- At least one supported runtime installed:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
  - [OpenCode](https://github.com/sst/opencode)

## Getting Started

If you just want to use Pixel Agents, the easiest way is to download the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). If you want to play with the code, develop, or contribute, then:

### Install from source

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Pixel Agents** panel (bottom panel area alongside Terminal/Output/Problems)
2. Open **Settings** in Pixel Agents and choose **Agent Runtime** (Claude or OpenCode)
3. Click **+ Agent** to spawn a terminal session for that runtime
4. Start coding - watch the character react in real time
5. Click a character to select it, then click a seat to reassign it
6. Click **Layout** to open the office editor and customize your space

### Runtime behavior and indicators

- Top-left runtime summary shows:
  - `Claude: <count>`
  - `OpenCode: <count>`
  - `External: <count>` when externally started sessions are adopted
- Character labels include runtime context (for example `Claude`, `OpenCode`, `OpenCode (external)`).
- Runtime selection is persisted and restored across reloads.

## Runtime Integration (Detailed)

Pixel Agents now supports two ingestion paths and normalizes both into one visual protocol for the webview.

### Claude runtime

- New Claude agents launched from Pixel Agents use `claude --session-id <uuid>`.
- Transcript ingestion is file-based via JSONL files under `~/.claude/projects/<project-hash>/`.
- Existing Claude sessions can also be auto-adopted when the panel opens if they were recently active.

### OpenCode runtime

- New OpenCode agents launched from Pixel Agents start an `opencode` terminal session.
- Session ingestion is export-based:
  - `opencode session list --format json`
  - `opencode export <sessionId>`
- Tool events are normalized into existing UI messages (`agentToolStart`, `agentToolDone`, `agentStatus`, sub-agent lifecycle events).

### External session adoption

When the Pixel Agents panel opens, the extension discovers and adopts recent sessions created outside this extension.

- Discovery interval: every 5 seconds
- Recency window: last 10 minutes
- Adopted external sessions appear as characters and update live
- External sessions may not have a VS Code terminal to focus, but they can still be visualized and closed from the panel

### Sub-agent visibility

Background sub-tasks are visualized as sub-agent characters, including OpenCode task-based subagent lifecycle events (`subagentToolStart`, `subagentToolDone`, `subagentClear`).

## Local Frontend (Standalone)

You can run the web frontend directly for UI iteration:

```bash
cd webview-ui
npm run dev
```

Notes:

- Standalone mode no longer includes mock agent/session simulation.
- Real agent/session discovery requires running inside the VS Code extension host.

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project and available via the extension is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. The tileset is not included in this repository due to its license. To use Pixel Agents locally with the full set of office furniture and decorations, purchase the tileset and run the asset import pipeline:

```bash
npm run import-tileset
```

Fair warning: the import pipeline is not exactly straightforward — the out-of-the-box tileset assets aren't the easiest to work with, and while I've done my best to make the process as smooth as possible, it may require some manual tweaking. If you have experience creating pixel art office assets and would like to contribute freely usable tilesets for the community, that would be hugely appreciated.

The extension will still work without the tileset — you'll get the default characters and basic layout, but the full furniture catalog requires the imported assets.

## How It Works

Pixel Agents ingests runtime activity and normalizes it into a shared UI protocol.

- Claude path: JSONL transcript watching
- OpenCode path: session list/export polling

When an agent uses tools (read/write/grep/bash/task/etc.), the extension maps those events into character animations and status overlays in real time.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync** — the way agents are connected to Claude Code terminal instances is not super robust and sometimes desyncs, especially when terminals are rapidly opened/closed or restored across sessions.
- **Heuristic-based status detection** — Claude Code's JSONL transcript format does not provide clear signals for when an agent is waiting for user input or when it has finished its turn. The current detection is based on heuristics (idle timers, turn-duration events) and often misfires — agents may briefly show the wrong status or miss transitions.
- **Windows-only testing** — the extension has only been tested on Windows 11. It may work on macOS or Linux, but there could be unexpected issues with file watching, paths, or terminal behavior on those platforms.

## Roadmap

There are several areas where contributions would be very welcome:

- **Improve agent-terminal reliability** — more robust connection and sync between characters and Claude Code instances
- **Better status detection** — find or propose clearer signals for agent state transitions (waiting, done, permission needed)
- **Community assets** — freely usable pixel art tilesets or characters that anyone can use without purchasing third-party assets
- **Agent creation and definition** — define agents with custom skills, system prompts, names, and skins before launching them
- **Desks as directories** — click on a desk to select a working directory, drag and drop agents or click-to-assign to move them to specific desks/projects
- **Claude Code agent teams** — native support for [agent teams](https://code.claude.com/docs/en/agent-teams), visualizing multi-agent coordination and communication
- **Git worktree support** — agents working in different worktrees to avoid conflict from parallel work on the same files
- **Additional runtime integrations** — beyond Claude/OpenCode, support more agentic frameworks or local orchestrators

If any of these interest you, feel free to open an issue or submit a PR.

## Contributions

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for instructions on how to contribute to this project.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

If you find Pixel Agents useful, consider supporting its development:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## License

This project is licensed under the [MIT License](LICENSE).
