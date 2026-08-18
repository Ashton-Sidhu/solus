# Type Scale: Two Ladders, One Token Set

**Goal:** replace the four-value type standard (12/13/14/24) with two role-based
ladders — dense **UI** chrome and a real **Content** reading scale — declared
**once per surface** and inherited, so type is chosen by what a surface *is*
rather than restated on every element inside it.

**Status:** not started. The audit below is complete and its numbers are current.
`tests/unit/type-scale-standard.test.ts` **fails on `main` today** (23 offenders),
so the existing standard is already not holding.

## Vocabulary (locked — do not invent synonyms)

- **UI ladder** — type on chrome: sidebar rows, panel sections, tab strip,
  toolbars, menus, badges. Scanned, not read. Hierarchy comes from weight,
  colour, and position; size only separates *supporting* from *primary*.
- **Content ladder** — type on reading surfaces: the transcript, documents,
  plans, PR bodies. Read start to finish. Hierarchy must come from size.
- **Rung** — one step on a ladder. Named by role (`meta`, `ui`, `body`, `h2`),
  never by pixel value. Two rungs may share a pixel value; they are still
  distinct rungs because they answer different questions.
- **Surface** — a region that owns a type context and declares its rung once:
  the project panel, the session sidebar, a menu, the transcript, a document.
  Descendants inherit and say nothing about size.
- **Leaf size** — a `font-size` or `text-*` class on an individual element. A
  leaf size is a **defect** unless the element genuinely differs from its
  surface (a badge, a timestamp, a heading).
- **`--solus-type-*`** — the token namespace for type *sizes*. Deliberately not
  `--solus-text-*`, which is already the **colour** namespace
  (`--solus-text-primary`, `--solus-text-secondary`). Do not merge the two.
- **Text preference** (`--solus-font-scale`) — the user's content text size. It
  scales the **Content ladder only**. Chrome is scaled by zoom alone
  (ADR-0010).

**Verify after every work package:** `bun run build`, plus
`bun test tests/unit/type-scale-standard.test.ts` and
`bun test tests/unit/panel-typography.test.ts`. Do not start a dev server. A
rendered pass over Editor and Pill mode is required before WP4 is called done,
and needs the developer's agreement.

**House rules (from CLAUDE.md — binding):** static Tailwind stays visible inline
in markup; logic in sibling `lib/*.ts`; light **and** dark mode; surgical diffs;
delete orphaned code; never `git stash`.

---

## Background: why (audit, August 2026)

### Every type-size site in the product

| Size | Tailwind | Arbitrary `text-[…]` | CSS `font-size` | **Total** | Share |
|---|---|---|---|---|---|
| 12px | 927 `text-xs` | — | 229 | **1156** | 63% |
| 13px | — | 369 `text-[0.8125rem]` | 62 | **431** | 23% |
| 14px | 115 `text-sm` | — | 64 | **179** | 10% |
| 24px | — | 34 `text-[1.5rem]` | 13 | **47** | 3% |
| 16px | 5 `text-base` | — | — | **5** | <1% |
| other | — | 17 | 1 | **18** | 1% |
| | | | | **~1836** | |

Three findings follow directly from this table.

**1. 86% of all type is split across two indistinguishable sizes.** 12px and
13px are 1587 sites at a ratio of ×1.08 — below the threshold where a size
difference reads as intentional rather than as a rendering artifact. Whatever
distinction those two sizes were meant to draw, no user can perceive it.

**2. There is a ×1.71 cliff from 14 to 24 with nothing in between.** Anything
that must be clearly bigger than body text but is not a page title has no legal
size. The four prose contexts each resolved that differently:

| Context | h1 | h2 | h3 |
|---|---|---|---|
| `.prose-cloud` (transcript) | 24 | **14** | **14** |
| `.prose-reading` | 24 | **24** | 14 |
| `.solus-doc-editor` | 24 | **24** | **24** |
| `.doc-prompt-editor` | 24 | **14** | — |

Four mutually contradictory answers to one question — four workarounds for a
missing middle rung, not four decisions. In the transcript, an `h2` renders at
*exactly* body size, so section headings read as bold paragraphs.

`index.css:1379` still documents the intended ladder above CSS that no longer
implements it:

```css
/* ×1.25 scale off the 16px body: h1 31px, h2 25px, h3 20px. */
```

The design was decided and lost in implementation. This plan builds what the
comment says.

**3. The standard bans a size the product needs.**
`tests/unit/type-scale-standard.test.ts:11` allows only
`{0.75, 0.8125, 0.875, 1.5}` and rejects `text-base`. But
`CommitComposer.svelte:190` carries this comment:

> `max-md:text-base` is load-bearing, not taste: iOS zooms the page on [focus of
> an input below 16px]

iOS enlarges the viewport when a focused input is under 16px. The product needs
16px; the standard forbids it; the test fails. A standard that forbids a
required value is the wrong standard.

### Why this shows up worst on a laptop

Zoom is a multiplier, so it cannot fix a ratio. At 0.9 the 12/13/14 band
compresses into a 1.8px spread, and below ~12px a 1px step is lost to hinting
and rounding — the three rungs that were barely distinct become identical.
Zooming out to fix absolute size makes hierarchy strictly worse, which is why
zooming out does not feel like it solves the problem.

On a large display, generous whitespace does the grouping a type scale would
otherwise do, so flatness reads as "clean". At 1512 the whitespace budget
collapses, grouping has to come from type contrast, and there is none to spend.

### 4. The count is redundancy, not decisions

Type is declared at the leaf, so every element restates the size its parent
already implies. `SettingsPopover.svelte` carries **31 `text-xs` and no other
size** — one surface written thirty-one times, mostly as the identical string
`text-xs font-medium text-(--solus-text-primary)`. Across the component tree:

| Distinct sizes in a file | Files |
|---|---|
| **1** | **128** |
| 2 | 92 |
| 3 | 33 |

128 files declare exactly one size on every element. `font-size` inherits; this
codebase overrides that inheritance ~1836 times and then has to keep all of it
consistent by hand.

So ~1836 is not the number of type decisions in Solus. The real number is closer
to **30 surfaces**. That reframes the whole migration: the bulk of the work is
**deleting** leaf sizes, not translating them to tokens. Deletion is cheaper to
write, far cheaper to review, and it is what stops the drift from regrowing —
a leaf that says nothing cannot disagree with its surface.

### Related debt found in the same pass

- **`min-[1801px]:text-[0.8125rem]`** — 10 uses across `CommitComposer.svelte`
  and `PublishRepositoryDialog.svelte` (5 `text`, 2 `h`, 3 other) resize type at
  a viewport breakpoint. This is the compensating scale factor ADR-0010
  explicitly bans, keyed to the retired 1800px laptop threshold. Delete in WP3;
  the ladder plus zoom covers the intent.
- **Text preference applied to chrome.** The project panel, sidebar, and tab
  strip correctly ignore `--solus-font-scale`, but the command palette, file
  picker, and search overlay use it. Settle in WP4.

---

## Locked design decisions (do not re-litigate)

1. **Two ladders, not one scale.** Chrome and reading surfaces have opposite
   requirements. One list serving both is the root cause.
2. **13px is retired.** It is the rung that carries no information, and at 431
   sites it is the single highest-value deletion. Each site moves to `meta` or
   `ui` by the rule in WP3 — not by a blanket find-and-replace.
3. **Content body becomes 16px.** The transcript is the product's primary
   reading surface and 14px is a chrome size. This also resolves the iOS input
   constraint instead of fighting it.
4. **The Content ladder is ×1.25 off 16**, as already documented in
   `index.css:1379`: 16 → 20 → 25 → 31.
5. **12px stays the dominant chrome rung.** It is 63% of the product and it is
   correct for dense supporting text. This plan does not inflate chrome.
6. **Type is declared on surfaces and inherited.** A leaf carries a size only
   when it genuinely differs from its surface. This is the load-bearing
   decision: it converts most of the migration from edits into deletions, and it
   is the only one of these decisions that prevents the drift from regrowing.
7. **Tokens are named by role and linted as tokens.** The current test freezes a
   list of magic numbers; it can never catch a *role* taking the wrong rung, and
   it cannot see redundancy at all.
8. **Every rung ships with its line-height.** A list of sizes is not a type
   scale. Sizes and leading move together or not at all.
9. **Out of scope:** code and terminal type (`--solus-code-font-size`,
   `--diffs-font-size`) stay user-configurable and independent — a reading
   ladder must not drag monospace with it. Colour, weight, and spacing tokens
   are untouched.

## Target token contract (WP1 delivers this)

Tailwind v4 `@theme` in `src/renderer/index.css`. The `--text-*--line-height`
convention makes v4 emit each utility with its leading already paired, so
markup writes one class and cannot drift.

```css
@theme {
  /* UI ladder — chrome. Zoom scales it; the text preference does not. */
  --text-xs: 0.75rem;            /* 12 — timestamps, counts, badges, paths */
  --text-xs--line-height: 1.35;
  --text-sm: 0.875rem;             /* 14 — row labels, menu items, buttons */
  --text-sm--line-height: 1.4;
  --text-base: 1rem;           /* 16 — panel and dialog titles */
  --text-base--line-height: 1.35;

  /* Content ladder — reading surfaces. ×1.25 off a 16px body.
     Multiplied by the user's text preference; chrome is not. */
  --text-caption: calc(0.875rem * var(--solus-font-scale, 1));  /* 14 */
  --text-caption--line-height: 1.5;
  --text-body: calc(1rem * var(--solus-font-scale, 1));         /* 16 */
  --text-body--line-height: 1.6;
  --text-h3: calc(1.25rem * var(--solus-font-scale, 1));        /* 20 */
  --text-h3--line-height: 1.35;
  --text-h2: calc(1.5625rem * var(--solus-font-scale, 1));      /* 25 */
  --text-h2--line-height: 1.3;
  --text-h1: calc(1.9375rem * var(--solus-font-scale, 1));      /* 31 */
  --text-h1--line-height: 1.25;
}
```

Surfaces then declare a rung once and descendants inherit:

```svelte
<!-- The surface says what it is. Nothing inside repeats it. -->
<div class="settings-popover text-sm">
  <div class="font-medium text-(--solus-text-primary)">Editor</div>
  <span class="text-(--solus-text-tertiary)">Not installed</span>
  <!-- Only a genuine exception carries its own rung. -->
  <span class="text-xs">3 installed</span>
</div>
```

A leaf keeps `font-medium` and colour — those do not inherit as a group and are
per-element by nature. It says nothing about size.

**Inheritance has exactly one enemy here: primitives that set their own size.**
`src/renderer/CLAUDE.md` records that a primitive's breakpoint- or `!`-prefixed
size is its own tailwind-merge group and beats the call site — it also beats
inheritance, so a `Button` or `Input` inside a surface ignores that surface. Any
stock size in `components/ui/` therefore becomes an inheritance barrier. WP3
converts those defaults to `font-size: inherit` (or an explicit rung where the
primitive genuinely owns its size), which is a bounded set of files.

The same file already documents the reverse failure — a bare
`textarea { font-size: inherit }` in unlayered CSS silently ate every textarea's
size. That is proof inheritance is already load-bearing in this codebase; today
it just fights the leaf classes instead of being the mechanism.

**Two further constraints that will bite if ignored** (`src/renderer/CLAUDE.md`):

- Custom `@theme` keys are invisible to tailwind-merge, which guesses their
  property group — usually colour — and silently drops the class against a
  same-prefix neighbour. Every new key must be registered in `twMergeConfig` in
  `lib/tw.ts`, and `cn`/`tv` must be imported from there.
- A primitive's breakpoint- or `!`-prefixed size is its own merge group and will
  beat a call site's token. Primitive defaults stay unprefixed and un-`!`.

`calc()` with a `var()` inside an `@theme` font-size key is the one piece of
this contract not yet proven in this codebase. WP1 verifies it against compiled
`dist/renderer/assets/*.css` before anything migrates; the fallback is to keep
Content rungs as plain rules outside `@theme` and let the text preference apply
through a wrapper class.

---

## Work packages

### WP1 — Define the ladders. No visual change.

- Add the `@theme` block above; register every key in `twMergeConfig`.
- Verify in the compiled stylesheet that Content rungs resolve through
  `--solus-font-scale` and that UI rungs do not.
- Rewrite `tests/unit/type-scale-standard.test.ts` to enforce **tokens and
  scarcity**: reject stock `text-xs|sm|base|lg|xl|Nxl`, reject arbitrary
  `text-[…]`, reject bare `font-size` outside `index.css`, and — the rule that
  actually holds the line — **fail any file carrying more than two distinct
  rungs**, since a third means the file is a surface that has not declared
  itself. Keep the existing Pierre gutter-label assertions unchanged.
- Seed the escape list with today's 23 known offenders so the test passes from
  this commit forward, each entry carrying the work package that removes it.
- Ratify decisions 1–9 as **ADR-0013**, superseding the four-value standard.

**Done when:** `bun run build` passes, the rewritten test passes, and no
rendered pixel has moved.

### WP2 — Fix the four prose contexts. This is what the user sees.

- Map all four contexts onto one mapping: `h1 → text-h1`, `h2 → text-h2`,
  `h3 → text-h3`, body → `text-body`, captions → `text-caption`.
- Delete the four divergent collapses in the table above and the stale ×1.25
  comment at `index.css:1379`, which the code now implements.
- Restore `text-wrap: balance` and the existing margin rhythm against the new
  leading; heading margins are in `em`, so they follow their rung automatically.
- Extend `tests/unit/panel-typography.test.ts` (or a sibling) with a test that
  asserts all four prose contexts resolve `h2` to the same rung, and that no
  prose `h2` equals the body rung — the exact defect that produced this plan.

**Done when:** transcript headings are visibly headings; the four contexts agree;
Editor and Pill both checked in light and dark.

**Independently shippable.** WP2 alone fixes the reported problem.

### WP3 — Declare the surfaces; make primitives inherit.

The structural package. Nothing is deleted yet, so it is reviewable on its own.

- Enumerate the surfaces — roughly 30. Start from the 128 single-size files:
  each is a surface that already knows its rung, it just says so 30 times.
- Give each surface root one rung: `text-sm` for panels, menus, sidebars and
  dialogs; `text-xs` for dense rails and status strips; `text-body` for the
  transcript and documents.
- Convert stock sizes in `components/ui/` primitives to `font-size: inherit`,
  removing the inheritance barriers. Where a primitive genuinely owns its size
  (a badge, a keyboard hint), give it an explicit rung and record why.
- Land surface-by-surface, each with a screenshot pair, so a regression is
  bisectable to one region.

**Done when:** every surface declares a rung and no `components/ui/` primitive
carries a stock `text-*`.

**This package is not visually neutral, contrary to an earlier draft of this
plan.** Leaf classes protect only the elements that *have* one. Two populations
have none and will move:

- Text with no size class today inherits the 16px root. Giving its surface
  `text-sm` shrinks it to 14. Usually a fix, always a change.
- A `<Button>` or `<Input>` whose call site never set a size renders the
  primitive's own `text-sm` today; once the primitive inherits, it takes its
  surface's rung instead.

So WP3 needs the rendered pass, not just a green build, and the surface
declaration must land before the primitive change in each region — never the
reverse, or a control drops to an inherited size with no leaf and no barrier.

### WP4 — Delete the leaf sizes.

The payoff, and mostly a subtraction. ~1587 leaf sizes across the 12px and 13px
buckets, plus the redundant 14px leaves.

- Per surface, delete the leaf `text-*` classes and let inheritance take over.
  A file that used exactly one size should end at **zero** size classes.
- Keep a leaf rung only where the element genuinely differs from its surface,
  using the role rule:



> **12 (`text-xs`)** if the text is *supporting*: timestamps, counts, badges,
> path fragments, status glyph labels, anything a user reads only after already
> knowing what the row is.
> **14 (`text-sm`)** if the user reads it *to make a decision*: row labels, menu
> items, button text, section titles, anything that answers "what is this?"

- This is where **13px is retired**: a 13px leaf either disappears into its
  surface or resolves to `text-xs`/`text-sm` by the rule above.
- Delete the 10 `min-[1801px]:*` overrides; the ladder plus zoom covers them.
- Work surface-by-surface in the order WP3 established, one commit each, and
  remove each file from the WP1 escape list as it lands.

**Done when:** the 128 single-size files carry zero size classes; no
`text-[0.8125rem]` or 13px `font-size` remains outside the code and terminal
surfaces; the escape list is empty; and the scarcity rule in the WP1 test passes
without exemptions.

### WP5 — Settle what the text preference scales.

- Decide per surface whether it is chrome or content, then apply the rule from
  ADR-0010: command palette, file picker, and search overlay are chrome and drop
  `--solus-font-scale`; the composer and transcript are content and keep it.
- Verify the preference at its extremes does not break chrome layout, and that
  chrome is unmoved by it.

**Done when:** the preference moves content only, on every surface, and a test
pins that the persistent chrome files contain no `--solus-font-scale`.

### WP6 — Move content body 14 → 16.

Deliberately last: it is the largest visual change and every earlier package
must be stable first.

- Switch `.prose-cloud`, `.prose-reading`, and document surfaces to `text-body`.
- Re-check the reading measure (`--solus-doc-measure`) — measure is in `ch`, so
  the column widens with the body size and may need retuning to stay at 60–75
  characters.
- Re-check every content-adjacent chrome boundary for the new size step: message
  action rows, token chips, inline code, blockquotes, list markers.
- Keep the `max-md:text-base` iOS workarounds; they are legal now. They cannot
  be retired: the iOS zoom floor applies to any focused input under 16px, and
  these are *chrome* inputs sitting at 14. Content inputs clear the floor on
  their own once body is 16.

**Done when:** long transcripts read comfortably at 1512 and at 2560, and no
content-adjacent chrome looks orphaned beside the larger body.

---

## Risks

- **Blast radius.** ~1836 type sites, but the shape matters more than the count:
  WP4 is overwhelmingly *deletion*, which is cheaper to review than translation
  and cannot introduce a new magic number. WP2 delivers the user-visible win
  before any of it.
- **Inheritance regressions are silent and non-local.** Deleting a leaf size in
  WP4 is only safe once WP3 has removed the primitive barriers; do them out of
  order and a control keeps a stale size with no build error. This is why WP3
  ships separately and leaves the rendering unchanged — it isolates the
  structural risk from the visual one.
- **tailwind-merge.** The failure mode is silent — the class vanishes with no
  build error. WP1's registration step is not optional, and reviewers should
  read the compiled class list, not the source, when a size "looks wrong".
- **`calc()` inside `@theme`.** Unproven here; WP1 proves it or takes the
  documented fallback before any migration depends on it.
- **The 12/14 judgment call.** The WP4 rule will not decide every site cleanly.
  Where it is genuinely ambiguous, prefer 12 — it is the incumbent, so ambiguity
  costs nothing.
- **Mobile and web.** Both consume `client/src` and the same tokens. Every work
  package covers all three clients; there is no desktop-only exception here.
