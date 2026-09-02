# Renderer — architecture rules

- **Every feature is a folder.** Components live beside their feature, never at `components/` root. Promote to `components/ui/` only on the *second unrelated* importer.
- **Keep logic out of `.svelte`.** Parsing, math, formatting, algorithms → sibling `lib/*.ts` or `*.svelte.ts`. `.svelte` holds markup + thin handlers.
- **Load external renderer data through stores.** Components should not call host API loaders directly when the result is durable domain state, shared by more than one surface, cacheable, refreshable, or provider-backed. Put that state and its stale-guard/cache logic in a colocated `*.store.svelte.ts` or the existing feature store (`tasks`, `prs`, `works`, etc.), then let `.svelte` files read store state and trigger store methods. Keep truly ephemeral interaction data local: one-off file picker navigation, debounced autocomplete/search results, modal form drafts, and single-use command actions do not need stores.
- **Keep Tailwind visible in markup.** Static Tailwind class lists belong inline on the element. Don't hide them in TS string constants or CSS variables just to shorten markup; extract only when the class choice is real component state or shared across unrelated importers. `solus/no-tailwind-class-variables` rejects a static utility list declared as a `const`/`let` in a `.svelte` or `.svelte.ts` file; a genuinely shared list belongs in a colocated `lib/*-styles.ts` module.
- **Shared primitives are shadcn-svelte.** Stock generated components live in kebab-case folders under `components/ui/` (`button/`, `select/`, …) — never edit them; Solus colors flow through the variable bridge in `index.css` (shadcn `primary` = brand accent/terracotta, shadcn `accent` = subtle hover wash). Add new primitives with `bunx shadcn-svelte@latest add <name>`. When touching a file, migrate hand-styled elements that visually read as a shadcn primitive (button, select, switch, toggle, …) to it; keep a raw `<button>` only for semantic-only interactive elements (tabs, list rows, cards, tree items). PascalCase files in `ui/` are legacy bespoke primitives — migrate away opportunistically, never add new ones.
- `lib/` is colocated per-feature. Only cross-feature utils go in `src/renderer/lib/`.
- Flag any file > 600 lines in review. Hard-split > 1000 lines.
- `SvelteMap` / `SvelteSet` for reactive maps/sets. Use `$effect` only when `$derived` genuinely can't — no exceptions.

## When a token "looks wrong", check whether it ever applied

A class can be defined correctly and still never reach the DOM — no build error, no warning, nothing in the markup. Read the compiled class list before re-tuning a value. `bun run test:unit` guards all four; `lib/utils.test.ts` explains each.

- **Custom `@theme` keys are invisible to tailwind-merge.** It guesses the property group of anything outside Tailwind's stock scales — usually colour — and deletes the class against a same-prefix neighbour. `text-menu` was dropped by the `text-(--solus-text-secondary)` beside it on every menu row. Register the key in `twMergeConfig` in `lib/tw.ts`, and import `cn`/`tv` from there — never from `tailwind-merge`/`tailwind-variants`, which shadcn-svelte generates on every `add`.
- **A breakpoint- or `!`-prefixed class is its own merge group.** A primitive's `md:text-sm` or `text-xs!` survives a call site's `text-[…]` and then wins the cascade, so the call site's size never applies. Write primitive *defaults* unprefixed and un-`!`; where a primitive legitimately re-sizes at a breakpoint (`Popover.Content` has `lg:text-base`), the call site must restate its own size at that breakpoint too.
- **`shadow-[var(--x)]` is ambiguous, so it does not override `shadow-md`.** tailwind-merge files it under shadow-*colour*; both classes survive, both set `--tw-shadow`, and compiled sheet order decides. Add the type hint — `shadow-[shadow:var(--x)]`, `text-[color:…]` — which classifies correctly and evicts the stock class. Those hints are load-bearing; don't "simplify" them.
- **Unlayered CSS beats every utility, at any specificity.** Cascade layers are resolved before specificity, so a bare element reset in `index.css` outranks the whole `@layer utilities`. A plain `textarea { font-size: inherit }` silently ate the `text-xs` on every textarea in the app — the shadcn primitive's own default included — so each field took its parent's size instead. Element resets belong in `@layer base`; only rules that must win unconditionally stay unlayered. If a size "doesn't apply" and specificity looks fine, check the layer before adding an `!` marker.
- **`[.is-laptop-display_&]:` outranks the `pointer-coarse:` rung beside it, and every phone carries the class.** `.is-laptop-display` is toggled from `screen.width <= 1600` (`contexts/app/runtime.svelte.ts`), so a 390px phone and a 1024px tablet are both "laptop displays" — on web and mobile as much as on a small MacBook. The laptop variant is a descendant combinator, two selectors; `pointer-coarse:h-10` is one class inside a media query, and a media query adds no specificity. So the laptop value wins on a phone and the touch rung never applies, whichever is written last — `pointer-coarse:h-10` asked for a 40px target and the hand got `h-6.5`'s 26px. Fence the laptop value behind `pointer-fine:`, as `menu/menu-row.ts` does; do not reach for `!`, which is its own tailwind-merge group and would break call-site overrides. `lint:layout`'s `laptop-outranks-touch` rule rejects the unfenced pairing. A laptop value with *no* touch counterpart is not a defect — that is the author saying the small-display geometry suits a phone too.
- **A laptop rung written as a fixed `h-*` is a ceiling a call site cannot lift.** Same specificity story, one axis over: a primitive's plain `h-8` is evicted by a call site's `h-auto` through tailwind-merge, but `pointer-fine:[.is-laptop-display_&]:h-7` is a different merge group *and* two selectors, so it survives the override and clamps the row while its content still lays out — the second line paints outside the box, up through the row above. The publish menu's Confluence and Google Drive rows, which carry their "Connect in Settings…" reason on a second line, painted through the menu's own label this way. Every rung in `menu/menu-row.ts` is therefore `h-auto` + `min-h-*`: a floor, never a ceiling. A primitive that re-states the rung (`context-menu-item`, `context-menu-sub-trigger`) has to restate it as a floor too, or it merges the floor back out.
- **`[.is-laptop-display_&]:` outranks a container-query rung on the same property.** The descendant combinator makes it two selectors to the rung's one, so specificity decides and the monitor wins over the pane — no matter which is written last. A phone-width pane on a laptop display fires *both*: `ListPage`'s filter row kept `[.is-laptop-display_&]:h-[26px]` while `@max-[30rem]/pane:h-auto` was ignored, so the row wrapped onto two lines inside a 26px box and the list underneath painted straight through it. Where a rung and a laptop variant set the same property, mark the rung `!`. (Only here: `!` is otherwise its own tailwind-merge group and breaks call-site overrides.)
- **Any stock utility re-declaring a property beats a custom `@utility`.** Custom utilities compile early in the sheet. In v4 *any* `ring-*` — including the `ring-0` every menu passes — re-emits `box-shadow` as Tailwind's composite from a much later byte offset, which blanked `menu-surface` entirely. Feed the `--tw-*` variable (`--tw-shadow`) as well as the property, so the value flows through the composite instead of being replaced by it. Verify with byte offsets in `dist/renderer/assets/*.css`, not by reasoning.

## When a control overlaps, clips, or "only breaks in a split", the container is lying

**Width is declared by the container a surface renders in — never by the window.** `WorkspaceBody` splits the window into a sidebar pane, a primary pane, and a companion pane, each independently resizable and collapsible. A pane's floor is 25% of the split (`layout/lib/workspace-body.ts`), so the primary pane is legally ~356px on a 1440px window. Every window-width reading inside a pane is wrong by that much. Full plan and audit: `docs/plans/responsive-surfaces.md`.

Three axes exist. Two are facts, one is a lie:

- `html.is-laptop-display` — the **monitor** (ADR-0010). Correct. Use for non-type geometry.
- `@media (pointer: coarse)` — the **hand**. Correct.
- `runtime.isMobileViewport` / `isCompactViewport` / `window.innerWidth` / `vw` — the **OS window**. Correct only for portalled overlays positioned against the window (tooltip, menu, toast, command palette, orb). Anywhere else it is a bug waiting for someone to open a companion pane.

Reach for `@container` + `cqi`/`cqw`. The three workspace containers are `pane` (`.primary-column`, `.secondary-pane-content`), `composer` (all three composer cards — `EditorInputCard`, the pill card body in `PillLayout`, the draft card in `SessionDraftPane`), and `rail` (`.side-panel-root`). `SessionBreadcrumb.svelte` and `ProjectPanel.svelte` are the reference implementations. Four local names predate the plan and are fine where they are: `doc-shell`, `band`, `toolbar`, `stage`.

Two traps when you declare a container:

- **`container-type` makes the element the containing block for `position: fixed` descendants.** It applies layout containment, so a maximized surface inside it stops resolving `inset: 0` against the window. That is why `pane` sits on `.secondary-pane-content` — the element that itself goes fixed — and not on `.secondary-pane-wrap` around it.
- **A query against a container nobody declared never fires, and never warns.** Declaring a container therefore *activates* dead rules elsewhere. Grep for the name before you add it, and check what wakes up.

**When CSS cannot make the call** — a PaneForge `direction`, a pane size, a virtualiser's row height — use `lib/pane-width.ts` (`isStackedPane` / `isCompactPane`) against the surface's own `bind:clientWidth`, never `runtime.*`. Its two rungs are the same 30rem/48rem the stylesheet uses, deliberately: a surface that stacks at one width in CSS and another in JS has two layouts and no rule. If you move a JS metric to the pane, check whether a stylesheet mirrors it — `DiffStream`'s header heights mirror `diffTheme.ts`, and moving only one of them desyncs the virtualiser from what is painted.

**Most window reads are not width questions at all.** Before reaching for a container, ask what the code actually wants to know. In this codebase the honest answer was usually the hand or the keyboard: `stopsRun` wanted "is there an Escape key", a `⌥` hint wanted "are there keys to name", a hover rail wanted "is there hover", a 44px target wanted "is this a thumb". An iPad with a Magic Keyboard has a small window and a full keyboard; a phone in landscape has neither. Use `runtime.isTouchDevice` / `runtime.hasKeyboardPointer`.

**Hiding navigation means building its replacement in the same change.** Settings' nav rail collapses under `@max-[48rem]/pane`, which is only safe because the chip strip appears at `@min-[48rem]/pane`. Same number, opposite directions, one shared snippet — and a test asserting the reachable-destination count never changes.

`bun run lint:layout` enforces all of this over `components/`. Known failures live in `scripts/layout-discipline-baseline.json`, keyed by file and rule; the checker fails both on new failures and on baseline entries whose defect is gone, so it can never become a suppression file. `--list` prints the whole queue, `--update` records a win. Comment bodies are blanked before the window-read pass, so you can name `isMobileViewport` in the comment explaining what replaced it. The six remaining entries are shell choices and one approved product exception, not unmigrated defects — see `docs/plans/responsive-surfaces.md`.

### The four failure shapes, and which one you have

- **Spill — a control paints over its neighbour.** An interactive leaf (`<button>`, `<a>`) with `min-w-0`, no `overflow-hidden`, and at least one `shrink-0` child. `min-width: 0` lets the box shrink past its content, the rigid children keep their size, and they render outside the border box. The neighbour has no background at rest, so the two read as overlapping. **Fix:** add `overflow-hidden` to the leaf, `truncate` to its text child. That triple is rejected by `check-layout-discipline.ts`. `min-w-0` on a flex *container* is correct and necessary — it delegates truncation downward. Only leaves are defects.
- **Clip — a trailing control disappears.** `ml-auto` is inert once a row overflows, so `shrink-0` trailing controls get pushed past the card edge and cut off by an ancestor's `overflow-hidden` or `contain: paint`. **Fix:** the row needs a disclosure ladder, not a tighter gap. Never solve this by making the trailing control droppable — in a composer, mic and send are the reverse-state guarantee.
- **Shove — one control refuses to shrink and displaces everything.** A leaf with no `min-w-0` and an untruncated label. **Fix:** `min-w-0` *and* `overflow-hidden` together, never one without the other.
- **Stale branch — it looks right on your monitor and wrong in a pane.** A window-width read. **Fix:** container query.

### Fixing a row properly

1. **Compute the floor.** What must survive at the narrowest legal width? For the composer that is text well + mic + send ≈ 9rem. Below the floor the surface is absent, not degraded.
2. **Declare a ladder upward from the floor** — an ordered list of what drops at which container width, widest rung first. Declared, not arbitrated: flexbox decides who shrinks, and it decides badly.
3. **Hide, never unmount.** `@max-[30rem]/composer:hidden`, per the mount-once rule below. A control that unmounts loses its state and re-mounts on every drag frame.
4. **Check for `zoom`.** `zoom` puts an element in a different coordinate space from the container querying it, so a ladder written against the container fires at the wrong widths. Prefer the `text-workspace-chrome` rung (ADR-0013) over scaling a row with `zoom`.
5. **Check the portalled menu too.** A `w-[452px]` dropdown anchored in a 356px pane is the same bug one layer out. Use `w-[min(<n>rem,calc(100vw-2rem))]`.
6. **Assert the intent.** A layout test that only pins class strings cannot fail when the rule changes. Assert the thing that matters — e.g. that no ancestor of the send button carries a hide rule at any rung.

Do not fix any of these by nudging a gap, a padding, or a `max-w` until it looks right on your display. That is how all four shapes got here.

## `contexts/` — the barrel rule

State stores, foldered by domain. **Public surface = `contexts/index.ts`** (curated barrel); import authoritative stores from it. `workspace/` contents (reducer, transcript, bootstrap, registry, pane-view, …) are private organs — deep-import them only from boot files or for organ-local types.

`workspace/` holds the tabs/session core (`workspace.context.svelte.ts`, large).

## Variable naming

- **Name the meaning, not the mechanism or the history.** When a thing's purpose outgrows its name, rename it in the same change — the compiler catches every call site. (`artifactViewer` drifted into managing all panes and confused everyone until it became `panes`.)
- **Plain roles over jargon.** Prefer `BaseContent`/`OverlayContent` to `DurableContent`/`TransientContent`. If a reader needs a glossary to parse the name, pick a different word.
- **No abbreviations for domain objects.** `panes`, not `av`; `session`, not `sess` in new code. Conventional short names are fine where scope is a few lines (`i`, `e`, `el`).
- **One name per concept, everywhere.** Don't coin synonyms across files ("split chat" vs "pinned conversation" vs "secondary chat"). The canonical term lives where the concept is defined; feature plans in `docs/plans/` lock vocabulary before implementation.
- **Qualify ids and booleans.** An id says whose id it is (`sourceTabId` — the chat a viewer was opened for; `focusedChatTabId`), never a bare `id`/`tabId` where several are in play. Booleans read as assertions: `hasResized`, `isBusy`, `secondaryOpen`.
- **Methods read as commands, getters as answers.** `openSplitChat(tabId)`, `closeOverlay()`, `chatTabIn(slot)`.

## Svelte 5 performance (all tabs stay mounted; hidden via `display:none`)

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
