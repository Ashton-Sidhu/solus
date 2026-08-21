# Renderer — architecture rules

- **Every feature is a folder.** Components live beside their feature, never at `components/` root. Promote to `components/ui/` only on the *second unrelated* importer.
- **Keep logic out of `.svelte`.** Parsing, math, formatting, algorithms → sibling `lib/*.ts` or `*.svelte.ts`. `.svelte` holds markup + thin handlers.
- **Load external renderer data through stores.** Components should not call host API loaders directly when the result is durable domain state, shared by more than one surface, cacheable, refreshable, or provider-backed. Put that state and its stale-guard/cache logic in a colocated `*.store.svelte.ts` or the existing feature store (`tasks`, `prs`, `works`, etc.), then let `.svelte` files read store state and trigger store methods. Keep truly ephemeral interaction data local: one-off file picker navigation, debounced autocomplete/search results, modal form drafts, and single-use command actions do not need stores.
- **Keep Tailwind visible in markup.** Static Tailwind class lists belong inline on the element. Don't hide them in TS string constants or CSS variables just to shorten markup; extract only when the class choice is real component state or shared across unrelated importers.
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
- **Any stock utility re-declaring a property beats a custom `@utility`.** Custom utilities compile early in the sheet. In v4 *any* `ring-*` — including the `ring-0` every menu passes — re-emits `box-shadow` as Tailwind's composite from a much later byte offset, which blanked `menu-surface` entirely. Feed the `--tw-*` variable (`--tw-shadow`) as well as the property, so the value flows through the composite instead of being replaced by it. Verify with byte offsets in `dist/renderer/assets/*.css`, not by reasoning.

## When a control overlaps, clips, or "only breaks in a split", the container is lying

**Width is declared by the container a surface renders in — never by the window.** `WorkspaceBody` splits the window into a sidebar pane, a primary pane, and a companion pane, each independently resizable and collapsible. A pane's floor is 25% of the split (`layout/lib/workspace-body.ts`), so the primary pane is legally ~356px on a 1440px window. Every window-width reading inside a pane is wrong by that much. Full plan and audit: `docs/plans/responsive-surfaces.md`.

Three axes exist. Two are facts, one is a lie:

- `html.is-laptop-display` — the **monitor** (ADR-0010). Correct. Use for non-type geometry.
- `@media (pointer: coarse)` — the **hand**. Correct.
- `runtime.isMobileViewport` / `isCompactViewport` / `window.innerWidth` / `vw` — the **OS window**. Correct only for portalled overlays positioned against the window (tooltip, menu, toast, command palette, orb). Anywhere else it is a bug waiting for someone to open a companion pane.

Reach for `@container` + `cqi`/`cqw`. Named containers are `pane` (`.primary-column`, `.secondary-pane-wrap`), `composer` (the input card), `rail` (`.side-panel-root`). `SessionBreadcrumb.svelte` and `ProjectPanel.svelte` are the reference implementations.

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
