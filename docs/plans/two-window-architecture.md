# Implementation Plan — Two-Window Architecture (Pill Panel + Editor App)

Split the single transparent full-work-area window into **two native windows sharing one
backend**: the **pill** stays a summonable, always-on-top, all-Spaces overlay panel; the
**editor** becomes a real OS window (native frame/resize, Dock + alt-tab presence, normal
Spaces behavior). Each window mounts exactly one layout, which deletes the dual-tree
`display:none` machinery in `App.svelte` and the ~150 lines of simulated window
drag/resize in `EditorLayout`, and stops the hidden mode's Svelte reactivity from running
through every streaming tick.

This plan is the single source of truth for the split. It folds in every decision reached
during design discussion.

---

## Resolved design decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Window model | **Two `BrowserWindow`s, one main process / one `SolusServer`.** Pill = transparent NSPanel as today. Editor = standard window, lazily created on first editor use. |
| 2 | Tab/UI state | **Client-owned, per-window.** Each window keeps its own tab store, persisted under mode-scoped localStorage keys. The server never owns tab state. |
| 3 | Shared session data | **Backend-owned, broadcast to all windows** (existing `SolusServer` topics — same mechanism the web client uses today). |
| 4 | Cross-window shared state | **Exactly one key**: `solus-active-session` — the last active session id (+ cwd/provider). Written by the focused window; read via the same-origin `storage` event. No tab-snapshot sharing. |
| 5 | Editor→pill pickup | **Automatic, pull-based.** On summon, the pill reads the pointer: tab exists → focus it (instant); no tab → attach once (existing history-load path), then it stays mounted. Never a cold reload. |
| 6 | Pill→editor pickup | **Explicit affordance** ("continue in editor"), not automatic — the editor tab strip is a curated workspace. Follow-up, out of scope for v1. |
| 7 | Keyboard summon | **Dedicated key per window, both in main.** Primary (Alt+Space) always toggles the pill; secondary (⌘⇧K) always toggles the editor, creating it on first use. Deterministic — no mode inference. In-app mode-toggle (⌥⇧E) surfaces the other window via `switchMode`. |
| 8 | Coexistence | **Both windows may be visible at once.** Mode-toggle focuses the other window when both are up. `currentViewMode` (last-focused window's mode) is runtime-only — a soft default for tray "Show Solus" and dock-activate. |
| 8b | Window-state persistence | **None (post-review).** Close-hides keep the editor window (and its bounds) alive for the whole app run; a fresh launch boots to the pill with the editor at default bounds. No `window-state.json`, no off-screen-bounds validation. Add back only if relaunch amnesia proves annoying in use. |
| 9 | Mode bootstrap | **`?mode=pill\|editor` URL param.** Each window mounts one layout; `WindowContext.viewMode` is fixed for the window's lifetime. Web client keeps its `matchMedia` behavior. |
| 10 | Pill window bounds | **Unchanged in v1** (full work area, CSS-positioned pill) to keep the diff surgical. Shrinking to pill bounds is a separate optimization phase. |
| 11 | Legacy tab migration | Existing `solus-open-tabs` seeds the **editor** store (it's the workspace); pill starts fresh. Legacy key deleted after migration. |
| 12 | Closing the editor window | **Hides it** (state preserved), mirroring today's pill close-to-tray behavior. |

---

## State model — three layers, one owner each

```
1. Sessions / messages / events    → backend (ControlPlane + SolusServer topics)   [exists]
2. Tabs, drafts, panel sizes, UI   → per-window renderer stores, mode-scoped keys  [split]
3. solus-active-session pointer    → localStorage, written by focused window       [new]
```

The conversation content **never** travels through localStorage. Layer 3 only tells the
pill *which* session to attach to; history + live stream come from layer 1, exactly like
the web client attaching to a running session today.

---

## Phase 1 — Main process: window registry + editor window ✅ (landed)

`src/main/index.ts` (~65 `mainWindow` references to audit).

1. **Window registry.** Keep `mainWindow` as the pill window (minimal diff); add
   `editorWindow: BrowserWindow | null`. Helpers: `windowForMode(mode)`,
   `forEachWindow(fn)`. Audit every `mainWindow` usage and classify:
   - *Pill-specific, unchanged*: click-through (`solus:set-ignore-mouse-events` already
     resolves the sender via `BrowserWindow.fromWebContents` — window-agnostic), spaces
     debug, `windowCursorRelative`, display-metrics rebounds.
   - *Sender-scoped*: design mode capture/opacity, screenshot — operate on the window
     that asked, not a global.
   - *Both windows*: `before-quit`/`close`-hides, theme broadcast.
2. **`createEditorWindow()`** — created lazily on first switch to editor:
   - Standard window: no `transparent`, no panel type, `resizable: true`,
     `skipTaskbar: false`, no `alwaysOnTop`, native shadow. macOS:
     `titleBarStyle: 'hiddenInset'` so it keeps the premium frameless look with real
     traffic lights.
   - Default bounds ≈ current CSS card (92% × 90% of work area, centered). ~~Persist
     bounds on move/resize~~ — cut in review (decision #8b): within-run bounds
     survive via close-hides; relaunches start at the default.
   - Loads the same renderer URL with `?mode=editor`.
   - `close` → hide (decision #12).
3. **IPC transport fan-out.** `attachElectronIpcTransport` currently sends every topic to
   one window (`src/main/transports/electron-ipc.ts:47-52`). Change
   `getMainWindow: () => BrowserWindow | null` to `getWindows: () => BrowserWindow[]` and
   send to each live `webContents`. (Invoke/send handlers are already window-agnostic.)
4. **Shortcut + mode routing.**
   - `toggleWindow()` (summon accelerators, tray) → toggles `windowForMode(currentViewMode)`.
   - New `switchMode()` RPC replaces the renderer-side `toggleViewMode`: ensure the other
     window exists, show + focus it; hide the current one **unless both were visible**
     (decision #8 — then just focus). Updates and persists `currentViewMode` in main.
   - `focus` events on both windows update `currentViewMode`, so summon always targets
     the surface the user last touched.
   - `setWindowLevelForViewMode` / blur-drop applies to the **pill only**; the editor
     never gets `alwaysOnTop` and is deleted from that path.
   - Optional (flag for later): map the existing **secondary** summon accelerator
     (`applyAppGlobalShortcuts`) to "always summon pill" for the pill-over-editor flow.
5. **`notifyViewMode`** becomes obsolete (window identity carries the mode). Remove the
   RPC and its startup call in `App.svelte:149-151` once Phase 2 lands.

## Phase 2 — Renderer: one layout per window ✅ (landed)

> Landed with three deltas from the sketch below: (a) summon keys became
> per-window (decision #7 revised) and `notifyViewMode` was deleted outright;
> (b) the editor's window-drag is a slim native drag strip under the macOS
> traffic lights rather than an app-region tab strip (polish item later);
> (c) file preview is simply disabled in the pill window (`requestFilePreview`
> no-ops there) — the pill has no pane surface for it. Phase 3's key scoping
> landed alongside (required before two live windows share localStorage).

1. **`WindowContext`** (`src/renderer/contexts/window.context.svelte.ts`): on Electron,
   read `viewMode` from `new URLSearchParams(location.search)` — fixed for the window's
   lifetime; drop the localStorage viewMode persistence (main owns last-mode now). Web
   keeps `matchMedia`. `setViewMode` → calls the new `switchMode` RPC.
2. **`App.svelte`**: mount `EditorLayout` *or* `PillLayout` from the fixed mode. Delete
   `hasMountedEditor` / `hasMountedPill`, both `mode-shell` wrappers, and `.mode-hidden`
   (`App.svelte:104-1126`, style block). Gate mode-specific globals:
   - click-through mousemove loop (`App.svelte:244-276`) → pill window only;
   - `analytics.appOpened()` → fire once (pill/boot window), tag events with mode;
   - keybinding `enabled: () => viewMode === '…'` gates keep working unchanged (the value
     is now constant per window).
3. **`EditorLayout.svelte`**: delete the simulated window — drag math, four corner-resize
   handles, shell offset/clamp effects (`EditorLayout.svelte:27-235`), `.editor-shell`
   transform styling. `WorkspaceBody` fills the window; `onStartWindowDrag` becomes a
   native drag region (`-webkit-app-region: drag` on the tab-strip row) and
   `onResetWindowPosition` goes away.
4. Both windows keep running `createAppCore()` and the agent-event pipeline untouched —
   they're independent clients of the same broadcast stream, which the event reducer
   already supports (web + desktop concurrently today).

## Phase 3 — Mode-scoped persistence ✅ (landed with Phase 2)

`src/renderer/contexts/tab-persistence.ts` — keys become per-mode:

- `solus-open-tabs:editor` / `solus-open-tabs:pill`; same for `solus-tab-drafts`.
- Key suffix comes from the fixed window mode (module init reads it once).
- **Migration** (one-time, in `loadPersistedTabs`): legacy `solus-open-tabs` present →
  return it for the editor store, then delete the legacy key; pill starts empty
  (decision #11). Same for drafts.
- This phase must land **with or before** Phase 1 being enabled by default — two windows
  writing one key clobber each other (the debounced writer assumes a single writer).

## Phase 4 — Active-session pointer + pill pickup ✅ (landed)

Implementation (`contexts/active-session-pointer.ts` + `App.svelte` wiring):

1. **Write** (both windows): the latest session is simply the one the last
   message was sent in. `sendMessage` records `lastPromptTabId`; a small effect
   writes `solus-active-session: { sessionId, provider, cwd, title, writer,
   updatedAt }` once that tab's `agentSessionId` is known (it binds a moment
   after the first send). Only a user send triggers a write, so background
   windows never clobber it — no focus gating needed.
2. **Read** (pill only, pull semantics): on a hidden→visible transition
   (`visibilitychange`, i.e. summon) plus one post-hydration boot check — never
   on focus/click of an already-visible pill, so the tab is never yanked while
   the user is looking at it. Picks up only pointers with `writer: 'editor'`,
   and each `updatedAt` stamp is handled at most once, so pill-side tab
   switches aren't re-overridden by a stale pointer.
3. **Attach** reuses `resumeSession` (history load + live-stream splice); an
   already-open session is focused instead.

## Phase 5 — Polish ✅ (landed, one item deferred)

- **Dock item (macOS)**: the app still boots dock-hidden (pill = menu-bar-style
  overlay), but the Dock icon appears while the editor window is visible and
  goes away when it hides. Dock click → app `activate` → current mode's window.
- **"Continue in editor"** (decision #6): the pill→editor mode-toggle carries
  the active session via a one-shot `solus-session-handoff` key (30s TTL); the
  editor consumes it on mount or via the cross-window `storage` event and
  focuses-or-resumes that session. Editor→pill needs no handoff — the ambient
  pointer covers it.
- **`backgroundThrottling`**: left at Electron's default (on). A hidden window's
  rAF pauses (stopping the typewriter loop for free); server-pushed IPC events
  still deliver, so unread/notification behavior is unaffected.
- **Pill window shrink — deferred deliberately.** Three couplings make it a
  visual-verification job, not a headless one: (a) pill sizing CSS derives from
  `window.innerWidth`, so shrinking the window to CSS-derived bounds is
  circular — sizing must move to main or the CSS must become fill-window;
  (b) `DesignAnnotation` needs the full work area, so design mode would have to
  grow/restore the window bounds around capture; (c) centered modals
  (DirectoryPicker, shortcuts) would render inside the strip. Do it in a
  session where the app can actually be run.

---

## Behavior spec (quick reference)

| Action | Result |
|--------|--------|
| Primary key (Alt+Space) | Toggle the pill — always, even over a visible editor |
| Secondary key (⌘⇧K) | Toggle the editor — always, creating it on first use; focuses if visible-but-unfocused |
| Mode-toggle key (⌥⇧E), other window hidden | Show+focus other window, hide current |
| Mode-toggle key, both visible | Focus the other window |
| Start run in editor → summon pill | Pill opens showing that session, live-streaming (pointer + attach) |
| Toggle pill→editor on a session | Editor opens/focuses that session (one-shot handoff) |
| Close editor via traffic light | Window hides; Dock icon disappears; tabs/state preserved; reopen instant |
| Editor window visible | App has a macOS Dock icon; pill-only keeps the app out of the Dock |
| Click outside pill | Pill drops always-on-top on blur (unchanged) |
| Close tab in one window | No effect on the other window's tabs (independent views; session lives on backend) |

## Risks / watch items

- **`mainWindow` audit breadth** — 65 references; the classification in Phase 1.1 is the
  bulk of the review surface. Mis-scoping (e.g. design-mode opacity hitting the wrong
  window) is the likeliest regression class.
- **Double event traffic** — every topic now fans out to two webContents. Same cost class
  as running web + desktop today; no new backend work expected.
- **macOS focus juggling** — the pill's NSPanel non-activating behavior must not change;
  the editor must *not* inherit panel behavior. Test summon-over-fullscreen-Space for the
  pill and normal Space membership for the editor.
- **Per-window singletons** — dictation/audio, toasts, popover layer all instantiate per
  window; verify nothing assumes process-wide uniqueness (notification `Audio` may play
  from both windows — dedupe by focused window).
- **DevTools / dev ergonomics** — `openDevTools` currently auto-opens for one window;
  scope to both in dev.

## Deletions (net simplification)

- `App.svelte`: dual-mount + `mode-hidden` machinery, `notifyViewMode` startup call.
- `EditorLayout.svelte`: simulated drag/resize (~150 lines JS + corner handles + CSS).
- `main/index.ts`: editor branch of `setWindowLevelForViewMode`, `applyViewMode`,
  `notifyViewMode` handler.
- `window.context.svelte.ts`: localStorage viewMode persistence.

## Verification

- `bun run build` after each phase.
- Manual flows (macOS): summon in each mode; mode toggle each direction; editor native
  resize/snap/alt-tab/Dock; start run in editor → summon pill mid-stream; tab isolation
  between windows; legacy-tab migration on first launch; pill over full-screen Space.
