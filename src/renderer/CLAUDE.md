# Renderer — architecture rules

- **Every feature is a folder.** Components live beside their feature, never at `components/` root. Promote to `components/ui/` only on the *second unrelated* importer.
- **Keep logic out of `.svelte`.** Parsing, math, formatting, algorithms → sibling `lib/*.ts` or `*.svelte.ts`. `.svelte` holds markup + thin handlers.
- **Load external renderer data through stores.** Components should not call `window.solus.*` loaders directly when the result is durable domain state, shared by more than one surface, cacheable, refreshable, or provider-backed. Put that state and its stale-guard/cache logic in a colocated `*.store.svelte.ts` or the existing feature store (`tasks`, `prs`, `works`, etc.), then let `.svelte` files read store state and trigger store methods. Keep truly ephemeral interaction data local: one-off file picker navigation, debounced autocomplete/search results, modal form drafts, and single-use command actions do not need stores.
- **Keep Tailwind visible in markup.** Static Tailwind class lists belong inline on the element. Don't hide them in TS string constants or CSS variables just to shorten markup; extract only when the class choice is real component state or shared across unrelated importers.
- **Shared primitives are shadcn-svelte.** Stock generated components live in kebab-case folders under `components/ui/` (`button/`, `select/`, …) — never edit them; Solus colors flow through the variable bridge in `index.css` (shadcn `primary` = brand accent/terracotta, shadcn `accent` = subtle hover wash). Add new primitives with `bunx shadcn-svelte@latest add <name>`. When touching a file, migrate hand-styled elements that visually read as a shadcn primitive (button, select, switch, toggle, …) to it; keep a raw `<button>` only for semantic-only interactive elements (tabs, list rows, cards, tree items). PascalCase files in `ui/` are legacy bespoke primitives — migrate away opportunistically, never add new ones.
- `lib/` is colocated per-feature. Only cross-feature utils go in `src/renderer/lib/`.
- Flag any file > 600 lines in review. Hard-split > 1000 lines.
- `SvelteMap` / `SvelteSet` for reactive maps/sets. Use `$effect` only when `$derived` genuinely can't — no exceptions.

## When a token "looks wrong", check whether it ever applied

A class can be defined correctly and still never reach the DOM — no build error, no warning, nothing in the markup. Read the compiled class list before re-tuning a value. `bun run test:unit` guards all four; `lib/utils.test.ts` explains each.

- **Custom `@theme` keys are invisible to tailwind-merge.** It guesses the property group of anything outside Tailwind's stock scales — usually colour — and deletes the class against a same-prefix neighbour. `text-menu` was dropped by the `text-(--solus-text-secondary)` beside it on every menu row. Register the key in `twMergeConfig` in `lib/tw.ts`, and import `cn`/`tv` from there — never from `tailwind-merge`/`tailwind-variants`, which shadcn-svelte generates on every `add`.
- **A breakpoint- or `!`-prefixed class is its own merge group.** A primitive's `md:text-sm` or `text-xs!` survives a call site's `text-[…]` and then wins the cascade, so the call site's size never applies. Write primitive *defaults* unprefixed and un-`!`; where a primitive legitimately re-sizes at a breakpoint (`Popover.Content` has `lg:text-[0.9375rem]`), the call site must restate its own size at that breakpoint too.
- **`shadow-[var(--x)]` is ambiguous, so it does not override `shadow-md`.** tailwind-merge files it under shadow-*colour*; both classes survive, both set `--tw-shadow`, and compiled sheet order decides. Add the type hint — `shadow-[shadow:var(--x)]`, `text-[color:…]` — which classifies correctly and evicts the stock class. Those hints are load-bearing; don't "simplify" them.
- **Any stock utility re-declaring a property beats a custom `@utility`.** Custom utilities compile early in the sheet. In v4 *any* `ring-*` — including the `ring-0` every menu passes — re-emits `box-shadow` as Tailwind's composite from a much later byte offset, which blanked `menu-surface` entirely. Feed the `--tw-*` variable (`--tw-shadow`) as well as the property, so the value flows through the composite instead of being replaced by it. Verify with byte offsets in `dist/renderer/assets/*.css`, not by reasoning.

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
