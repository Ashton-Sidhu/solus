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
| 7 | Keyboard summon | **Stays in main, works regardless of focus/mode.** Primary summon accelerator toggles the window for the current mode. Mode-toggle shows the other window. |
| 8 | Coexistence | **Both windows may be visible at once.** Mode-toggle focuses the other window when both are up. `currentViewMode` = mode of the last-focused Solus window. |
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
   - Default bounds ≈ current CSS card (92% × 90% of work area, centered); persist
     bounds/maximized state in main on move/resize and restore on recreate.
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

## Phase 2 — Renderer: one layout per window

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

## Phase 3 — Mode-scoped persistence

`src/renderer/contexts/tab-persistence.ts` — keys become per-mode:

- `solus-open-tabs:editor` / `solus-open-tabs:pill`; same for `solus-tab-drafts`.
- Key suffix comes from the fixed window mode (module init reads it once).
- **Migration** (one-time, in `loadPersistedTabs`): legacy `solus-open-tabs` present →
  return it for the editor store, then delete the legacy key; pill starts empty
  (decision #11). Same for drafts.
- This phase must land **with or before** Phase 1 being enabled by default — two windows
  writing one key clobber each other (the debounced writer assumes a single writer).

## Phase 4 — Active-session pointer + pill pickup

1. **Write** (`workspace.context.svelte.ts`): on `setActiveTab` and on prompt send,
   persist `solus-active-session: { sessionId, provider, workingDirectory, updatedAt }`.
   Both windows write it; last-focused wins by construction.
2. **Read** (pill only): on `onWindowShown` (the summon moment — pull semantics,
   decision #5):
   - pointer's session already open in a pill tab → `selectTab` + expand;
   - not open → create a tab attached to that `agentSessionId` via the existing
     resume/history path (`session-bootstrap.ts` / session-picker open flow), which
     already handles load-then-splice-live-stream;
   - pointer written by the pill itself (same window) → no-op guard.
3. No polling: the `storage` event fires across same-origin windows for free if we later
   want the pill to react while visible; v1 only needs the summon check.

## Phase 5 — Shrink + polish (optional, after v1 settles)

- Shrink the pill window to pill max bounds (bottom-center of cursor display), keeping
  click-through only for its transparent margins — cuts the composited surface from the
  whole work area to a strip (decision #10 deferred this).
- Revisit `backgroundThrottling` for hidden windows (rAF pause conveniently stops the
  typewriter loop; verify notification sounds/unread still behave).
- "Continue in editor" affordance in the pill (decision #6).

---

## Behavior spec (quick reference)

| Action | Result |
|--------|--------|
| Summon key, editor is current mode | Toggle editor window (show+focus / hide) |
| Summon key, pill is current mode | Toggle pill (unchanged from today) |
| Mode-toggle key, other window hidden | Show+focus other window, hide current, flip `currentViewMode` |
| Mode-toggle key, both visible | Focus the other window |
| Start run in editor → summon pill | Pill opens showing that session, live-streaming (pointer + attach) |
| Close editor via traffic light | Window hides; tabs/state preserved; reopen instant |
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
