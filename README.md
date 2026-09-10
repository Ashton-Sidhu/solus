<p align="center">
  <img src="resources/banner.svg" alt="Solus — the best Agentic Editor for building software" width="100%" />
</p>

<p align="center">
  <b>Plan, review, and ship work with Claude Code or Codex — from your desktop, browser, or phone.</b><br />
  A keyboard-first agentic editor that floats above whatever you're doing. No terminal tab required.
</p>

<p align="center">
  <a href="https://github.com/Ashton-Sidhu/solus/releases"><img src="https://img.shields.io/github/v/release/Ashton-Sidhu/solus?label=release&color=blue" alt="release" /></a>
  <a href="https://solus.sh"><img src="https://img.shields.io/badge/download-macOS%20(Apple%20Silicon)-black?logo=apple&logoColor=white" alt="download for macOS" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue" alt="license" /></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome" /></a>
</p>

<p align="center">
  <a href="https://solus.sh">Website</a> ·
  <a href="https://solus.sh/docs">Docs</a> ·
  <a href="#install">Install</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#headless-server">Server</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

---

## Why Solus

Coding agents live in the terminal, and the terminal is a bad place to supervise them. You lose the thread when you switch windows, plans and diffs scroll away, and running two agents at once means juggling panes.

Solus puts agents in a glass overlay that floats above whatever you're doing. Sessions are tabs, plans are reviewable documents, diffs are commentable, and everything has a keybinding. Summon it with `⌥Space`, dismiss it when you're back in flow.

Two layouts, one keystroke apart (`⌥⇧E`): **pill mode** is a compact strip for firing off prompts while you work elsewhere; **editor mode** is a full workspace for reading plans, reviewing diffs, and driving a session with full attention.

## Features

A typical loop: summon Solus, describe the change, review the plan it drafts, watch the diff as it works, send line-level feedback, then commit and merge — without leaving the panel. The features below follow that loop in order, and each links to its section in the [docs](https://solus.sh/docs).

| | |
|---|---|
| [**Sessions & tabs**](https://solus.sh/docs#sessions) | Every tab is an independent session with its own project, agent, model, and permission mode. Fork a conversation to explore two approaches, resume any past session, queue messages while the agent is busy, or isolate risky work on a git worktree. |
| [**Plans**](https://solus.sh/docs#plans) | In Plan mode the agent drafts before it executes. Mark the plan up like a PR — inline comments on any selection — then approve into Ask or Auto mode. Plans are saved to disk with revision history, and work with every model, not just those with native plan support. |
| [**Workspace panes**](https://solus.sh/docs#panes) | Plans, Works, automations, reviews, and diffs open as focused panes or beside the live conversation. Closing a pane restores the chat with scroll position and drafts intact. |
| [**Diff panel**](https://solus.sh/docs#diff) | Every file the agent touched, in a side panel. Step through files, filter by conversation turn, leave line-level comments, and send them back as one structured message. |
| [**Opening changed files**](https://solus.sh/docs#files) | Jump from any inline diff preview straight into VS Code, Cursor, Zed, Sublime Text, a JetBrains IDE, or a terminal editor like Vim, Neovim, Helix, or Emacs — or open every file changed in the session at once. |
| [**Review companion**](https://solus.sh/docs#review) | A second agent reviews your branch — commits, uncommitted edits, and untracked files — and writes a report of grouped findings. Click a finding to land on that exact hunk. |
| [**Pull requests**](https://solus.sh/docs#pull-request-merge) | One action branches, commits, pushes, and opens the PR — commit message, branch name, title, and description written from the change itself. Then merge, squash, or rebase from its review surface, with status, checks, required approvals, and unresolved conversations in view; open a single commit's changes from the Activity timeline. The status card names the first blocker and offers the one action that clears it: conflicted PRs are handed to an agent in an isolated worktree, and failing checks or an out-of-date branch open a drafted agent session for the branch. |
| [**Works**](https://solus.sh/docs#works) | Docs, slides, and diagrams the agent produces are extracted from the chat and saved as standalone artifacts you can search, edit, and export — they outlive the session that made them. |
| [**Document editor**](https://solus.sh/docs#document-editor) | Native Markdown editing with a selection toolbar, slash commands for block types, and bidirectional raw-Markdown sync. |
| [**Design mode**](https://solus.sh/docs#design-mode) | Screenshot any window, annotate it with rectangles, arrows, numbered pins, and text, and send the composited image to the agent. |
| [**Voice input**](https://solus.sh/docs#voice) | Push-to-talk or a continuous hands-free loop, both transcribed locally on your device — audio never leaves your machine. |
| [**Automations**](https://solus.sh/docs#automations) | Save a prompt and run it on a schedule — interval, daily, weekly, monthly, or raw cron — or on demand. Every run keeps a history you can open as a full session. Agents can create automations for you. |
| [**Rate limit queueing**](https://solus.sh/docs#rate-limits) | Hit a limit mid-task and Solus asks, queues and re-sends, continues, or stops — globally or per tab. |
| [**Hosts & connections**](https://solus.sh/docs#connections) | The desktop app doubles as a server: pair your phone or another browser, add other machines as hosts, and choose where each session runs. |
| [**Tasks**](https://solus.sh/docs#tasks) | A project-scoped board of local tickets and GitHub Issues, with sessions started straight from a task. |

## Install

**Homebrew** — recommended, and it keeps itself current:

```bash
brew install --cask Ashton-Sidhu/tap/solus          # macOS desktop app
```

**Direct download** — a signed and notarized `.dmg` from [solus.sh](https://solus.sh), or from the [releases page](https://github.com/Ashton-Sidhu/solus/releases). Drag `Solus.app` to `/Applications`. The app updates itself in place from there.

Then press `⌥Space` to summon the window (`⌘⇧K` if that's taken), pick a project with `⌘O`, and start typing.

### Requirements

| | |
|---|---|
| OS | macOS 12 Monterey or later, Apple Silicon |
| Agent | [Claude Code](https://github.com/anthropics/claude-code) CLI, installed and authenticated |
| Optional | [Codex](https://github.com/openai/codex) CLI, for Codex sessions |

Solus drives the agent CLIs you already have installed and auto-detects which are available — it doesn't ship its own agent or ask for an API key.

## Keyboard shortcuts

Global shortcuts use `⌥⇧`, sub-page shortcuts use `⌥`. These are the ones worth learning first — the full reference lives in the [keybindings docs](https://solus.sh/docs#keybindings), or press `⌥⇧/` in the app.

| Shortcut | Action |
|---|---|
| `⌥Space` | Toggle the window (system-wide) |
| `⌥L` | Focus input |
| `⌘O` | Open a project on the current host |
| `⌘⇧O` | Open or clone a project on any host |
| `⌘T` | New tab |
| `⌥⇧E` | Toggle editor / pill mode |
| `⌥⇧Tab` | Cycle permission mode (Ask → Auto → Plan) |
| `⌥⇧D` | Toggle diff panel |
| `⌥⇧B` | Toggle worktree mode |

## Headless server

Run Solus on Linux x64/arm64 or an Apple Silicon Mac. The server includes Node,
the CLI, and the web client. Homebrew and a separate Node installation are not required.

Download `install.sh` from a [server release](https://github.com/Ashton-Sidhu/solus/releases)
that includes the installer, then run:

```sh
sh install.sh
export PATH="$HOME/.local/bin:$PATH"
solus setup
solus pair
```

`solus setup` installs and starts a user service. On Linux it uses systemd and
checks lingering so the server can run after logout and at boot. If permission
is needed, it prints the command to enable lingering. On macOS it uses a
LaunchAgent: keep the Mac logged in and awake for remote access.

`solus pair` prints a temporary link, code, and QR for desktop, web, or mobile.
Use `solus connect` instead to link the running host to Solus Cloud.

| Command | Purpose |
|---|---|
| `solus setup` | Install/start the background service and check health |
| `solus start` | Run in the foreground (`--host`, `--port`, `--data-dir`) |
| `solus status` | Show installed/running versions, service state, and provider versions |
| `solus service start`, `stop`, `restart` | Control the background service |
| `solus service uninstall` | Remove background startup; keep user data |
| `solus logs` | Follow the server log (`--lines N`) |
| `solus pair` | Create another temporary client pairing link |
| `solus connect`, `connect status`, `connect unlink` | Manage the Solus Cloud link |
| `solus update` | Check and update the running host through its shared update service |

Versions live under `~/.local/share/solus/versions`; `current` selects the active
version. The launcher lives at `~/.local/bin/solus`. Set `SOLUS_RUNTIME_DIR` and
`SOLUS_BIN_DIR` before installation to change these paths. Data lives in
`~/.solus`; use `--data-dir` or `SOLUS_DATA_DIR` consistently for another data
location. The data and runtime directories must be separate. Setup saves its
data path and `SOLUS_HOST`/`SOLUS_PORT` values in the service configuration.
The default port is 3000.

Update from any connected client's **Update Solus** action or run `solus update`
on the host. Both download and verify the release, wait for accepted work to
finish, then restart. You can cancel while waiting. The updater backs up the
host data after shutdown and restores it with the previous version if the new
server cannot start. Requests remain blocked during candidate verification.
Checks are automatic; installation requires an action. Project files and
provider-owned data outside the Solus data directory are not part of rollback.
The CLI can time out while the host is still waiting; `solus status` shows its state.

For startup failures, use `solus logs`. Linux also records process output in
`journalctl --user -u solus.service`; macOS records it in the data directory's
`logs/solus.log`. Run `solus setup` to restore a missing service definition.
Keep older version directories until the running supervisor has stopped.

The desktop app can also host Solus and uses its own desktop updater.

To build a server release from this checkout:

```sh
bun run build
bun scripts/package-server.ts --platform linux --arch x64
SOLUS_VERSION=<package-version> \
SOLUS_INSTALL_ARCHIVE="$PWD/release/solus-server-linux-x64.tar.gz" \
SOLUS_INSTALL_SHA256SUMS="$PWD/release/SHA256SUMS" sh scripts/install.sh
```

The release workflow attaches the installer to new server releases. These
source changes do not publish or replace an existing release.

## Build from source

You'll additionally need [Bun](https://bun.sh) and the Xcode Command Line Tools.

```bash
git clone https://github.com/Ashton-Sidhu/solus.git
cd solus
bun install
bun run dev      # development
```

```bash
bun run build    # verify the app + web client compile
bun run dist     # produces a Solus.app bundle in dist/
```

`.env` is optional — copy `.env.example` if you're testing analytics, Google integration, or release signing. Leave those values empty otherwise.

## How it works

```
renderer  →  window.solus.<method>()      (src/preload — wraps as an RPC envelope)
          →  SolusServer.handle()         (src/main/server)
          →  handler in server/handlers/  (one file per domain)
          →  ControlPlane / managers      (src/main/control-plane.ts)
events    ←  broadcast back over RPC topics
```

| Path | Owns |
|---|---|
| `src/main/` | Electron main process — sessions, agents, git, RPC server |
| `src/main/agents/` | Agent backends (`claude/`, `codex/`) and the backend registry |
| `src/renderer/` | Svelte 5 UI — one folder per feature, stores in `contexts/` |
| `src/shared/` | RPC method and topic definitions shared by both sides |
| `client/` | Web client served by the headless server |
| `docs/adr/` | Architecture decision records |

Built with **Electron** + **electron-vite**, **Svelte 5**, **TypeScript**, **Tailwind CSS v4**, and the **@anthropic-ai/claude-agent-sdk**.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, code style, and PR expectations; [CLAUDE.md](./CLAUDE.md) documents the conventions agents (and humans) should follow in this repo. Please also read the [Code of Conduct](./CODE_OF_CONDUCT.md).

Found a security issue? See [SECURITY.md](./SECURITY.md) — please don't open a public issue.

## License

[Business Source License 1.1](./LICENSE) — free for personal and internal use; converts to Apache 2.0 on 2030-07-14. You may not resell Solus or offer it as a competing hosted service before then.
