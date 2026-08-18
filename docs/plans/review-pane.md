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
toolbar the tab row sits in, and the one footer every view sends from. The map
and the guide are snippets the surface hands down, so both describe the panel's
own files rather than parsing the same patch a second time.

```
ReviewPane            the `review` route: params ↔ props, plus PaneChrome
  ReviewSurface       scope, guide, and which view is showing
    DiffPanel         toolbar, file tree, stream, and the one footer
      ReviewViewTabs  Map · Guide · Diff, drawn in the toolbar
      DiffHeatMap     the map, over the panel's files
      GuideSurface    the guide, unchanged from the PR pane
```

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
- Ready but not yet opened: a clear `Ready` cue on the tab.

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
