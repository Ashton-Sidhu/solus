# The Review pane

One surface for reading a local change: the map, the guide, and the diff. It
replaces the `diff` route and the standalone review-guide route, and it has the
same shape as the pull-request review pane so the two read as one product.

## Vocabulary

Lock these words. Do not coin synonyms.

- **Review pane** — the single surface for reading a local change. Route name
  `review`. The pull-request equivalent stays **PR review pane** (`prReview`).
- **Review view** — which face of the change is showing: `map`, `guide`, or
  `diff`. The same three words the PR review pane already uses.
- **Review scope** — *which* change the pane is reading. This is a `DiffScope`:
  `session`, `turn`, `working-tree`, or the branch review. All three views read
  the same scope; the pane never shows a map of one change beside a diff of
  another.
- **Branch review** — the whole branch against its target. It has no `DiffScope`
  kind of its own: an absent `scope` means branch review, and the pane resolves
  it to `{ kind: 'pr', baseSha }` from `getReviewContext`. This is the convention
  `GuideLoader` already uses for local branch guides.
- **Guide scope** — what the producer generates against, `branch` or `session`.
  Derived from the review scope, never routed: a `session` review scope asks for
  the session guide, every other scope asks for the branch guide.

## Why one route

The `diff` route and the `review` route were two windows onto one change. They
had different placements, different footers, different comment stores, and no way
to get from one to the other. The PR review pane had already solved this with a
tab row; the local side had not.

The merged route keeps the diff's `overlay` placement, not the guide's leading
pane. The overlay is the high-frequency entry — `opt+shift+D` beside a running
conversation — and flow-first means the common gesture keeps its behaviour. The
guide is one tab away rather than a different destination.

## The route

```ts
review: {
  sourceTabId: string
  view?: 'map' | 'guide' | 'diff'   // default: 'diff'
  scope?: DiffScope                  // absent = branch review
  filePath?: string
}
```

Serialized as `<sourceTabId>/<view>/<diffScope>/<filePath>`.

Two legacy forms still parse, so persisted locations and shared links survive:

- `review/<key>/<branch|session>[/<sourceTabId>]` — the old guide route. The
  second segment is `branch` or `session`, which is disjoint from the view names,
  so the form is unambiguous. The cached-guide `key` is dropped: it is derivable
  from the checkout, which is why it was never load-bearing.
- `diff/<sourceTabId>/<scope>/<filePath>` — the old diff route, aliased to
  `review` with `view: 'diff'`.

## The pane

`ReviewSurface.svelte` owns which view is showing, the guide, and the map.
`DiffPanel` stays the engine: it owns the patch, the file tree, the stream, the
band the tab row sits in, and the one footer every view sends from. The map
and the guide are snippets the surface hands down, so both describe the panel's
own files rather than parsing the same patch a second time.

```
ReviewPane            the `review` route: params ↔ props
  ReviewSurface       scope, guide, and which view is showing
    DiffPanel         header band, file tree, stream, and the one footer
      ReviewPanelHeader        the band — six fixed slots
        ReviewViewTabs         Map · Guide · Diff, pinned left
        ChangeSummaryPopover   branch + counts, opening the changed-file list
        ReviewPanelOverflowMenu  whatever the active view can configure
      DiffHeatMap     the map, over the panel's files
      GuideSurface    the guide, unchanged from the PR pane
```

### The header band

One row, six slots, in this order: the tab group pinned left, flexible space,
the change summary, the turn scrubber, the overflow, then maximize and close.
Nothing appears or disappears between a phone-width panel and full screen —
copy shortens (the branch name, the turn label's noun), positions do not move.

The band carries **navigation and state only**. Configuration is not state:
unified/split, refresh, the file tree, collapse-all and token highlighting are
settings for one view, used once and then remembered, so they live under the
overflow, whose contents follow the active tab. Only the menu is contextual;
the band's slots are fixed. The menu is never empty — Refresh is on every view,
because every view reads the same patch.

The band also owns the window pair, so the review pane draws no floating
`PaneChrome` cluster. Two rules were retired with it: the panel's `border-left`
and the header's `border-bottom`. Space separates, lines do not.

Every width rung is a container query on the band itself (`@container/band`),
never a window or viewport reading — a review panel is legally ~356px wide
beside a companion pane.

Height stays `--solus-chrome-row-h` rather than a flat 46px: the band shares a
baseline with the tab strip in the pane beside it, and macOS grows that row to
clear the traffic lights.

### One band, both reviews

`PrPanelHeader` — the pull-request review that slides out beside the list — is
the same band, because reading a pull request and reading a branch are the same
job. Its slots map one for one:

| Local review | Pull-request panel |
|---|---|
| Map · Guide · Diff tabs | Activity · Map · Guide · Diff tabs |
| Change summary (branch, `+adds −dels`) | Identity (`#411`, head → base) |
| — | Checks chip, checkout, Ask Solus |
| Turn scrubber | Queue scrubber (`3 of 12`, J/K) |
| Overflow (view config, refresh) | Overflow (refresh PR, open page, regenerate guide) |
| Maximize · Close | Swap · Full screen · Close |

`ReviewViewTabs` and `PrViewTabs` are deliberately the same shape — trackless
text buttons on the `text-workspace-chrome` rung — and both read their width
rungs off a `@container/band`, which `PrDetailMasthead` also declares so the
page-shaped review's tabs scale the same way.

The page-shaped PR route keeps its breadcrumb band: its way back is a switcher
into the list, which is a different fact from anything the panel carries.

### Where the guide says it is stale

Nowhere in the guide. `GuideView`'s intro dates itself — "Generated 20 minutes
ago" — and stops there. Whether the cached guide still describes HEAD is state
about the change, so it lives with the rest of that state in the header:

- The overflow's Guide row reads **New commits since guide** instead of
  *Regenerate guide*, and carries a primary dot.
- The overflow **trigger** carries the same dot, so staleness is visible at
  rest without opening the menu.
- The page-shaped PR route puts the dot on its own regenerate button.

A dot rather than a chip because the band's claim is that its slots hold still:
a cue that reserves or claims width would make the band contextual after all.
`GuideHeaderActions` (`diff/lib/review-header.ts`) is the contract both hosts
fill from their `GuideLoader`.

Each view is mounted on first visit and then hidden with `display: none`, so
switching tabs never loses diff scroll position, map drill state, or a typed
comment.

`ReviewSurface` takes props rather than route params because it has two homes:
the `review` route on desktop and web, and the mobile client's full-screen sheet,
which toggles a panel instead of navigating a pane.

## One comment set

Inline comments from the Guide view and the Diff view are the same comments —
`session.diffComments`, on the tab under review. A comment written on a guide's
diff card appears in the diff stream at the same anchor, in the file tree's
count, and in the comments popover.

`ReviewDrafts` stays where it belongs: the PR review pane, where a draft is bound
to a guide key because it becomes a GitHub review. A local review's feedback goes
to an agent, and the tab's own comment list is what an agent reads.

## One footer, two targets

`DiffActionBar` is the pane's only footer. It already carries both send targets:
the primary send goes to the session under review, and the split button starts a
fresh session with the diff and comments as context. Working-tree scope hides the
primary — those changes are not tied to a turn — which was already true.

## Generating a guide

The Guide tab is always present and carries its own state, so generation is never
hidden behind a panel the user has to know about:

- No guide: the centred offer, with a cost hint sized from the change.
- Queued or generating: the stepped progress screen, driven by the durable
  `reviewGuideStore` status, so leaving and returning shows the same progress.
- Ready but not yet opened: the tab stays quiet. The guide itself makes its
  state clear when opened, and a badge on a tab in a band whose point is that it
  holds still is one more thing to stop reading.

`Review changes` is the one local-review entry in both the Git panel and the
conversation action row. It queues generation *and* opens the pane on the Diff
view. The Map and Guide views remain available in that pane; separate entry
actions do not divide one review job. The old flow generated on the first click
and opened on a second, which left the most valuable surface behind an invisible
step.

## Surfaces

- **Editor and Pill** — both drive the same route; the pane is mounted per pane
  slot, so neither mode needs its own copy.
- **Desktop, web, and mobile** — `client/` reaches the pane through
  `workspace.toggleDiff` / `enterReview` exactly as it reached the diff. No
  client-specific branch.
- **Claude and Codex** — the review agent is resolved by `resolveReviewAgent`,
  unchanged.
