# Store-stability lane — implementation report (2026-10-19)

Scope: #20392/#20855 (HostFacts), #20730 (native ThreadDirectory), #20850
(native PR reads, directory, list selectors, view hook), and the
GuideNoticeCard hook-order fix. No builds, no dev server, no live data, no
commits. Baseline: the dirty tree at HEAD 14eec2300. None of the lane's source
files were dirty before this work.

## What changed

| Area | Change |
| --- | --- |
| Shared rule | New `packages/client-core/src/keep-equal.ts`: `keepEqual(next, held)` gives `held` when the JSON of the two is the same, else `next`; `sameItems` checks the same objects in the same order. A first draft walked `unknown` values; the repo `anti-slop` lint rejects that, so the rule is typed and per domain. It runs once per bounded answer at the store, never per render, never on transcripts or diffs. |
| HostFacts (#20392/#20855) | `HostFacts.write` returns early when a ready answer equals the ready value held: same fact object, no listener call. Callers still set `readAt` first, so `maxAgeMs` counts the equal read. Loading, error, drop (`lost`), and generation guards are unchanged; a fresh session still reads every asked fact. Desktop/web `Host` and native `HostConnections` need no change. |
| ThreadDirectory (#20730) | A reload keeps each project wrapper whose key, host label, and `ProjectEntry` are equal, and the host's project array when all items are the same. `remerge` keeps the merged `threads`, `unlisted`, and `projects` arrays when their sorted items are the same objects. Only identity is checked here, no deep compare of sessions. A host that starts loading, or a change to sessions only, therefore leaves `projects()` unchanged. |
| HostReads | New `ReadOptions<T>` (`ReadSharing` plus `retain`). With `retain`, the partial and final answers are kept against the value shown now (taken from the map, so PR sync patches count). A partial that equals what is shown is not shown again. The loading-to-loaded transition always notifies. Diffs and guides do not pass `retain`. |
| PR retain rules | New `lib/pull-request-retain.ts`. `retainListing` matches projects by folder and pull requests by number. It does not compare by position, which would mix two pull requests. `retainDetail` keeps each part (overview, comments, threads, files, checks, stack) and compares the small rest (missing, reading, workflowRuns). PullRequestDirectory passes these rules to `loadHost`, `loadMore`, `reloadRepository`, `loadDetail`, and `loadViewed` (`keepEqual`), and to both PR sync patches in `applyChange`. The unused `revision` counter is deleted. |
| PR list selectors | New `PullRequestListSelection`: two `useSyncExternalStore` snapshots per list. `hosts` changes only when a shown host's `LoadState` object changes (notices, spinners). `rows` keeps the shown listing of each host, in order, that it was built from. When every host ID and listing object is the same (loading, loaded, or an error with the same `previous`), it returns the held rows without calling `pullRequestRows`. A changed listing, a new host order, or a removed host builds the rows again (revision 2, after parent review). `pullRequestRows(listings, previous)` keeps the row wrapper of an unchanged PR object, so the `memo` row does not render again. `usePullRequestList` uses it in place of `directory.revision`. One comment line in `PullRequestsScreen.tsx` is updated (the `projects` memo); there is no UI change. |
| PR view hook | No change is needed. `usePullRequestView` already gives `view` from `shownValue(state)`, and that value is now retained, so `view` keeps its identity across equal refetches while `state` still drives the spinner and offline lines. `PullRequestScreen.tsx` is not changed (navigation lane owns Share). |
| GuideNoticeCard | Moved to `detail/GuideNoticeCard.tsx`. The card has no hooks and returns `null` for `ready`, else it renders a private `GuideNoticeBody` that holds the `useState`. `PullRequestGuide.tsx` imports it. The markup is unchanged. |
| Docs | `docs/plans/host-model.md` §3.2 rule and §7 proof; `docs/plans/mobile-pull-requests.md` Data section (one paragraph added, other-lane edits kept). |

## Measured identity and notification counts (synthetic Bun fixtures, not device)

| Path | Before (baseline probe) | After (lane tests) |
| --- | --- | --- |
| HostFacts equal refresh | 1 extra notification, new wrapper | 0 extra, same fact object, `readAt` advances |
| HostFacts fresh session, equal answers | +1 read, +1 notification per fact | +1 read, 0 notifications (changed fact still notifies) |
| HostFacts recovered | 0 extra reads | 0 extra reads |
| ThreadDirectory equal reload | `projects()` array changed 2×, wrapper replaced | 0 array changes, wrappers kept, still `loading`→`loaded` notices |
| HostReads equal refetch (with `retain`) | 2 state notices, 1 value-identity change | 2 state notices, 0 value changes |
| PullRequestDirectory equal list refresh | 3 notices, new listing, new PR objects, rows rebuilt on every notice (`revision`) | 2 notices, same listing, same PR objects, `rows` snapshot identical across both notices; `hosts` snapshot changes twice (state is still visible) |
| Row build on a state change with the same listings | `pullRequestRows` walked every PR on each notice | 0 walks: a counting `projects` getter is read once at the first build and never on loading, loaded, or error with the same listing (test) |
| PR sync push of equal checks | From the source, not measured: new listing and detail objects, 1 notice | 0 notices, same objects (test) |
| Changed PR moving to the top | All row wrappers new | Only the changed row new; moved-but-equal PR keeps its object |

The audit probe `store-investigation.test.ts` now fails 3 characterization
assertions (HostFacts, thread directory, PR directory) by design: it asserted
the old behavior. Its HostReads probe has no `retain` option and still reads
2/1. Its linked-PR probe is unchanged.

## Applicability

- HostFacts: desktop and web (`Host` subscriber per fact) and native (`HostConnections` re-notifies on `serverInfo`). No RPC, transport, or provider change. Local and remote behave the same.
- ThreadDirectory and PR stores: native only. Desktop/web PR stores were not in scope (#21147, linked-PR cache, stays deferred).
- Providers: none. Claude and Codex are not involved.

## Verification run

- Focused suites: `bun test tests/unit/store-stability-host-facts.test.ts tests/unit/store-stability-thread-directory.test.ts tests/unit/store-stability-pull-requests.test.ts tests/unit/store-stability-guide-notice.test.ts tests/unit/host-facts.test.ts tests/unit/native-mobile-prs*.test.ts tests/unit/session-list-request-budget.test.ts tests/unit/native-mobile-thread-composer.test.ts`: 202 pass, 0 fail (21 files).
- Targeted typecheck, kept in this folder and reproducible from the repo root: `./node_modules/.bin/tsc -p plans/t3-performance-review-2026-10-19/store-stability-tsconfig.json`. It extends `apps/mobile/tsconfig.json` and includes only the changed mobile files, the two client-core files, and the mobile `.d.ts` files. Result: exit 0, 0 errors. It is not a full mobile typecheck.
- `client-core`: `cd packages/client-core && ../../node_modules/.bin/tsc --noEmit -p tsconfig.json` shows only the two existing `window.solus`/`solusNative` errors in files this lane did not touch.
- `node_modules/.bin/oxlint` on every changed source file: exit 0.
- A wider run of the 38 suites that touch these stores (revision 1): 343 pass, 7 fail, all outside this lane: default-machine (fixture has no `location`, run-location), home project filter, agent feed (other dirty mobile work), and two task-open-latency tests that time out only in the combined run and pass alone. The composer failure is fixed below.
- GuideNoticeCard: the card is called outside a render across ready and non-ready transitions. Any hook call there throws, so no throw proves the card has no hooks; the body is shown to throw for the same check.

## Composer follow-up test (`native-mobile-thread-composer.test.ts`)

Cause: a stale fixture, not a production defect. Its `runSettings` returned only `defaultPermissionMode`. `RunSettings` (`lib/ipc-context.ts`) also requires `defaultModels` and `modelOptionsByProvider`, and the other controller suites pass them. With a record that has no model, `applyRunSettingsOnce` calls `newSessionModel`, which reads `defaults.defaultModels[provider]` and throws, so `load()` ended in the `error` phase without a watch. The first send then watched. The fixture answers `runtime: null` for a session with an agent id, which correctly means "nothing runs" (`applyWatch` sets `idle`), so the second send was not busy and had no `delivery`. Fix (test only): give the full `RunSettings`, and assert `controller.phase` is `ready` after load, so a failed load cannot hide behind the delivery check again. The busy rule (steer by default, queue on request) is unchanged and still asserted. No controller change.

## Not run (gates)

- No render counts on a device or simulator for the PR list rows, the PR detail tabs, the sidebar or project picker, or Svelte `Host` readers. These tests do not support any frame-rate or render-time claim.
- No Svelte-level test of fewer `Host` invalidations. This is proved only at HostFacts.
- No integrated mobile typecheck; that is for the coordinator.

## Cross-lane notes

- measurement-compiler: GuideNoticeCard is now in `detail/GuideNoticeCard.tsx`, so update compiler probe file lists that name it in `PullRequestGuide.tsx`. `PullRequestListSelection` caches inside `getSnapshot`, not in render-phase refs.
- navigation-controls-share: one comment line changed in `PullRequestsScreen.tsx` (the `projects` memo). `PullRequestScreen.tsx` is not changed.
- native-performance: `ThreadNavigationSidebar`, `HomeRouteScreen`, `NewTask*` read `app.threads.projects`; they now get a stable array. No edits to their files.
- Shared-test owner: `tests/unit/native-mobile-thread-composer.test.ts` fixture changed (two lines plus one assertion) to fix the stale run settings.
- `pull-request-directory.ts` is 675 lines (over 600 before this work; flagged, not split).
