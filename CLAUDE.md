# Solus — Operating Manual

> **Before any codebase-wide search (Grep/Glob/Agent over the whole repo), read the Codebase Map below first.**
> The map tells you which files to open. Search only after the map points you to a region — never sweep the repo blind.

---

## Rules — non-negotiable

1. **Think before coding.** State assumptions. Ask, don't guess. Push back when a simpler path exists. Stop when confused.
2. **Simplicity first.** Minimum code that solves it. Nothing speculative. No abstractions for single-use code.
3. **Surgical changes.** Touch only what the task needs. Don't improve, refactor, or restyle adjacent code. Match existing style.
4. **Surface conflicts, don't average them.** If two patterns contradict, pick one (more recent / more tested), say why, flag the other. Never blend them.
5. **Read before you write.** Read exports, immediate callers, and shared utilities first. If unsure why code is shaped a certain way, ask.
6. **Tests verify intent, not behavior.** A test must encode *why* the behavior matters. If it can't fail when business logic changes, it's wrong.
7. **No pass-through wrappers.** Don't add a function that only forwards args. Inline it. Wrap only to earn it: validation, defaults, error handling, memoization, or a narrower type.
8. **Clean up.** Delete dead/unused code you orphan. Never revert with git — ever, no exceptions.

## Product & UX

- Brand: **clean, intuitive, premium.** Every UI decision serves these.
- Colors must work in **both dark and light mode**. Use Tailwind v4 utilities — not CSS — wherever possible.
- **Editor mode** = focused single-agent UI. **Pill mode** = lightweight, summon-as-needed for multitaskers.
- **Keyboard-first.** Buttons get keybindings where sensible; every UI is keyboard-navigable. Global shortcuts: `opt+shift+<key>`. Sub-page shortcuts: `opt+<key>`.
- After a user clicks/acts, **refocus the active input bar** so they can keep typing.
- `bun run build` to confirm it compiles (keep output to warnings/errors). **Do not start a dev server to verify.**
- `bun run dev` tees its output to `dev.log` at the repo root. If a dev server is already running and you need live logs for debugging, **read `dev.log`** instead of starting a new dev server.

## Renderer architecture rules

- **Every feature is a folder.** Components live beside their feature, never at `components/` root. Promote to `components/ui/` only on the *second unrelated* importer.
- **Keep logic out of `.svelte`.** Parsing, math, formatting, algorithms → sibling `lib/*.ts` or `*.svelte.ts`. `.svelte` holds markup + thin handlers.
- **Load external renderer data through stores.** Components should not call `window.solus.*` loaders directly when the result is durable domain state, shared by more than one surface, cacheable, refreshable, or provider-backed. Put that state and its stale-guard/cache logic in a colocated `*.store.svelte.ts` or the existing feature store (`tasks`, `prs`, `works`, etc.), then let `.svelte` files read store state and trigger store methods. Keep truly ephemeral interaction data local: one-off file picker navigation, debounced autocomplete/search results, modal form drafts, and single-use command actions do not need stores.
- **Keep Tailwind visible in markup.** Static Tailwind class lists belong inline on the element. Don't hide them in TS string constants or CSS variables just to shorten markup; extract only when the class choice is real component state or shared across unrelated importers.
- **Shared primitives are shadcn-svelte.** Stock generated components live in kebab-case folders under `components/ui/` (`button/`, `select/`, …) — never edit them; Solus colors flow through the variable bridge in `index.css` (shadcn `primary` = brand accent/terracotta, shadcn `accent` = subtle hover wash). Add new primitives with `bunx shadcn-svelte@latest add <name>`. When touching a file, migrate hand-styled elements that visually read as a shadcn primitive (button, select, switch, toggle, …) to it; keep a raw `<button>` only for semantic-only interactive elements (tabs, list rows, cards, tree items). PascalCase files in `ui/` are legacy bespoke primitives — migrate away opportunistically, never add new ones.
- `lib/` is colocated per-feature. Only cross-feature utils go in `src/renderer/lib/`.
- Flag any file > 600 lines in review. Hard-split > 1000 lines.
- `SvelteMap` / `SvelteSet` for reactive maps/sets. Use `$effect` only when `$derived` genuinely can't — no exceptions.

### Variable naming

- **Name the meaning, not the mechanism or the history.** When a thing's purpose outgrows its name, rename it in the same change — the compiler catches every call site. (`artifactViewer` drifted into managing all panes and confused everyone until it became `panes`.)
- **Plain roles over jargon.** Prefer `BaseContent`/`OverlayContent` to `DurableContent`/`TransientContent`. If a reader needs a glossary to parse the name, pick a different word.
- **No abbreviations for domain objects.** `panes`, not `av`; `session`, not `sess` in new code. Conventional short names are fine where scope is a few lines (`i`, `e`, `el`).
- **One name per concept, everywhere.** Don't coin synonyms across files ("split chat" vs "pinned conversation" vs "secondary chat"). The canonical term lives where the concept is defined; feature plans in `docs/plans/` lock vocabulary before implementation.
- **Qualify ids and booleans.** An id says whose id it is (`sourceTabId` — the chat a viewer was opened for; `focusedChatTabId`), never a bare `id`/`tabId` where several are in play. Booleans read as assertions: `hasResized`, `isBusy`, `secondaryOpen`.
- **Methods read as commands, getters as answers.** `openSplitChat(tabId)`, `closeOverlay()`, `chatTabIn(slot)`.

### Svelte 5 performance (all tabs stay mounted; hidden via `display:none`)

**Never spread `TabState` for a small update.** `$state` proxies are deeply reactive per-property; a new object reference invalidates every `$derived` reading the tab (`visibleMessages`, `grouped`, `changedFiles`, all status flags) across hundreds of messages.

```ts
this.tabs[tabId] = { ...this.tabs[tabId], hasUnread: false } // BAD — invalidates whole chain
this.tabs[tabId].hasUnread = false                            // GOOD — notifies one subscriber
```

Same for arrays inside `$state`: mutate with `.push()`/`.splice()`/index, don't rebuild with `.map()`/`[...arr]`. Mutate a message in place rather than rebuilding the array. Memoize expensive per-item work (e.g. `JSON.parse`) in a `WeakMap` keyed on the item; skip the cache while the item is still mutating (`toolStatus === 'running'`).

**Never toggle pill↔editor with `{#if isEditorMode}…{:else}…`.** Destroying the subtree forces Tiptap re-init, full markdown re-parse, ~20 entry animations, flip churn, and IPC refetches — eventually GC-killing the renderer. **Lazy-mount once, then hide:**

```svelte
let hasMountedEditor = $state(isEditorMode);
let hasMountedPill = $state(!isEditorMode);
$effect(() => { if (isEditorMode) hasMountedEditor = true; else hasMountedPill = true; });

{#if hasMountedEditor}<div class:mode-hidden={!isEditorMode}>…</div>{/if}
{#if hasMountedPill}<div class:mode-hidden={isEditorMode}>…</div>{/if}
```
```css
.mode-hidden { display: none !important; }
```
`display:none` detaches from layout/paint/hit-testing without unmounting, preserving all state across toggles.

---

## Codebase Map

**Read this before searching.** Locate the feature/region, open those files, then narrow with Grep.

### Architecture (Electron + Svelte 5; also serves a web client)

```
renderer  →  window.solus.<method>()        (src/preload/index.ts wraps as RPC envelope)
          →  SolusServer.handle()           (src/main/server/server.ts)
          →  handler in server/handlers/*   (one file per domain)
          →  ControlPlane / managers        (src/main/control-plane.ts = session+tab orchestrator)
events    ←  broadcast over RPC topics       (back to renderer)
```
Add an RPC method/topic in `src/shared/rpc.ts`, then register a handler on `SolusServer` and expose it in `src/preload/index.ts`.

### `src/main/` — Electron main (backend)
| Path | Owns |
|------|------|
| `index.ts` | App bootstrap, windows, tray, global shortcuts, custom protocols |
| `control-plane.ts` | **Central orchestrator** — sessions, tabs, prompts, event normalization (large) |
| `agents/` | Agent backends: `claude/`, `codex/`; `backend-registry.ts`, `run-input.ts`, `text-generator.ts` |
| `server/` | HTTP/WS server (`server.ts`, `http.ts`, `index.ts`) + `handlers/` (session, file, git/worktree, review, tasks, folio, automation, google, provider, theme, window…) |
| `transports/` | `websocket.ts` (WebSocket RPC transport) |
| `git/` | Worktrees, status, snapshots, watcher, PR drafts |
| `run/` | Dev-server "Run" process management |
| `review/` | Review guide producer + ledger + review agent |
| `tasks/` | Task board service/tools + `providers/` |
| `automations/` | Scheduled automations (runner, scheduler, store, tools) |
| `folio/` | "Works" (documents/slides/diagrams) tools + annotations |
| `plans/` | Plan-mode annotations |
| `skills/` | Skills CLI + provider |
| `sessions/` | Pinned sessions, session tools |
| `project-config/` | Per-project config + projects manifest |
| `providers/` | Git host providers (`github/`) |
| `google/` | Google OAuth + Drive |

### `src/shared/` — shared across processes
`types.ts` (big shared surface) · `rpc.ts` (channel registry) · `review.ts` · `task-types.ts` · `run-types.ts` · `git-types.ts` · `providers.ts` · `claude-types.ts` · `diagram-*.ts` · `model-profiles.json`

### `src/renderer/` — Svelte 5 UI
- **Entry:** `App.svelte`, `main.ts`
- **`contexts/`** — state stores (`*.store.svelte.ts`, `*.context.svelte.ts`):
  - `workspace.context.svelte.ts` — **tabs/session core** (large) · `session-*` — session lifecycle/transcript/events
  - `run.store` · `tasks.store` · `works.store` · `automations.store` · `prs.store` · `git-status.store` · `plan.store` · `settings.context` · `toast.store`
- **`lib/`** — cross-feature utils: `diff*`, `git-actions`, `keybindings/`, `highlight`, `changedFiles`, `contextUsage`, `inputFocus`…
- **`hooks/`** — `agentEvents.svelte.ts`

### `src/renderer/components/<feature>/`
| Feature | What's there |
|---------|--------------|
| `conversation/` | Message stream `ConversationView`, permission/question/rate-limit cards, minimap |
| `session/` | `SessionSidebar`, session picker/preview |
| `input/` | `InputBar`, slash commands, attachments, dictation, waveform |
| `layout/` | `EditorLayout`/`PillLayout`, `TabStrip`, `ActionOrb`, `SidePanel`, `WorkspaceBody`, `NewTabHome` |
| `project-panel/` | Right panel: Git / Run / Tasks / Works / Automations sections + log console |
| `diff/` | `DiffPanel`/`DiffStream`/`Diff`, comments, file tree, find bar |
| `editor/` | Tiptap document editor + extensions (file/plan refs, slash menu, comments) |
| `tasks/` | Task board, cards, composer, detail, filters |
| `plan/` | Plan-mode gallery/modal/cards/comments |
| `automations/` | Automation builder + page |
| `work/` `artifact/` `document-shell/` `document-modal/` `diagram/` | "Works": docs, slides, diagrams (canvas), folio gallery |
| `prs/` `pr-review/` `review/` | PR list, PR review pane, review guide surface |
| `settings/` | Settings tabs (general, projects, tools, skills, voice, review, connections, git providers, keybindings) |
| `pickers/` `command-palette/` `files/` `comments/` `connections/` `run/` | Pickers, command palette, file panes, comment layer, connections, run dock |
| `ui/` | Shared primitives (Button, Input, Dropdown, Pane, CodeBlock, DatePicker…) |

### Other
`client/` — standalone web client (separate Vite build) · `src/preload/index.ts` — RPC bridge · `scripts/`, `resources/`, `docs/`
