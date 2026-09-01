# Diff context is hydrated per file on demand

Status: accepted

Solus renders the normal three-line-context patch first and lets `@pierre/diffs`
request both complete file versions only when a reader expands an unchanged
region. The renderer calls `diffFileContents` with the displayed diff scope,
pre-image and post-image paths, live session paths, and the object ids parsed
from that patch. Main resolves the same comparison endpoints used to generate
the patch and returns the two canonical Git blob contents.

This replaces the previous full-context strategy. That strategy ran a second
repository-wide `git diff --unified=1000000`, transferred the resulting patch,
parsed every file, reconstructed both blobs from its line arrays, and rebuilt
each normal patch against those blobs. It also stopped upgrading diffs above 300
files. Expansion was therefore eager and repository-sized even when the reader
never expanded a line.

The on-demand loader is a better match for the interaction: initial rendering
does one normal diff, expansion pays for one file, and repositories with more
than 300 changed files no longer lose the feature. `@pierre/diffs` owns partial
metadata hydration, scroll anchoring, virtual-height reconciliation, and
highlight-cache reuse.

## Comparison endpoints

The loader must describe the exact patch on screen:

| Scope | Old content | New content |
| --- | --- | --- |
| Working tree | `HEAD:<previousPath>` | canonicalized live worktree file |
| PR / branch review | resolved PR base blob | canonicalized live worktree file |
| Live session | session base tree | temporary tree containing only that session's live paths |
| Completed session | session base tree | latest captured turn tree |
| Turn | previous captured turn tree | selected turn tree |

Renamed files load `previousPath` on the old side and `path` on the new side.
Pure renames are adapted to the library's `{ oldFile: null, newFile }` contract.
Added and deleted files already contain their available full side in the patch,
so the library does not invoke the loader for them.

Patch overrides and interdiffs stay partial. Their patch can compare arbitrary
heads that are not encoded by the active `DiffScope`; hydrating them from the
active scope could show unchanged lines from the wrong comparison.

## Staleness and failure behavior

The request carries `prevObjectId` and `newObjectId` from the displayed patch.
Main compares those ids with the blobs it resolved. A changed worktree, missing
blob, unsupported remote server, binary file, or any other load failure returns
no contents. The library then retains the original partial patch. Expansion is
progressive enhancement; it must never replace a correct partial diff with
potentially stale full-file content.

Returned files use their blob ids as `cacheKey` values. This allows the shared
worker pool to reuse syntax-highlighted content while ensuring a changed file
cannot reuse an older highlight entry.

## `@pierre/diffs` 1.3.0-rc.1 feature summary

Solus moved from `1.3.0-beta.5` to the exactly pinned `1.3.0-rc.1`. The upstream
comparison contains 178 commits and 201 changed package files. Relevant changes
include:

- **Dynamic partial-diff hydration.** `loadDiffFiles` upgrades a patch-parsed
  `FileDiffMetadata` in place and repairs CodeView offsets and scroll anchors
  after unchanged context becomes visible. This is adopted by the Diff tab and
  review-guide cards.
- **Virtualized metadata updates.** `VirtualizedFileDiff` accepts new metadata
  correctly, partial hydration is guarded against stale async results, and
  CodeView better preserves viewport position across expansion and live
  refreshes. Solus receives these fixes automatically.
- **CodeView-managed editing.** A `CodeView` item can set `edit: true`;
  `createEditor`, `onItemEditChange`, `onItemEditComplete`, and `getEditor`
  support independent editors that survive virtual row recycling. This is not
  enabled yet in Solus.
- **Mature editor API.** The editor now exposes programmatic `undo`, `redo`,
  `applyEdits`, `getText`, `getFile`, selection/state control, markers, focused
  line targeting, custom clipboard access, and lazy option updates.
- **Persistent editor sessions.** Opt-in persistence retains a file's document,
  selection, horizontal scroll, and undo history in memory, IndexedDB, or a
  custom state store. Stable non-empty file cache keys are required.
- **Editing UX.** Unified diffs are editable; find/replace, bracket matching,
  auto-surround, line move/copy, blank-line insertion, multi-selection, comment
  commands, and selection-action popovers were added or refined.
- **Text correctness.** Fixes cover CRLF round trips, mixed-line-ending paste,
  emoji and surrogate-pair edit boundaries, NFD graphemes, CJK/tab measurement,
  IME composition, Safari deletion, soft-wrap caret movement, EOF edits, and
  annotation remapping.
- **Performance.** Piece-table edits mutate in place, offscreen editor rows skip
  DOM lookups, search matches are viewport-culled, wrap points use cached binary
  search instead of per-character measurement, and redundant hunk recomputation
  and layout work are reduced.
- **Extensibility.** CodeView gained automatically measured, non-virtualized
  header/footer slots; file headers gained a filename-suffix slot; editable line
  annotations and custom clipboard providers are documented.
- **Annotation behavior.** Prose annotations wrap in every overflow mode and
  marker/comment popovers reposition more reliably while scrolling. Solus's
  inline comments benefit without local workarounds.
- **Packaging and naming.** Editor code is exported from
  `@pierre/diffs/edit` rather than `/editor`, stays outside read-only consumer
  bundles, and React editing changed from one provider per component to a lazy
  editor factory. Solus must use the new entry point if inline editing is added.

Upstream references:

- <https://github.com/pierrecomputer/pierre/compare/diffs-v1.3.0-beta.5...diffs-v1.3.0-rc.1>
- <https://github.com/pierrecomputer/pierre/pull/861>
- <https://github.com/pierrecomputer/pierre/pull/1006>
- <https://github.com/pierrecomputer/pierre/pull/976>
- <https://github.com/pierrecomputer/pierre/pull/1011>
- <https://github.com/pierrecomputer/pierre/pull/1021>

## Consequences for Solus

- Opening or refreshing a diff no longer starts a background full-repository
  context fetch. Remote hosts transfer only the normal patch until expansion.
- The renderer no longer owns `FileVersions`, `FULL_CONTEXT_LINES`,
  `buildExpandableMetadata`, or the 300-file expansion cap.
- Main writes a canonicalized modified worktree blob to Git's object database
  before returning it. The blob is unreferenced and eligible for normal Git
  garbage collection; no refs, index, or working files change.
- Older remote Solus hosts do not implement `diffFileContents`. Their RPC error
  leaves the partial patch readable, but expansion requires upgrading the host.
- Native hydration mutates the `FileDiffMetadata` object in place. Diff metadata
  must keep stable identity while mounted. Solus already uses `$state.raw` and
  reuses unchanged per-file parses for this reason.
- The release remains an RC and is pinned exactly. Move to a range only after
  the final 1.3 release passes the diff, guide, annotation, worker, and remote
  host regression suite.
- Inline editing is now technically viable but remains a separate product
  decision. A safe Solus rollout should begin with working-tree diffs, explicit
  Save/Discard, native Electron clipboard integration, and a stale-file guard;
  historical turns and provider PR diffs should remain read-only initially.
