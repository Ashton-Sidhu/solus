# Split-Chat First-Class Refactor

**Goal:** make a chat in the secondary pane a first-class citizen: focusable, keyboard-addressable, never silently evicted, with chrome parity and its own git surfaces.

**Status:** the `artifactViewer`/`av` → `panes` rename (and internal `panes` array → `slots`, `closeArtifactViewer` → `closeArtifact`) is **already done** on `main`. Work packages below start from that state.

## Vocabulary (locked — do not invent synonyms)

The two-slot workspace layout is owned by `PaneViewStore` (`contexts/pane-view.store.svelte.ts`), exposed as `session.panes`; alias it locally as `panes`.

- **Pane slots** — `primary` (main/left pane; `{ kind: 'conversation' }` = the active-tab chat pool) and `secondary` (right pane). The store's internal slot array is `slots` (replaced by named fields in WP1).
- **`BaseContent`** — what a pane shows until the user closes/replaces it: conversation, plan, work, automation, review, pr-review, pages. Store fields: `primaryContent`, `secondaryContent`.
- **`OverlayContent`** — a temporary viewer (diff, files, file-editor, subagent) that pops *over* the secondary pane and restores what was beneath on close. Store field `secondaryOverlay`; methods `showOverlay(content)` / `closeOverlay()`.
- **`sourceTabId`** (on overlay content) — the chat tab whose session a viewer was opened for; drives which session's diff/files show. Never bind a viewer to `activeTabId` implicitly.
- **`focusedPane: PaneSlot`** — which pane owns keyboard input (composer caret + per-session shortcuts). A separate axis from `activeTabId`, which keeps meaning "the conversation in the primary pool".
- **`chatTabIn(slot, activeTabId)`** — which chat tab a slot is showing (`null` if none). `focusedChatTabId` on the workspace context = the chat that keyboard actions target.
- **Split chat** — a conversation pinned in the secondary pane: `openSplitChat(tabId)` to pin, `promoteSplitToMainTab()` to move it back to the main view.

**Verify after every work package:** `bun run build` (warnings/errors only). Do **not** start a dev server; if one is running, read `dev.log` for runtime errors. Known pre-existing build warnings (not yours to fix): `state_referenced_locally` in `diff/Diff.svelte` and `pr-review/guide/GuideFileDiff.svelte`.

**House rules (from CLAUDE.md — binding):** mutate `$state` in place (never spread-replace); `$derived` over `$effect`; logic in sibling `lib/*.ts`, not `.svelte`; static Tailwind inline; dark + light mode; keyboard-navigable; surgical diffs; delete orphaned code; never `git revert`.

---

## Background: why (audit summary)

The rendering layer is shared (`ConversationPane` reuses `ConversationView` + `EditorInputCard`), but everything around the split chat assumes "the conversation" means the primary pane:

1. **Focus never reaches the split.** `InputBar` handles the global focus event only when it is the primary composer (`InputBar.svelte:35` `isPrimary = tabId === undefined`, `:367`). ⌥⇧/ "New chat in split" opens a chat on the right and puts the caret in the **left** composer. Quote-selection and `pendingInput` injection are also `isPrimary`-gated (`InputBar.svelte:345–364`). Session-scoped keybindings (fork, stop, diff…) always target `activeTabId`.
2. **The split chat is the lowest-priority tenant of a single slot.** `enterDiff` / `openFiles` / `openFilePreview` / `openSubagent` overwrite the secondary slot (`pane-view.store.svelte.ts:274–333`); closing the viewer leaves the slot empty instead of restoring the chat.
3. **Tab-strip blindness.** No indicator for the split tab; selecting it silently closes the split (`workspace.context.svelte.ts:273–278`). `visibleTabIds` branch-filtering (`WorkspaceBody.svelte:101`) can orphan a split tab from another branch.
4. **Chrome gap.** `ConversationPane` header has no status glyph, byline, maximize, or actions menu (`Pane.svelte` passes `onToggleSecondaryMaximize` to diff/subagent panes but not `ConversationPane`).
5. **No git surfaces for the split session.** Diff/files/file-editor branches in `Pane.svelte` (`:374`, `:392`, `:404`) resolve from `session.activeTabId`; the split's `ConversationView` gets no `onDiffToggle`.

## Locked design decisions (do not re-litigate)

1. Two fixed panes stay (`primary`, `secondary`). No N-pane generalization.
2. `activeTabId` keeps its meaning — the conversation in the primary pane's pool (`tab-registry.svelte.ts:10`). Focus is a **separate axis**, never derived one from the other.
3. `focusedPane: PaneSlot` on `PaneViewStore` governs input + keyboard targeting **only** — not project-panel scope, git env, or status bar (those stay on `activeTabId`).
4. Secondary conversation content always carries `tabId`. `chatTabIn(slot, activeTabId)` is the single answer to "which chat is showing in this slot": primary → `activeTabId`, secondary → the split chat's tab id, `null` if the slot holds no chat.
5. Content roles: **BaseContent** (conversation, plan, work, automation, review, pr-review, pages) vs **OverlayContent** (diff, files, file-editor, subagent). Overlays cover the secondary pane and restore `secondaryContent` on close.
6. Selecting a tab that is currently split **focuses the split pane** — it no longer promotes-and-closes. Promotion stays available via the pane header ("Open as main tab") and `global.open-in-split`.
7. Diff/files/file-editor bind to the session of the chat that requested them via `sourceTabId` on the overlay content — never implicitly to `activeTabId`.

## Target store contract (WP1 delivers this)

```ts
export type PaneSlot = 'primary' | 'secondary'

/** Temporary viewers that pop over the secondary pane. Closing one restores
 *  whatever secondaryContent held. sourceTabId = the chat session the viewer
 *  was opened for (drives which session's diff/files are shown). */
export type OverlayContent =
  | { kind: 'diff'; scope?: DiffScope; sourceTabId: string }
  | { kind: 'files'; sourceTabId: string }
  | { kind: 'file-editor'; file: FilePreviewRequest; sourceTabId: string }
  | { kind: 'subagent'; tabId: string; messageId: string }

/** What a pane shows until the user closes/replaces it. */
export type BaseContent = /* conversation | plan | work | automation | review
                             | pr-review(-loading) | pages | empty */

export class PaneViewStore {
  /** Main (left) pane. { kind: 'conversation' } = the active chat pool. */
  primaryContent = $state<BaseContent>({ kind: 'conversation' })
  /** Long-lived occupant of the right pane (split chat, artifact, PR review). */
  secondaryContent = $state<BaseContent>({ kind: 'empty' })
  /** Temporary viewer covering the right pane; null when none. */
  secondaryOverlay = $state<OverlayContent | null>(null)
  /** Which pane owns keyboard input: composer caret + per-session shortcuts. */
  focusedPane = $state<PaneSlot>('primary')

  /** What the right pane actually renders. */
  get secondaryVisible(): BaseContent | OverlayContent {
    return this.secondaryOverlay ?? this.secondaryContent
  }

  showOverlay(content: OverlayContent): void   // pop a viewer over the right pane
  closeOverlay(): void                          // dismiss it; secondaryContent reappears
  openSplitChat(tabId: string): void            // pin a chat into the right pane, focus it
  focusPane(slot: PaneSlot): void               // no-op if the slot has no chat
  chatTabIn(slot: PaneSlot, activeTabId: string): string | null
  // geometry state unchanged: secondaryWidth/Ratio, hasResized, maximized,
  // prReviewTab, reviewMode* — plus existing helpers kept as thin wrappers.
}
```

---

## WP1 — Pane model: overlay + focus + explicit chat resolution

**Must land first; everything depends on it. Single agent.**

**Files:** `src/renderer/contexts/pane-view.store.svelte.ts` (rewrite to the contract above), plus call-site updates in: `workspace.context.svelte.ts`, `workspace-ui.store.svelte.ts`, `session-plan-operations.ts`, `work-stream-tracker.svelte.ts`, `PillLayout.svelte`, `App.svelte`, `ProjectPanel.svelte`, `PlanMessageItem.svelte`, `WorkspaceBody.svelte`, `Pane.svelte`, and `client/src/components/WebLayout.svelte` (grep `panes.` to enumerate).

**Behavior:**
- `openSplitChat(tabId)`: set `secondaryContent = { kind: 'conversation', tabId }`, clear overlay, `focusPane('secondary')`.
- `showOverlay(content)`: set `secondaryOverlay`; reset geometry per content kind exactly as today (diff ratio 0.6, etc.). Never touches `secondaryContent` — **this is the eviction fix**.
- `closeOverlay()`: clear overlay; if `secondaryContent` is `empty`, run today's `closeSecondary()` geometry reset. All existing close-diff/files/subagent paths route here.
- `closeSecondary()`: clears overlay **and** content (pane ✕, pr-review teardown); resets `focusedPane` to `primary`.
- Keep `enterDiff` / `toggleDiff` / `openFiles` / `openFilePreview` / `openSubagent` as thin wrappers over `showOverlay` (same names; call sites mostly just gain `sourceTabId`). Keep `setArtifact`, `openPage`, `enterPrReview*`, `rekeyWork`, `activePlanId` / `activeWorkId` getters working against `primaryContent` / `secondaryContent` (pill + web depend on them).
- Delete rules the overlay model obsoletes (e.g. "P1 — entering Focus closes a diff"; `enterDiff` no longer juggles the review companion by clobbering the slot).
- Replace the `slots` array + `primary`/`secondary` getters with the named fields; update `WorkspaceBody`'s `displayedSecondaryContent` plumbing to render `secondaryVisible`.

**Acceptance:** build passes; with no split chat, diff/files/file-preview/subagent behave exactly as before; with a split chat open, opening then closing a diff restores the chat.

## WP2 — Targeted focus routing

**Depends on WP1. Files:** `lib/inputFocus.ts`, `input/InputBar.svelte`, `workspace.context.svelte.ts`, `conversation/ConversationPane.svelte`, `layout/WorkspaceBody.svelte`.

1. `requestInputFocus(target?: { tabId?: string })` — target rides `CustomEvent.detail`. No target = "the focused pane's composer".
2. `InputBar.svelte:366–379`: replace the `isPrimary` gate. Handle the event when `detail.tabId === targetTabId`, or when no detail and this bar belongs to `panes.focusedPane` (primary bar: `tabId === undefined` && focusedPane `'primary'`; split bar: `tabId === panes.chatTabIn('secondary', …)` && focusedPane `'secondary'`).
3. Re-gate quote-selection (`:345`) and `pendingInput` (`:353`) the same way: deliver to the focused pane's composer, falling back to primary.
4. Maintain `focusedPane` from real focus: `onfocusin` on the split pane root → `focusPane('secondary')` (in `ConversationPane`); `onfocusin` within the primary column's pool/input dock → `focusPane('primary')` (in `WorkspaceBody`).
5. `openTabInSplit` (`workspace.context.svelte.ts:684`) and the `global.new-split-chat` handler (`WorkspaceBody.svelte:241`) end with `requestInputFocus({ tabId })`. **Flagship fix — verify first.**
6. Add `get focusedChatTabId()` on the workspace context = `panes.chatTabIn(panes.focusedPane, this.activeTabId)`. Sweep `useKeybinding(` call sites; re-point per-session actions (fork, continue-in-worktree, stop/cancel, diff toggle) from `activeTabId`/`activeTab` to `focusedChatTabId`. App-scope bindings (sidebar, panels, new tab, mode switch) unchanged.

**Acceptance:** ⌥⇧/ opens a split chat and typing lands in it; quoting while the split is focused inserts into the split composer; ⌥F focused-in-split forks the split session; all still target the main chat when primary is focused.

## WP3 — Tab selection semantics + strip awareness

**Depends on WP1+WP2. Files:** `workspace.context.svelte.ts`, `layout/TabStrip.svelte` (+ `TabStrip.css`), `layout/WorkspaceBody.svelte`.

1. `setActiveTab` (`workspace.context.svelte.ts:267–279`): remove the "activating a split tab closes the split" branch. In `selectTab`: if `tabId === panes.chatTabIn('secondary', …)` → `panes.focusPane('secondary')` + `requestInputFocus({ tabId })` and return (do not change `activeTabId`).
2. `TabStrip.svelte`: compute `splitTabId`; render a small `ColumnsIcon` before that tab's label in **both** grouped and flat branches (one addition inside the `tabInner` snippet), tooltip "Open in split pane". Distinct focused treatment when `focusedPane === 'secondary'` (variant in `TabStrip.css`; dark + light). Context menu: on the split tab show "Close Split" (`panes.closeSecondary()`) instead of "Open in Split"; on other tabs "Open in Split" replaces the current split chat (intentional, keep).
3. `visibleTabIds` (`WorkspaceBody.svelte:101`): always include `splitTabId` even when its branch key differs — fixes the orphaned-tab edge case.
4. Keep `openTabInSplit`'s neighbor-activation when splitting the active tab; focus goes to the split composer (WP2 §5).

**Acceptance:** clicking the split tab focuses the split (no layout collapse); the strip marks the split tab; a cross-branch split chat keeps its tab visible.

## WP4 — ConversationPane chrome parity

**Depends on WP1 (WP2 nice-to-have). Files:** `conversation/ConversationPane.svelte`, `ui/Pane.svelte`.

1. `Pane.svelte:429–443`: pass `onToggleSecondaryMaximize` through to `ConversationPane`.
2. Header (keep chrome-row height/seam vars): status glyph via `getStatusIcon` / `getAttentionState` from `lib/sessionUtils` (tab-strip visuals at `TabStrip.svelte:403–453` are the reference); `projectByline(sess)` in tertiary text after the title (truncates before the title does); maximize button (pattern from `SubagentPane`/`DiffPanel` headers); overflow menu (shadcn `dropdown-menu`): Fork Session, Continue in Worktree (hidden in a worktree), Open as main tab (via `promoteSplitToMainTab()` — sets `activeTabId`, closes the slot), Close split.
3. Empty state: when the split tab has no messages, a compact centered block — project name + branch (`sess.gitContext`), model label, "start typing" hint. In `ConversationPane` or sibling `SplitChatEmpty.svelte`; do **not** touch `ConversationView` internals.

**Acceptance:** running/waiting visible in the header; maximize works; fork/worktree reachable; new split chat isn't a blank void. Both themes.

## WP5 — Split-session git surfaces

**Depends on WP1+WP2. Files:** `ui/Pane.svelte`, `conversation/ConversationPane.svelte`, `layout/WorkspaceBody.svelte`, prop-only tweaks in `diff/DiffPanel.svelte`, `files/FilesPane.svelte`, `files/FileEditorPane.svelte`; `lib/filePreview.ts` if its event lacks a tab.

1. Overlay content carries `sourceTabId` (WP1). Update `Pane.svelte` diff/files/file-editor branches (`:374`, `:392`, `:404`) to resolve `tab`/`sess` from `content.sourceTabId`, not `session.activeTabId`.
2. Populate `sourceTabId` at every open site: conversation `onDiffToggle`, `global.toggle-diff` / `global.toggle-files` (use `focusedChatTabId`), file-preview requests, subagent pop-out (already has `tabId`).
3. `ConversationPane` passes `onDiffToggle` into its `ConversationView` (currently omitted — the split orb's diff affordance is dead): opens the diff overlay with the **split** session's `sourceTabId`. The overlay replaces the split-chat view in the same slot and restores it on close; do not invent a third pane.
4. `WorkspaceBody.svelte:71–74`: `secondaryVisible` currently gates diff on the *active* tab's `workingDirectory` — re-gate on the `sourceTabId` session.

**Acceptance:** the split session's diff is viewable from its orb and from ⌥-diff while the split is focused; closing returns to the chat; primary-chat diff unchanged.

## WP6 — Entry points + persistence

**Parallel-safe with WP4/WP5. Files:** `session/SessionSidebar.svelte` (+ item context menu), `layout/NewTabHome.svelte`, `contexts/settings.context.svelte.ts`, layout boot site (`App.svelte`).

1. Session sidebar: context-menu item (+ hover icon-button if the row pattern has one) "Open in split" — open the session into a tab without activating (the `global.new-split-chat` path), then `openTabInSplit(tabId)`.
2. `NewTabHome`: secondary action "New split chat (⌥⇧/)".
3. Persistence: one settings key `{ splitTabId, secondaryRatio }`; on boot, if the tab still exists, `openSplitChat` restore. Overlays are never persisted. Minimal, guarded.

**Acceptance:** sidebar sessions can open straight into the split; relaunch restores an open split chat.

---

## Sequencing

```
WP1 ──► WP2 ──► WP3 ──► (WP4 ∥ WP5 ∥ WP6)
```

WP1–WP3 strictly sequential (same files/contract). WP4/5/6 parallel **only in isolated worktrees** — WP4 and WP5 both touch `Pane.svelte`/`ConversationPane.svelte`; if not isolated, run WP5 then WP4. One commit per package; `bun run build` before committing; keep new logic in colocated `lib/` files (`workspace.context.svelte.ts` is already large — flag >600 lines, hard-split >1000).

**Final integration check:** ⌥⇧/ types into the split · file-preview no longer destroys the split · strip click focuses instead of collapsing · split header shows running state · split diff opens and restores.
