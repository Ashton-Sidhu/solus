# ADR-0013 — Type is declared on surfaces, from two ladders

**Status**: accepted

## Context

The renderer allowed exactly four type sizes — 12, 13, 14, 24px — enforced by
`tests/unit/type-scale-standard.test.ts`. An audit in August 2026 counted every
type-size site in `src/renderer` and `client/src`:

| Size | Sites | Share |
|---|---|---|
| 12px | 1156 | 63% |
| 13px | 431 | 23% |
| 14px | 179 | 10% |
| 24px | 47 | 3% |
| other | 23 | 1% |

Three problems, each independent of the others:

- **86% of type sat on two indistinguishable sizes.** 12 and 13px are a ×1.08
  ratio — below the point where a difference reads as intentional rather than as
  a rendering artifact. Whatever 13px was for, no user could see it.
- **A ×1.71 cliff from 14 to 24 with nothing between.** Anything that had to be
  bigger than body text but was not a page title had no legal size. The four
  prose contexts each resolved that differently: `.prose-cloud` rendered `h2` at
  body size, `.solus-doc-editor` rendered h1, h2 and h3 all at 24. Four
  workarounds for a missing rung, not four decisions.
- **The standard forbade a size the product required.** iOS enlarges the
  viewport when a focused input is under 16px, so `CommitComposer` needed
  `max-md:text-base` — which the test rejected. The test was failing on `main`.

Underneath all three was a structural cause. `font-size` inherits; the codebase
overrode that inheritance ~1836 times. 128 files declared exactly one size on
every element in them — `SettingsPopover.svelte` writes `text-xs` 31 times and
uses no other size. The product does not contain 1836 type decisions. It
contains roughly 30 surfaces, each restated 30–60 times, kept in agreement by
hand.

Zoom (ADR-0010) cannot help: it is a multiplier, so it preserves ratios exactly.
Zooming out to fix absolute size compresses 12/13/14 into a 1.8px spread, where
a 1px step is lost to hinting — hierarchy gets strictly worse.

## Decision

- **Two ladders, by role.** Chrome is scanned and takes hierarchy from weight,
  colour and position; content is read and must take it from size. One list
  serving both was the root cause.
  - **Chrome uses stock Tailwind** — `text-xs` 12 (meta), `text-sm` 14 (labels),
    `text-base` 16 (section titles), `text-2xl` 24 (page titles). There is no
    custom UI ladder: those already *are* the rungs chrome needs, and a private
    alias for a stock value buys nothing but a tailwind-merge hazard and a name
    nobody else knows. The gap at 18–20 is deliberate — nothing in chrome needs
    them, and leaving them out keeps the set small enough to hold in your head.
    A page title must stay chrome: putting it on `text-h2` would make it grow
    with the *content* text preference, which is not what that setting means.
  - **Content is custom** — `text-caption` 14, `text-body` 16, `text-h3` 20,
    `text-h2` 25, `text-h1` 31: a ×1.25 ladder off a 16px body, which is what
    `index.css` already documented but no longer implemented.
- **The class says which world an element is in.** A stock class is chrome:
  fixed, scaled by zoom alone. A `--text-*` rung is content: multiplied by the
  user's text preference. That split is the *only* thing stock cannot express —
  it has one scale, and we need two behaviours at the same nominal size — and it
  is therefore the only justification for a custom token.
- **Type is declared on the surface and inherited.** A panel, a menu, or the
  transcript states its rung once; descendants say nothing about size. A leaf
  carries a rung only when it genuinely differs — a badge, a timestamp, a
  heading. This is the load-bearing decision: it converts the migration from
  1836 translations into ~30 declarations plus deletions, and a leaf that says
  nothing cannot disagree with its surface.
- **13px, 11px and 10px are retired.** 13 carried no information against 12 and
  14. 11 (`--text-menu-meta`) existed only to optically match monospace keycaps
  beside 12px sans, and lost its reason when chrome stopped setting type in mono
  (below). 10 was a single stray.
- **Menus sit at 14** (`--text-menu`). A menu item is a label you read to make a
  decision, which is the rule that puts every other row label on 14, and it
  restores a real ×1.17 step down to a menu's 12px metadata. It stays a token
  rather than a bare `text-sm` only while the value settles; fold it in once it
  has.
- **Chrome sets type in monospace only for identifiers** — git SHAs, file paths,
  clone URLs, ports, branch names, pairing codes: strings a user transcribes or
  compares, where `0`/`O` and `1`/`l` are a real cost. It is not used for counts
  or durations, because `tabular-nums` already aligns digits on a proportional
  face and the mono buys nothing; nor for keycaps, chips and labels, where it was
  decoration. That decoration is what forced the 11px rung into existence, so
  removing it removed a near-duplicate size as a side effect.
- **Content body is 16px.** The transcript is the product's primary reading
  surface and 14px is a chrome size. Inputs on content surfaces now clear the
  iOS zoom floor by default; a *chrome* input still sits at 14 and therefore
  still needs an explicit `max-md:text-base`, which the standard now permits
  instead of rejecting.
- **Every rung ships with its leading**, through Tailwind v4's
  `--text-*--line-height` convention, so one class sets both and they cannot
  drift apart.
- **The text preference (`--solus-font-scale`) multiplies the Content ladder
  only.** Chrome is scaled by zoom alone. This is ADR-0010's stated intent, now
  mechanically true: the multiply lives in the content `@theme` block and
  nowhere else.
- **The lint enforces scarcity, in both directions.** A file using three or more
  rungs fails — it is a surface that has not declared itself. A file spending
  more than four size classes *in total* also fails, which is the rule the old
  standard lacked entirely: `SettingsPopover.svelte` spent one size and wrote it
  31 times, and counting distinct sizes calls that clean. Sizes outside the
  chrome set (`text-lg`, `text-xl`, `text-3xl`+), arbitrary `text-[…]`, and
  numeric `font-size` outside `index.css` all fail.

  The migration is a ratchet, not a flag day:
  `tests/unit/fixtures/type-scale-pending.json` lists the files still carrying
  leaf sizes. A file outside it that breaks a rule fails; a file inside it that
  has been migrated and not removed also fails, so a cleaned surface cannot
  drift back. The list may only shrink.

Code and terminal type (`--solus-code-font-size`, `--diffs-font-size`) stay
user-configurable and independent; a reading ladder must not drag monospace with
it.

## Consequences

- Component files lose their size classes rather than gaining new ones. A file
  that used exactly one size ends with zero.
- Inheritance has one enemy: a primitive that sets its own size. Any stock
  `text-*` in `components/ui/` is a barrier that stops a surface reaching its
  children, so primitives declare `font-size: inherit` unless they genuinely own
  their size. Removing those barriers must land *before* leaf sizes are deleted;
  in the other order a control silently keeps a stale size with no build error.
- Custom `@theme` keys are invisible to tailwind-merge and get guessed as
  colours, so every rung is registered in `twMergeConfig` (`lib/tw.ts`) and
  guarded by `tests/unit/renderer-utils.test.ts`.
- Per-viewport type overrides are gone. The 10 `min-[1801px]:text-…` classes in
  `CommitComposer` and `PublishRepositoryDialog` were the compensating scale
  factor ADR-0010 bans, keyed to a laptop threshold that no longer exists.
- The migration is staged in `docs/plans/type-scale.md`. Its WP2 — unifying the
  four prose contexts — is independently shippable and is what makes transcript
  headings read as headings again.
- On the workspace view the rendered scale went from 7 sizes to 4, with nothing
  left in the 10–13px band where 31 of 39 text elements used to sit. That band
  was the defect; the ladders are only the means.
- **Broad regexes over source are how this migration hurts you.** Two automated
  passes each shipped a green build while breaking something a compiler cannot
  see: one collapsed markup indentation and ate the space inside a `" "` key
  literal, disabling spacebar activation on task rows; another rewrote token
  lists and left a test asserting and denying the same string. Tests and reading
  the diff caught both. Migrate a surface at a time and read what changed.
