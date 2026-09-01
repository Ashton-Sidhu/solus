# Solus — Operating Manual

Solus is a keyboard-first interface for coding agents across mobile, desktop, and web.
The clients share a Node server that wraps agent runtimes, manages sessions and
worktrees, and exposes the same typed RPC surface over local IPC and WebSockets.

Think of Solus as the place where a user coordinates agent work without leaving their
flow: conversations, diffs, plans, tasks, pull requests, automations, and durable works
all live in one focused workspace.

> **Before any codebase-wide search (Grep/Glob/Agent over the whole repo), read the
> Codebase Map below.** The map tells you which files to open. Search only after it
> points you to a region; never sweep the repository blind.

Always talk in ASD-STE100 Simplified Technical English.
---

## What makes Solus special?

These are product constraints, not marketing copy. Preserve them as Solus evolves.

### 1. Flow first

Solus should disappear into the user's working rhythm. The interface is keyboard-first,
fast to summon, and designed to keep the active prompt close at hand. A feature that is
powerful but interrupts typing, steals focus, or makes routine actions feel ceremonial is
not finished.

After a user clicks or completes an action, refocus the active input bar whenever the
next natural step is typing.

### 2. Performance without compromise

Solus keeps many tabs and rich surfaces mounted at once: long transcripts, live diffs,
editors, diagrams, plans, and provider activity. Small reactive mistakes multiply quickly.

Treat renderer invalidation, transcript parsing, IPC payload size, WebSocket traffic,
filesystem watchers, and continuous animation as performance-sensitive. Avoid rebuilding
large state graphs for tiny updates. Do not add continuously repainting decoration. A
dropped frame, delayed keystroke, or tab switch that gets slower over time is a product bug.

### 3. Local by default, remote ready

The desktop app can host Solus locally; the standalone server can run on another machine;
and the web client can connect over the network. Remote operation is a core architecture
constraint, not a later transport concern.

Do not assume the renderer and server share a process, filesystem view, origin, or host.
Anything that crosses that boundary belongs in the RPC contract and must behave over both
Electron IPC and WebSockets. Never bake a development origin or local path into client
behavior.

A path from a client is not a real path. The renderer sends `~` when it does not know the
working directory yet, and `spawn` reads that as a directory with that name. Resolve every
agent working directory with `resolveHomePath` before it reaches a process;
`solus/require-resolved-cwd` rejects the ones that are not resolved.

A path from a client is not a real path. The renderer sends `~` when it does not know the
working directory yet, and `spawn` reads that as a directory with that name. Resolve every
agent working directory with `resolveHomePath` before it reaches a process;
`solus/require-resolved-cwd` rejects the ones that are not resolved.

### 4. Multi-surface

Solus has three primary client surfaces:

- **Desktop** — the macOS Electron app, including native window behavior, tray and global
  shortcuts, local IPC, and the ability to host the server.
- **Web** — the standalone client in `apps/client/`, served by the headless Solus server and
  connected through WebSockets.
- **Mobile** — the iOS and Android client for controlling agent work remotely from a
  phone or tablet.

Every user-interface change must be implemented and verified across mobile, desktop, and
web. The clients may use surface-appropriate interaction and navigation patterns, but
they must expose the same product capability and state. A platform-specific exception
requires an explicit product decision; it must not happen merely because one client was
easier to update. Native shell behavior may remain platform-specific, but durable domain
behavior generally may not be.

### 5. Multi-agent, one coherent workspace

Claude Code and Codex have different protocols, events, permissions, and lifecycle
semantics. Solus should normalize those differences at the agent boundary so the rest of
the product remains coherent. Provider-specific behavior must be intentional and visible,
never an accidental leak into generic UI.

Sessions, tabs, worktrees, tasks, plans, reviews, automations, and works are related but
distinct concepts. Keep their ownership clear. Do not turn the central control plane into
the default home for logic that belongs to a focused manager or feature.

## A note on taste

Favor ambitious outcomes and simple systems. Do not preserve complexity because it
already exists, and do not introduce machinery because it looks architecturally
impressive. Understand the real constraint, then implement the smallest model that makes
correct behavior unsurprising.

Channel both “measure twice, cut once” and YAGNI:

- State assumptions before coding.
- Ask instead of guessing when a product or ownership decision is ambiguous.
- Push back when a smaller solution meets the actual need.
- Fight scope creep and avoid speculative abstractions.
- Honor the developer's intent in a minimal, realistic way.
- If a rule here conflicts with the task, surface the conflict and get human sign-off
  before breaking the rule.

Most Solus development happens from inside Solus. Be careful with processes, local data,
active sessions, worktrees, and dev servers: the instance you damage may be the one the
developer is using to direct you.

## A small glossary

Use these terms consistently in code, plans, and conversation:

- **you** — the agent reading this file and changing Solus.
- **we, us, and maintainers** — the people building Solus and talking to you now.
- **user** — the person using Solus to direct coding agents.
- **agent** — a coding agent running inside Solus, currently Claude Code or Codex.
- **provider** or **agent backend** — the runtime and adapter through which Solus runs an
  agent.
- **client** — the mobile, desktop, or web UI.
- **host** — the machine and Solus server a client connects to.
- **project** — a workspace rooted at a directory on a host.
- **session** — the durable provider conversation and work history for a project.
- **tab** — the mounted UI state through which a user interacts with a session.
- **turn** — one user-to-agent cycle and its emitted events.
- **worktree** — a git worktree used to isolate a branch and agent work.
- **work** — a durable document, slide deck, or diagram managed by Folio.
- **pane** — a content region in the workspace; use the canonical pane/slot terminology
  from the pane model rather than inventing “viewer,” “split,” or “secondary” synonyms.
- **Editor mode** — the focused, full-workspace interface.
- **Pill mode** — the lightweight, summon-as-needed interface.

## Rules — non-negotiable

1. **Think before coding.** State assumptions. Ask, don't guess. Push back when a simpler
   path exists. Stop when confused.
2. **Simplicity first.** Write the minimum code that solves the task. Nothing speculative.
   No abstraction for a single use.
3. **Surgical changes.** Touch only what the task needs. Do not refactor, improve, or
   restyle adjacent code. Match the existing style.
4. **Surface conflicts; don't average them.** If two patterns contradict, choose one
   based on recency, ownership, and tests; explain why and flag the other. Never blend
   incompatible patterns.
5. **Read before writing.** Read exports, immediate callers, shared types, and relevant
   utilities first. If you do not know why code is shaped a certain way, ask.
6. **Tests verify intent.** A test must encode why behavior matters. If it cannot fail
   when the relevant business rule changes, it is the wrong test.
7. **No pass-through wrappers.** Inline a function that only forwards arguments. A wrapper
   must earn its existence through validation, defaults, error handling, memoization, or a
   meaningfully narrower interface.
8. **Clean up after yourself.** Delete dead code and imports you orphan. Never use git to
   revert or discard work; other agents or the developer may own those changes. Never run
   `git stash` in any form — no exceptions.
9. **No blind repository sweeps.** Use the Codebase Map, open the named region, then make
   a narrow search.
10. **No surprise interactive verification.** Do not start a dev server, open a browser,
    or use computer control unless the developer explicitly asks or agrees.
    **Exception — the browser domain.** The `browser_*` tools are sanctioned
    infrastructure and are auto-allowed: opening a browser page on a discovered
    dev server, resizing it, snapshotting it, and driving it are ordinary
    verification, not a surprise. Starting the dev server itself is still not —
    Solus does not own those processes (`docs/plans/cross-platform-visual-qa.md`).
11. **No broad unknown records.** `Record<string, unknown>` is forbidden in authored code.
    Define the exact object shape with a domain-specific type. Do not replace it with
    `object`, `unknown`, a broad index signature, a type assertion, or a renamed loose
    alias. Do not edit generated files to satisfy this rule; run `bun run lint:types`.

## The three ways to hurt yourself

### 1. Killing by pattern

Never use `pkill -f`, `killall`, `pgrep | kill`, or kill a PID found only by matching a
name, command, path, or worktree string. Your own agent process and other Solus sessions
may contain the same path in their arguments.

Stop only a process whose PID you captured when you started it. If diagnosing a port
owner, verify the process and its working directory before acting. Do not stop a process
you did not start without explicit permission.

### 2. Touching live Solus data

The desktop app's Electron `userData` directory and the standalone server's
`SOLUS_DATA_DIR` (default `~/.solus`) may contain the developer's real sessions, tokens,
settings, database, works, and automation state.

Read-only inspection is acceptable when the task requires it. Never start development
code against live data, open its database read-write, migrate it, seed it, clean it up, or
copy partial live SQLite files. Use a worktree-local or temporary `SOLUS_DATA_DIR` for
tests and manual development.

### 3. Assuming “local” across a transport boundary

The web client may be on a different device from the server. Do not send local-only paths,
Electron objects, unbounded filesystem data, or provider-native events to the renderer.
Do not call Electron IPC directly from shared web behavior. Do not hardcode localhost,
ports, or origins into a client bundle.

Route server capability through the typed RPC layer. Keep transport-specific behavior at
the transport or preload boundary.

## Hit every applicable surface

The most common class of defect is a change that works on the path tested and is absent or
stale elsewhere. Before calling product work done, walk this list and state which entries
applied:

- **Entry points.** A behavior reachable from the conversation may also be reachable from
  Settings, the command palette, a context menu, the project panel, and a keybinding.
- **Modes.** Editor mode and Pill mode stay mounted independently. Check both when changing
  layout, focus, overlays, input behavior, or navigation.
- **Clients.** Implement every UI change across mobile, desktop, and web. Desktop uses
  Electron IPC and native capabilities; web and mobile connect remotely and cannot
  assume Electron APIs. Surface-specific interaction is acceptable; missing capability
  is not.
- **Providers.** Claude and Codex each have an adapter and different lifecycle semantics.
  Provider-shaped features need an explicit decision for each backend, even when the
  decision is “unsupported.”
- **Contracts.** Data crossing a process or network boundary is declared in
  `packages/contracts/src/rpc.ts` and shared types. Update the server handler, preload bridge, clients,
  and event topic together.
- **Reverse states.** If you add a way in, add the way out and a way to see the current
  state. Pause needs resume; pin needs unpin; open needs close or restore.
- **Connection modes.** Desktop-local, desktop-hosted, and standalone remote connections
  can differ in origin, filesystem access, auth, latency, and reconnect behavior.
- **Persistence and refresh.** Durable state needs clear ownership, stale guards, and an
  update path. Reconnects and multiple mounted tabs must not show contradictory state.
- **Docs.** User-visible behavior and architectural decisions belong in `docs/`; vocabulary
  and implementation decisions for substantial features belong in `docs/plans/` or
  `docs/adr/`.

## Product and UX

- Brand: **clean, intuitive, premium.** Every UI decision should serve those qualities.
- Colors and shadows must work in **both light and dark mode**.
- Use Tailwind v4 utilities rather than CSS wherever practical.
- Use `text-workspace-chrome` for navigation, rails, action labels, and other
  workspace chrome. It is the canonical responsive type rung: 12px on laptop
  displays, 14px on large desktop displays, and 14px on coarse-pointer mobile
  clients. Do not recreate it with hard-coded width queries or
  `.is-laptop-display` text-size variants. Use `.is-laptop-display` only for
  non-type geometry such as widths, heights, padding, and gaps; it is driven by
  the shared `LAPTOP_SCREEN_MAX_WIDTH` definition.
- The interface is **keyboard-first**. Every control must be keyboard-navigable. Add a
  shortcut where it materially improves a repeated action.
- Global shortcuts use `opt+shift+<key>`; sub-page shortcuts use `opt+<key>`.
- Preserve focus continuity. After an action, return focus to the active input when typing
  is the natural next step.
- Loading, empty, error, disabled, reconnecting, and stale states are part of the feature.
  A lying spinner or stale label is a correctness bug.
- Avoid perpetual animation and expensive blur/paint effects. Motion should be finite,
  purposeful, and respectful of reduced-motion preferences.

## Renderer architecture rules

- **Every feature is a folder.** Components live beside their feature, never at
  `components/` root. Promote a primitive to `components/ui/` only on the second unrelated
  importer.
- **Keep logic out of `.svelte`.** Parsing, math, formatting, and algorithms belong in a
  sibling `lib/*.ts` or `*.svelte.ts`. A `.svelte` file should contain markup and thin
  handlers.
- **Load external renderer data through stores.** Components must not call
  `window.solus.*` loaders directly when the result is durable domain state, shared by
  multiple surfaces, cacheable, refreshable, or provider-backed. Put that state and its
  stale-guard/cache logic in a colocated `*.store.svelte.ts` or the existing feature store
  (`tasks`, `prs`, `works`, and so on). Let components read store state and trigger store
  commands.
- Keep truly ephemeral interaction state local: modal drafts, one-off file-picker
  navigation, debounced autocomplete results, and single-use command actions do not
  require a store.
- **Keep Tailwind visible in markup.** Static utility lists belong inline on the element.
  Do not hide them in TypeScript constants or CSS variables merely to shorten markup.
  Extract only when the choice is real component state or shared by unrelated importers.
- Colocate feature utilities under that feature's `lib/`. Only cross-feature utilities
  belong in `packages/workspace-ui/src/lib/`.
- Flag files over 600 lines during review. Files over 1000 lines must be split.
- Use `SvelteMap` and `SvelteSet` for reactive maps and sets.
- Use `$effect` only when `$derived` genuinely cannot express the relationship.

### Variable naming

- **Name meaning, not mechanism or history.** When a thing's purpose outgrows its name,
  rename it in the same change; let the compiler identify every call site.
- **Prefer plain roles over jargon.** Use `BaseContent`/`OverlayContent`, not names that
  require a glossary.
- **Do not abbreviate domain objects.** Use `panes`, not `av`; `session`, not `sess`.
  Conventional short names are fine within a few lines (`i`, `e`, `el`).
- **Use one name per concept everywhere.** Do not coin synonyms such as “split chat,”
  “pinned conversation,” and “secondary chat.” Plans lock vocabulary before implementation.
- **Qualify IDs and booleans.** Use `sourceTabId` or `focusedChatTabId`, not a bare `id`
  when several IDs are present. Booleans read as assertions: `hasResized`, `isBusy`,
  `secondaryOpen`.
- **Methods are commands; getters are answers.** `openSplitChat(tabId)`,
  `closeOverlay()`, `chatTabIn(slot)`.

### Svelte 5 performance: mounted tabs and modes

All tabs stay mounted and are hidden with `display: none`. Never spread `TabState` for a
small update. `$state` proxies are deeply reactive per property; replacing the object
invalidates every `$derived` that reads the tab across potentially hundreds of messages.

```ts
this.tabs[tabId] = { ...this.tabs[tabId], hasUnread: false } // BAD: invalidates the graph
this.tabs[tabId].hasUnread = false                            // GOOD: one property changes
```

Apply the same rule to arrays inside `$state`: mutate with `.push()`, `.splice()`, or an
index rather than rebuilding with `.map()` or `[...array]`. Mutate a message in place
instead of replacing the transcript. Memoize expensive per-item work such as `JSON.parse`
in a `WeakMap` keyed by the item; bypass the cache while the item is still mutating
(`toolStatus === 'running'`).

Never toggle Pill and Editor modes with `{#if isEditorMode}…{:else}…`. Destroying the
subtree forces Tiptap initialization, markdown parsing, entry animations, layout churn,
and IPC refetches on every toggle. Lazy-mount each mode once, then hide it:

```svelte
<script lang="ts">
  let hasMountedEditor = $state(isEditorMode)
  let hasMountedPill = $state(!isEditorMode)

  $effect(() => {
    if (isEditorMode) hasMountedEditor = true
    else hasMountedPill = true
  })
</script>

{#if hasMountedEditor}
  <div class:mode-hidden={!isEditorMode}>…</div>
{/if}
{#if hasMountedPill}
  <div class:mode-hidden={isEditorMode}>…</div>
{/if}
```

```css
.mode-hidden {
  display: none !important;
}
```

`display: none` removes a mode from layout, paint, and hit testing without unmounting it,
so state survives transitions.

## Development safety

- `bun install` installs dependencies.
- `bun run dev` starts the Electron/Vite development environment. Run it only when the
  developer explicitly requests interactive verification.
- If you start a process, capture its PID and stop exactly that PID when finished.
- Do not assume a printed port or URL is stable. Read the current process output.
- Use a worktree-local or temporary `SOLUS_DATA_DIR` for any standalone server you start.
- Do not point development builds at the live desktop `userData` directory or `~/.solus`.
- Do not open browser windows or use computer control without permission.
- For an explicitly requested isolated headless app run, follow `.claude/skills/run-app/SKILL.md`; subagents reuse the running instance rather than launching their own.
- Do not modify generated provider types by hand. Use the generator script when the task
  explicitly requires regenerated Codex types.

## Test data

An empty store is often a poor test, but live state is never test data.

- Prefer focused fixtures and temporary directories owned by the test.
- If a manual flow needs persistent state, seed a disposable `SOLUS_DATA_DIR`.
- Copy data into a sandbox; never symlink a sandbox to live state.
- A SQLite database must be copied consistently with its WAL/SHM state while the source is
  closed. When in doubt, create purpose-built fixture data instead.
- Never let test or development state flow back into the live Solus data directory.
- Do not use real tokens, OAuth credentials, provider secrets, or production analytics
  settings unless the developer explicitly asks for the relevant integration test.

## Verifying

Use the smallest proof that demonstrates the change:

1. Run focused unit tests for the behavior you changed, for example:
   `bun test tests/unit/<feature>.test.ts`.
2. Run any targeted typecheck, lint, or generator validation that owns the changed area.

Do not run the full Playwright suite, start a dev server, or perform browser/computer-use
verification unless asked. User-visible frontend changes may receive one integrated pass
after the implementation is complete and the developer has agreed to it.

Backend behavior changes should ship with focused tests. Prefer deterministic event,
receipt, and lifecycle assertions over sleeps or polling. A test that passes only because
of an arbitrary timeout is unreliable.

## Dev logs

The running dev server writes two files at the repo root. Read them instead of starting a
dev server of your own.

- **`dev.log`** — every main-process log entry as structured NDJSON, one JSON object per
  line: `ts`, `level`, `tag`, `file`, `msg`, plus the call's data fields. `msg` is a stable
  snake_case event name, never a prose sentence, so it is safe to match exactly. The file is
  truncated on each app boot, so it only holds the current run.
- **`dev-console.log`** — raw process output: vite and electron noise, build errors, and
  stray stack traces that never reached the logger.

Query `dev.log` with `jq` rather than reading it whole. Session ids, tab ids, and task ids
are top-level fields, so scoping to one session is a single filter:

```bash
jq -c 'select(.sessionId == "<id>")' dev.log          # one session's full timeline
jq -c 'select(.level == "error")' dev.log             # errors across all sessions
jq -c 'select(.msg == "worktree_created")' dev.log    # every occurrence of one event
grep '"sessionId":"<id>"' dev.log | jq .              # cheap pre-filter on a large file
```

When you add a log, keep that contract: `log.info('event_name', { sessionId, ...facts })`.
Never interpolate an id or other value into the message string — it becomes ungreppable. In
a code path scoped to one session, call `log.child({ sessionId })` once and every entry
below it carries the id automatically.

## Pull requests

- Never create or open a pull request unless the developer explicitly asks.
- Keep one concern per PR. If the description says “also,” consider splitting it.
- Use a conventional commit title in plain language, for example:
  `fix(sessions): keep host selection stable after reconnect`.
- In the body, explain the problem briefly, then how the change fixes it.
- Rebase onto the current target branch before opening a PR, but never rewrite or discard
  someone else's uncommitted work.
- UI changes should include before/after images; motion or timing changes should include a
  short recording.
- When responding to review, verify findings against the current source. Fix real issues
  and explain false positives rather than changing code to appease a bot.

## How Solus works

```text
renderer
  → workspace.apiFor(tabId) / serverConnections.apiFor(serverId) / primaryApi()
  → HostApi bound to one host
  → preload RPC envelope or web socket API
  → Electron IPC or WebSocket transport
  → SolusServer.handle()
  → domain handler
  → ControlPlane or focused manager/service

events
  ← typed RPC topic broadcast
  ← transport
  ← eventsFor(serverId) / subscribeAllHosts(...)
  ← renderer store
  ← mounted client surfaces

client shell
  → localApi
  → native bridge or browser equivalent
```

The desktop preload in `apps/desktop/src/preload/index.ts` exposes the renderer-safe API.
RPC methods and topics are declared in `packages/contracts/src/rpc.ts`.
`packages/server/src/server/server.ts` routes requests to one handler per domain under
`packages/server/src/server/handlers/`. The `ControlPlane` owns
session and tab orchestration; focused managers own git, runs, tasks, automations, works,
reviews, and other domains.

To add an RPC capability, update the shared contract, register the server handler, expose
the preload method where desktop needs it, and update both transports/clients as
applicable. Route renderer domain calls through `workspace.apiFor(tabId)`,
`serverConnections.apiFor(serverId)`, or an explicit `primaryApi()` choice. Route events
through `eventsFor(serverId)` or `subscribeAllHosts(...)`. Use `localApi` only for the
client shell. Renderer components consume durable external state through stores rather
than calling loaders directly. Run `bun run lint:hosts` to reject ambient access and
API-widening casts.

## Codebase Map

**Read this before searching.** Locate the feature or region, open the named files, then
use a narrow Grep.

### `apps/` — deployable entries

| Path | Owns |
|---|---|
| `apps/desktop/` | Electron main, preload, desktop renderer bootstrap, native windows, tray, shortcuts, and optional file handlers |
| `apps/standalone-server/` | Headless server process entry |
| `apps/client/` | Standalone web and mobile-responsive client shell, service worker, and demo |
| `apps/site/` | SvelteKit and Cloudflare site |
| `apps/cli/` | Installed command-line process |

### `packages/contracts/src/` — contracts shared across processes

- `types.ts` — broad shared domain surface.
- `rpc.ts` — RPC method and event-topic registry.
- `review.ts`, `task-types.ts`, `git-types.ts`, `providers.ts`, `browser-types.ts`,
  `claude-types.ts` — focused contracts.
- `diagram-*.ts` — diagram domain contracts and helpers.
- `model-profiles.json` — supported model profiles.

### `packages/server/src/` — server and backend

- `control-plane.ts` — central session orchestrator, prompt dispatch, and event normalization.
- `agents/` — Claude and Codex adapters, normalization, permissions, and tools.
- `server/` and `transports/` — RPC handlers and network transports.
- `git/`, `review/`, `tasks/`, `automations/`, `folio/`, `plans/`, `skills/`,
  `sessions/`, `project-config/`, `providers/`, `browser/`, and `google/` — focused
  domains.
- `platform/` — injected host paths, opener, secrets, and operating-system behavior.

### `packages/client-core/src/` — transport-neutral client core

- Host connections, WebSocket transport, capabilities, pairing, registry, and
  session caches.
- `local-api.ts` owns client-local capabilities. It does not call Electron.

### `packages/workspace-ui/src/` — Svelte 5 workspace UI

- **Entry:** `App.svelte`. Desktop bootstrap is in `apps/desktop/src/renderer/main.ts`;
  the web client bootstrap is in `apps/client/src/main.ts`.
- **`contexts/`:** state stores and contexts.
  - `workspace.context.svelte.ts` — core tab/session workspace state; large and
    performance-sensitive.
  - `session-*` — session lifecycle, transcript, and events.
  - `tasks.store`, `works.store`, `automations.store`, `prs.store`, `browser.store`,
    `git-status.store`, `plan.store`, `settings.context`, `toast.store` — feature state.
- **`lib/`:** cross-feature utilities for diffs, git actions, keybindings, highlighting,
  changed files, context usage, and input focus.
- **`hooks/`:** renderer integration hooks such as `agentEvents.svelte.ts`.

### `packages/workspace-ui/src/components/<feature>/`

| Feature | Owns |
|---|---|
| `conversation/` | Message stream, permission/question/rate-limit cards, and minimap |
| `session/` | Session sidebar, picker, and preview |
| `input/` | Input bar, slash commands, attachments, dictation, and waveform |
| `layout/` | Editor/Pill layouts, tab strip, action orb, side panel, workspace body, and new-tab home |
| `project-panel/` | Git, environment, goal, task, and automation sections plus usage meters |
| `diff/` | Diff panel/stream, file tree, comments, and find bar |
| `editor/` | Tiptap document editor and extensions |
| `tasks/` | Task board, cards, composer, detail, and filters |
| `plan/` | Plan gallery, modal, cards, and comments |
| `automations/` | Automation builder and page |
| `work/`, `artifact/`, `document-shell/`, `document-modal/`, `diagram/` | Works, document surfaces, and diagram canvas |
| `prs/`, `pr-review/`, `review/` | PR list, review pane, and review guide |
| `settings/` | General, projects, tools, skills, voice, review, connections, git providers, and keybindings |
| `browser/` | Browser pane, branch-grouped page strip, toolbar, viewport chip and its preset picker, stage, the app-root native webview layer, the streamed canvas surface for clients that cannot host a webview, the annotation bar that turns marks into a prompt, the capture control that files evidence on a task or pull request, and the snapshot card an agent's capture lands in |
| `pickers/`, `command-palette/`, `files/`, `comments/`, `connections/` | Focused interaction surfaces |
| `ui/` | Shared primitives such as Button, Input, Dropdown, Pane, CodeBlock, and DatePicker |

### Other top-level regions

- `tests/unit/` — focused behavior tests.
- `tests/e2e/` — integrated Playwright setup and tests.
- `scripts/` — build, packaging, generation, and development utilities.
- `packaging/` and `resources/` — distribution metadata and app assets.
- `docs/plans/` — feature plans and canonical vocabulary.
- `docs/adr/` — architecture decisions.

## Final change checklist

Before reporting completion:

- [ ] The change solves only the requested problem.
- [ ] Exports, immediate callers, shared contracts, and relevant stores were read first.
- [ ] The UI change is implemented across mobile, desktop, and web, or an explicit
  platform exception was approved and documented.
- [ ] Editor/Pill, Claude/Codex, and local/remote applicability were decided.
- [ ] Loading, error, reverse, reconnect, and stale states were considered.
- [ ] No large reactive object or transcript was rebuilt for a small update.
- [ ] No live Solus data or unrelated process was modified.
- [ ] Focused tests encode the intent of the change.
- [ ] `bun run build` succeeds.
- [ ] User-visible or architectural docs were updated when applicable.
- [ ] The final response states what changed, how it was verified, and any surface that
  was intentionally unsupported or not exercised.
