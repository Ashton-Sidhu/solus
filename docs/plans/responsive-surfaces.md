# Responsive Surfaces: Width Is Declared By Containers

**Goal:** make every renderer surface size itself against **the box it renders
in**, not against the OS window. One rule replaces three disagreeing width
axes, so a surface narrows identically whether the cause is a phone, a laptop,
or a companion pane opening beside it.

**Status:** not started. The audit below is complete and its numbers are current
against `main` (August 2026). The reported defect — composer controls that
overlap and a send button that gets clipped when a companion pane is open — is
reproduced by arithmetic in "The reported defect" below, not yet by a rendered
pass.

## Vocabulary (locked — do not invent synonyms)

- **Display class** — a fact about the **monitor**. Published as
  `html.is-laptop-display` from `contexts/app/viewport.ts`, keyed on
  `screen.width` and the zoom factor (ADR-0010). Legitimate. Not in scope.
- **Pointer class** — a fact about the **hand**. `@media (pointer: coarse)` /
  `(any-pointer: fine)`. Legitimate. Not in scope.
- **Window width** — a fact about the **OS window**. Today read as
  `runtime.isMobileViewport` (767px), `runtime.isCompactViewport` (1100px),
  `windowCtx.workAreaWidth`, `window.innerWidth`, and `vw` units. **This axis is
  being deleted from `components/`.** It survives in exactly one place —
  `window.context.svelte.ts` choosing pill vs editor **shell** — because that is
  a question about which window to render, not about layout.
- **Container** — the box a surface actually occupies, declared with
  `container: <name> / inline-size` and queried with `@container` /
  `cqi` / `cqw`. **The only legal way for a surface to learn its width.**
- **Named containers** — exactly three, defined once each:
  - **`pane`** — a workspace pane. Declared on `.primary-column` and
    `:global(.secondary-pane-wrap)` in `WorkspaceBody.svelte`.
  - **`composer`** — the input card. Declared on the card in
    `EditorInputCard.svelte`.
  - **`rail`** — a side panel. Declared on `.side-panel-root` in
    `SidePanel.svelte` (which is already an unnamed `@container`).
  Do not add a fourth without adding it here first. Unnamed `@container` is
  forbidden in new code: in a nested pane tree it resolves to whichever ancestor
  happens to be nearest, which is a coin flip.
- **Disclosure ladder** — an ordered, declared list of what a control row drops
  as its container narrows, widest rung first. A ladder is **declared**, never
  arbitrated by flexbox. Each rung hides; nothing unmounts.
- **Floor** — the narrowest width at which a surface is still itself. Below the
  floor a surface is not "degraded", it is absent. The composer's floor is
  text well + mic + send.
- **Spill** — a leaf control shrunk below its content while its rigid children
  keep their size, so they paint outside its border box and over a neighbour.
  This is the defect class the reported bug belongs to. Not "overflow" — an
  overflowing row is visible and honest; a spilling control lies about its box.
- **Rigid child** — a descendant carrying `shrink-0` / `flex-shrink-0`. A leaf
  with `min-w-0` and one or more rigid children and no overflow clip **will**
  spill. That triple is the lint rule in WP1.

**Verify after every work package:** `bun run build`, plus
`bun test tests/unit/composer-disclosure-ladder.test.ts` and
`bun test tests/unit/pane-width-honesty.test.ts` once WP1/WP3 land. Do not start
a dev server. A rendered pass over Editor mode (companion open, primary dragged
to its floor), Pill mode, and the mobile web client is required before WP5 is
called done, and needs the developer's agreement.

**House rules (from CLAUDE.md — binding):** static Tailwind stays visible inline
in markup; logic in sibling `lib/*.ts`; light **and** dark mode; every change
lands on desktop, web, and mobile together; surgical diffs; delete orphaned code;
never `git stash`.

---

## Background: why (audit, August 2026)

### The three axes, and what each actually measures

| Axis | Source | Measures | Verdict |
|---|---|---|---|
| `is-laptop-display` | `contexts/app/viewport.ts:19` | the monitor | correct, keep |
| `pointer: coarse` | `index.css:473`, `:1092` | the input device | correct, keep |
| `isMobileViewport` (767px) | `contexts/app/runtime.svelte.ts:12` | the OS window | **wrong inside a pane** |
| `isCompactViewport` (1100px) | `contexts/app/runtime.svelte.ts:16` | the OS window | **wrong inside a pane** |
| `workAreaWidth` / `innerWidth` | `window.context.svelte.ts:29`, 8 call sites | the OS window | **wrong inside a pane** |
| `vw` units | 129 occurrences in `components/` | the OS window | **wrong inside a pane** |

None of the last four describe the box a component renders in. `WorkspaceBody`
splits the window into a sidebar pane, a primary pane, and a companion pane,
each independently resizable and collapsible — and then every component inside
still asks the window how wide it is.

### The window is a lie in the common case, not the exotic one

`PRIMARY_PANE_MIN_SIZE = 25` (`layout/lib/workspace-body.ts:17`) — the primary
pane's floor is **25% of the split**, expressed as a percentage because PaneForge
keys its `autoSaveId` layout by the constraints (`WorkspaceBody.svelte:616-621`).
Opening a companion also auto-collapses the session sidebar
(`WorkspaceBody.svelte:541`), so the split is nearly the whole window.

| Window | Split | Primary at its floor |
|---|---|---|
| 1280 | ~1264 | **316px** |
| 1440 | ~1424 | **356px** |
| 1920 | ~1904 | **476px** |

Two constants in the same file already disagree about this:
`MIN_PRIMARY_PANE_WIDTH = 400` (`workspace-body.ts:5`) states the real floor in
pixels, but it is only consumed by the project-rail arithmetic
(`project-panel/lib/rail-width.ts:15,45`). The pane itself is never held to it.

### The reported defect

`EditorInputCard` → `InputBar` → `InputToolbar` is one non-wrapping flex row
with no reflow strategy at all (`InputBar.svelte:1281`):

```svelte
<div class="flex w-full items-center gap-2" style="zoom:var(--solus-font-scale,1)">
  {@render leadingActions(savedPromptsControl)}
  <div class="ml-auto flex shrink-0 items-center gap-1">{@render actionButtons()}</div>
</div>
```

Minimum content, editor mode:

| Control | Min width | Shrinks? |
|---|---|---|
| `AddFilesButton` (`:36`) | ~30px | yes, unguarded — no `shrink-0` |
| `PermissionModePicker` (`:107`) | ~79px | **no** — no `min-w-0`, label at `:113` has no `truncate` |
| `SessionChip` (`:363`) | ~123px | **to zero** — `min-w-0`, no overflow clip, 4 rigid children |
| `SavedPromptsControl` (`:235`) | ~30px | `shrink-0` |
| `ContextMeter` (`:106`) | ~86px | effectively no |
| mic + send | ~64px | `shrink-0` |
| 6 × `gap-2` | ~40px | — |
| **total** | **~452px** | |

Available inside a 356px pane: `356 − 8` (pane gutter, `WorkspaceBody.svelte:879`)
`− 32` (input dock `px-4`, `:768`) `− 24` (card `px-3`,
`EditorInputCard.svelte:73`) = **292px**. Short by ~160px. Two failures follow:

1. **Spill.** `SessionChip.svelte:363` carries `min-w-0` with `overflow: visible`.
   Per the flexbox automatic-minimum-size rule, `min-width: 0` lets the button box
   shrink past its content, but its rigid children — brand glyph, reasoning label,
   caret — keep their size and paint outside the border box, over the neighbour.
   `PermissionModePicker.svelte:107` has the mirror-image defect: it refuses to
   shrink at all and shoves everything right.
2. **The send button is clipped.** `ml-auto` is inert once a row overflows, so
   mic/send are pushed past the card edge and cut off by `overflow-hidden`
   (`EditorInputCard.svelte:73`) plus `contain: layout paint`
   (`InputBar.svelte:1233`).

**`zoom` compounds it.** `zoom: var(--solus-font-scale,1)` on that row means the
row and any container query on the card measure in **different coordinate
spaces**: at a 1.15 text preference a 26rem card holds ~22.6rem of row. A ladder
written against the card would fire at the wrong widths.

### Spill is a class, not an incident

A scan of every `<button>` / `<a>` in `components/` for the triple
(`min-w-0` + no overflow clip + ≥1 rigid child):

**19 spill-risk leaves.** Ranked by rigid-child count:

| Leaf | Rigid children |
|---|---|
| `ui/list-page/ListRow.svelte:66` | 9 |
| `pickers/SessionChip.svelte:363` | 4 |
| `layout/StatusBarControls.svelte:300` (branch button) | 4 |
| `project-panel/AutomationsSection.svelte:94` | 4 |
| `ui/list-page/ListRailRow.svelte:76` | 4 |
| `conversation/agent-conversation/AgentConversationSwitchboard.svelte:267` | 2 |
| `automations/AutomationRow.svelte:99` | 2 |
| `search/FilePickerOverlay.svelte:195` | 2 |
| 11 others | 1 each |

Two of the top three are in the composer row.

### The right answer already exists in the codebase, unnamed

23 files already use `@container` correctly — `SessionBreadcrumb.svelte:431`
(`@container` plus `max-w-[clamp(6rem,16cqw,12rem)]`), `ProjectPanel.svelte:583`
(`@container (max-width: 17rem)`), `SessionSidebar`, `TaskPage`, `PrReviewPane`,
`PlanModal`, `DocumentModal`. It was never made a rule, so the composer,
Settings, Diff and Files never got it. Every one of those 23 uses an **unnamed**
container.

### Window-width readers inside `components/`

28 files, 53 occurrences. The ones that are wrong because the surface is
pane-hosted:

| File | Reads | Why it is wrong |
|---|---|---|
| `settings/SettingsPage.svelte:440` | `w-[clamp(18.75rem,24vw,22.5rem)]` | `settings` is in `FLUSH_PAGES` (`WorkspaceBody.svelte:447`) — it **does** open as a companion, where a 360px nav rail leaves ~40px of content |
| `diff/DiffPanel.svelte:289,1160` | `isMobileViewport` | gates the mobile file tree on window width; a 380px diff pane on a 27" display never gets it |
| `diff/DiffStream.svelte:57` | `isMobileViewport` / `isCompactViewport` | same |
| `files/FilesPane.svelte:214,415` | `isMobileViewport` | same |
| `document-shell/DocumentShell.svelte` | `@media (max-width: 767px)` | a work opened in a companion pane |
| `conversation/ConversationView.svelte`, `UserMessageBubble.svelte` | `isMobileViewport` | the transcript is always pane-hosted |

Legitimately viewport-anchored and **staying**: `ui/Dropdown.svelte:43`,
`ui/tooltip`, `command-palette`, `ActionOrb.css`, `comments/CommentLayer.svelte`,
`input/UnifiedAutocompleteMenu.svelte:74`, toasts — these are portalled overlays
positioned against the window, which is the correct frame for them.

`layout/TabStrip.css:122,154` (`15vw` / `24vw`) is **not** an offender today:
`TabStrip` is imported only by `PillLayout.svelte:3`, where the pill window is
the container. It becomes one the moment the strip is reused. Leave it; note it.

### Enforcement precedent

CLAUDE.md documents `bun run lint:hosts` (`scripts/check-host-discipline.ts`) and
`bun run lint:types` (`scripts/check-precise-object-types.ts`) as the way a
structural rule is made unbreakable. Neither is wired into the root
`package.json` on `main` — both currently live in
`.claude/worktrees/pr-commit-viewer`. The layout checker should land alongside
them and all three should be wired into `test` together.

---

## Locked design decisions (do not re-litigate)

1. **A component's width behaviour is declared by the container it renders in,
   never by the window.** This is the whole plan; everything below follows.
2. **The display and pointer axes stay exactly as they are.** ADR-0010 is right
   about them. Only the window-width axis is deleted.
3. **`MOBILE_QUERY` survives in `window.context.svelte.ts` only**, to choose the
   pill vs editor shell. It is removed from `runtime.svelte.ts` and from every
   `components/` call site.
4. **Three named containers, no more:** `pane`, `composer`, `rail`. A fourth
   requires an edit to the Vocabulary section above, first.
5. **Portalled overlays keep viewport units.** A tooltip, menu, toast, palette,
   or orb popover is positioned against the window; that is correct, and the
   allowlist in the checker is how it stays correct.
6. **Ladders hide, they never unmount.** `display: none` per the renderer's
   mount-once rule — a control that unmounts loses its state and pays a
   re-mount on every drag frame.
7. **Mic and send never appear in a hide rule.** They are the composer's
   reverse-state guarantee: whatever else goes, you can still send and still
   stop dictating.
8. **At the narrow rungs the permission and model chips hide rather than fold
   into an overflow menu.** Both already have `⌥` shortcuts and command-palette
   entries. An overflow button is new machinery for a state that lasts as long
   as a drag. *(Open call — see WP3.)*
9. **The checker's spill rule is the triple, not `min-w-0` alone.** `min-w-0` on
   a flex *container* is correct and necessary — it delegates truncation to a
   descendant. Only an interactive **leaf** with rigid children and no clip is a
   defect. 566 `min-w-0` sites; 19 are defects.

---

## WP1 — The checker, first

Nothing else lands until the failure list is machine-generated. A
hand-assembled inventory goes stale the day it is written.

`scripts/check-layout-discipline.ts`, same shape as `check-host-discipline.ts`.
Three rules over `packages/workspace-ui/src/components/`:

1. **Spill** — an interactive leaf (`<button>`, `<a>`) whose class list contains
   `min-w-0`, carries no `overflow-hidden` / `overflow-clip`, and contains at
   least one `shrink-0` / `flex-shrink-0` descendant.
2. **Viewport units** — any `vw` / `vh` outside the portalled-overlay allowlist
   (§ Locked decision 5).
3. **Window reads** — `window.innerWidth`, `runtime.isMobileViewport`,
   `runtime.isCompactViewport`, `windowCtx.workAreaWidth`.

Wire `lint:layout` into `package.json` `test`, together with `lint:hosts` and
`lint:types`, which are missing from root today.

**Deliverable:** the checker, red, with its output pasted into this file as the
WP4 work queue.

## WP2 — Declare the three containers

- `WorkspaceBody.svelte` — `container: pane / inline-size` on `.primary-column`
  and `:global(.secondary-pane-wrap)`. Both already publish
  `--solus-pane-chrome-inset` (`:901`), so they are already the acknowledged
  pane boundary; this makes them the measured one too.
- `EditorInputCard.svelte` — `container: composer / inline-size` on the card.
- `SidePanel.svelte:82` — name its existing `@container` `rail`.
- Migrate the 23 existing unnamed `@container` users to the named form where
  they sit inside one of the three; leave genuinely local ones (`PlanModal`,
  `DocumentModal`, `SchemaSheet`) unnamed but add a one-line comment saying why.

No behaviour change in this WP. It is the contract.

## WP3 — The composer ladder (fixes the reported defect)

**Remove `zoom` from the toolbar row** (`InputBar.svelte:1283`) first, or the
ladder measures in the wrong coordinate space. The row's type comes from the
`text-workspace-chrome` rung instead, which is what ADR-0013 says surfaces
should do anyway. Check `tests/unit/input-toolbar-typography.test.ts` still
passes.

Compute the floor, then declare rungs upward from it. **Floor = text well +
mic + send ≈ 9rem.**

| Composer width | Drops |
|---|---|
| ≥ 34rem | everything (today's layout) |
| < 30rem | saved-prompts control |
| < 26rem | reasoning label on the model chip |
| < 22rem | context meter / status cluster |
| < 18rem | permission picker → icon-only (`compact` prop exists, `PermissionModePicker.svelte:38`) |
| < 15rem | model chip → brand glyph only |

```svelte
<!-- InputToolbar.svelte -->
<div class="flex min-w-0 flex-1 items-center gap-2">
  <AddFilesButton class="shrink-0" … />
  <PermissionModePicker compact={…} … />
  <SessionChip … />
  <div class="@max-[30rem]/composer:hidden">{@render savedPromptsControl?.()}</div>
  <div class="ml-auto flex min-w-0 items-center @max-[22rem]/composer:hidden">
    <StatusBarControls … />
  </div>
</div>
```

Fix the two composer spill leaves as part of this (`SessionChip.svelte:363`,
`StatusBarControls.svelte:300`) — not as a patch, but because the ladder is what
makes their `min-w-0` meaningful in the first place.

The same ladder serves Pill mode and the phone unchanged, because a container
query does not care *why* it got narrow. That is the payoff: one rule, three
causes.

**Open call (decision 8).** If the chips should stay pointer-reachable at 15rem
rather than hiding, that is an overflow button and roughly a day more work.
Decide before this WP starts; do not build both.

## WP4 — Burn down the checker's list

One PR per surface, in this order (widest blast radius first):

1. `settings/SettingsPage.svelte` — nav rail to `cqi`, collapse under
   `@max-[48rem]/pane`
2. `diff/DiffPanel.svelte`, `diff/DiffStream.svelte`,
   `diff/DiffResizableContent.svelte`
3. `files/FilesPane.svelte`
4. `conversation/ConversationView.svelte`, `UserMessageBubble.svelte`
5. `document-shell/DocumentShell.svelte`
6. The remaining 17 spill leaves — mechanical: add `overflow-hidden`, confirm
   the truncating child, delete any `min-w-0` that was never load-bearing
7. Delete `isMobileViewport` and `isCompactViewport` from
   `runtime.svelte.ts` once the last reader is gone. If a field has no readers
   left, the field goes — that is the proof the migration finished.

## WP5 — Portalled menus fit their anchor

`SessionChip.svelte:417` is `w-[452px]`; `GitDropdown.svelte:187` is
`w-[316px]`; `ContextMeter.svelte:139` is `w-[17rem]`. Anchored in a 356px pane
these meet or exceed the pane. Convert to
`w-[min(28.25rem,calc(100vw-2rem))]` — the pattern `SessionBreadcrumb.svelte:473`
already uses — and give `DropdownMenu.Content` a default `collisionPadding` so
this stops being a per-call-site decision.

## Tests

- **`tests/unit/composer-disclosure-ladder.test.ts`** — asserts each rung exists
  at its declared width, and that no ancestor of the mic or send button carries
  an `@max-*:hidden` at any rung. That second assertion is the one that encodes
  *why* the ladder matters: it fails the moment someone makes send droppable.
- **`tests/unit/pane-width-honesty.test.ts`** — a thin wrapper over the WP1
  checker so the rule is enforced by `test:unit` as well as by `lint`.
- Threshold arithmetic goes in `lib/*.ts` and is unit-tested there, following
  `project-panel/lib/rail-width.ts` and `tests/unit/project-rail-width.test.ts`.

## Surfaces this touches

- **Clients:** all three, and identically — container queries are plain CSS, so
  desktop, web, and mobile get one implementation with no per-client branch.
- **Modes:** Editor and Pill both, via the same composer ladder.
- **Providers:** none. Nothing here is provider-shaped.
- **Contracts:** none. No RPC or shared-type change.
- **Docs:** this file, plus the "container is lying" playbook in
  `packages/workspace-ui/CLAUDE.md`. Cut ADR-0018 from the Locked Design
  Decisions section when WP2 lands — not before, so the ADR records a decision
  that shipped rather than one that was proposed.
