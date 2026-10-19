# Measurement-compiler lane — implementation report (19 October 2026)

Stages 1 and 2 are done. No build, Metro server, dev server, native build,
device run, install, package or lockfile change, commit, or live data. A
successful compile is **coverage, not measured speed**. Every speed and
behavior claim on a device is still a gate (§7).

## 1. Toolchain (installed, exact)

`@babel/core` 7.29.0 · `@expo/cli` 58.1.6 · `@expo/metro-config` 58.0.11 ·
`babel-plugin-react-compiler` 1.0.0 · `babel-preset-expo` 58.0.12 ·
`react-native-reanimated` 4.7.0 · `react-native-worklets` 0.13.0 · React 19.3.0 ·
React Native 0.88.0-rc.3 · Bun 1.3.14 · Apple M4, 10 cores. HEAD
`14eec2300a76`, dirty tree kept.

## 2. Before evidence (stage 1)

- `before/source-20261019T165244Z.tar.gz` (sha256 `b864b3f1…2f451f64`):
  `apps/mobile/src`, `index.ts`, Babel/app/Metro config, `package.json`,
  `packages/client-core/src`, `packages/contracts/src`, taken at 16:52:44Z. No
  mobile file in it is newer than 11:33 local, before the investigation probe
  (11:59), so it is the reviewed state, without lane edits.
- `before/compiler-coverage-baseline-before.json`: 278 files, **506 compiled,
  52 known skips**. It contains all 31 skips and all successes of the
  investigation's 117-file probe, plus 21 skips outside that sample.
- `before/compiler-coverage-before.json`: evidence run on the snapshot, iOS and
  Android: 0 problems, 0 iOS/Android divergence, 975/975 compiled functions
  map to their source line, compiled modules 2,458,722 → 3,253,344 bytes of
  Babel output before minification.
- Recreate the snapshot tree: extract the archive into an empty directory,
  then link `node_modules` and `apps/mobile/node_modules` to the repository's,
  and run the check with `--source-root=<dir>`.

## 3. Guard

`scripts/check-mobile-compiler-coverage.ts` (+ `scripts/lib/mobile-compiler-transform.ts`,
`scripts/lib/mobile-compiler-worker.ts`, baseline
`scripts/mobile-compiler-coverage-baseline.json`), test
`tests/unit/native-mobile-compiler-coverage.test.ts`, plan
`docs/plans/mobile-compiler-coverage.md`.

- Every module in `apps/mobile/src` and `index.ts` (501 now), not a sample, so
  a new file cannot hide a skip. `.ios`/`.android` modules run for their
  platform.
- The installed Expo Metro Babel transformer with the real `babel.config.js`.
  Transform options come from Expo CLI's own `getMetroDirectBundleOptionsForExpoConfig`
  (release `export:embed` path), so `routerRoot` is `src/app`, as the CLI
  sets it. A reconstructed direct-Babel caller is not exact: the transformer
  sets `BABEL_ENV=production`, and without it the worklets plugin emitted
  development output in 12 files.
- Function outcomes come from the compiler's own logger, lent to its plugin
  instance by a first plugin. The semantics run proves the output is
  byte-identical without it.
- Ratchet: exact comparison per function name. A fixed skip, a new compile or
  a changed reason fails until `--update`. A reduction (new skip, lost
  compile) needs `--accept=<path>#<function>` or a path prefix. A toolchain
  version change fails until recorded.
- Consistency: the plugin ran for every module, and memo caches in the output
  equal compiled functions with slots (catches a module-level `'use no memo'`).
- Speed: 4 Bun workers, about 5–7 s; under the runner's 30-second limit while
  the load average was 14.6 (a single-thread pass took 35 s then).

## 4. Stage 2: enablement and migrations

**Enablement:** `apps/mobile/app.json` `expo.experiments.reactCompiler: true`.
No Babel config or package change: `babel-preset-expo` depends on the plugin.

**Lane deltas before my edits** (`live-delta-stage2-start.txt`, 17:15Z),
attributed to the other lanes, not to the compiler lane: 12 new compiled
functions and `GuideNoticeCard` moved to its own file, where it compiles. No
reduction. Recorded as the stage-2 starting baseline: 518 compiled, 51 skips.

**My edits** (23 functions now compile; each checked with the in-memory probe
before the file was changed):

| File | Change | Semantics kept |
| --- | --- | --- |
| `FileMarkdownPreview.tsx`, `use-pull-request-action.ts`, `use-github-connection.ts`, `useThreadListActions.ts`, `ThreadDetailScreen.tsx` (2), `PullRequestDiscussionScreen`, `…InlineCommentScreen`, `…LabelsScreen`, `…ReviewersScreen`, `…ReviewSheet`, `use-integrations.ts` (`change`, `add`) | `try`/`catch`/`finally` → `async` arrow + `.catch`/`.finally` | Synchronous throw and rejection both reach catch and cleanup; results and rethrow unchanged |
| `use-agent-profile.ts` `addServer`, `NewTaskRouteScreen.tsx` `handleStart` | branches inside `try/catch` → `async` arrow + `.catch` | Same answers and alerts |
| `use-integrations.ts` (`listRef`, `connectionsRef`), `ThreadDetailScreen.tsx` (`endFollowEnabledRef`) | render-time latest-value write → `useLayoutEffect` | Every reader is a callback, timer or passive effect; layout effects run first in the commit |
| `NewTaskRouteScreen.tsx` `PlanModeToggle`, `HomeScreen.tsx` and `ThreadNavigationSidebar.tsx` settled reset key | ref holding an earlier render's value → state updated during render | Same reset and return-to-mode rule; React re-renders before commit |
| `ComposerEditor.tsx` (`ref`), `ThreadFeed.tsx` (`listRef`, `onEndFollowEnabledChange`) | destructure before use | Same ref and callback; provider is a state setter |
| `ThreadSettingsSheet.tsx`, `HomeScreen.tsx`, `ThreadNavigationSidebar.tsx` | call prop callbacks plainly, not through `props.` | Every provider passes an arrow or setter (no `this`) |
| `HomeScreen.tsx` `renderV2Item` (+`onSetPullRequestWatch`), sidebar `handleListMenuAction`, `filterMenu` (+`setSelectedProjectKey`), `renderListItem` (+`setPullRequestWatch`) | add omitted memo dependencies | **Latent stale-closure defects** the compiler found; rows could keep an old callback |
| `workspace-inspector-pane.tsx` | `sv.value = …` → `sv.set(…)` | `set` passes animation definitions through (checked in `mutables.ts`) |
| `OverlayPortal.tsx`, `WorkspaceConnectionTitle.tsx` `StatusFadeIn` | key from a module function in `useState`; `Animated.Value` in `useState` | One key / one value per mount |

Manual `useMemo`/`useCallback` caches are all kept. No compiled component was
migrated off its caches.

**Result:** 541 compiled, **28 known skips**. Evidence run after stage 2
(`after-stage2/compiler-coverage-stage2.json`, iOS and Android): 0 problems,
0 divergence, 1041/1041 source maps correct, compiled modules 2,674,441 →
3,583,910 bytes before minification (not bundle or bytecode size).

**Undone, no benefit yet:** `ThreadComposer` (after the `try/finally` fix, the
hook `useComposerQueuedEdit` receives `inputRef`, so the compiler treats its
result as a ref; also with a focus callback) and `useIntegrationConnect` (after
the invariant fix, `put` passed to the `CloudConnect` constructor during
render). `FontSizeSliderRow`, `WorkspacePaneDivider` (gesture builders with
ref-reading callbacks), `PullRequestScreen` (`guidePr` memo deliberately omits
`pr.baseRepo` to avoid reloads), `PullRequestFiles`, `ThreadSwipeableRow` and
the 21 skips outside the investigated sample stay queued (`--list`).

## 5. Tests and checks run

- `bun test tests/unit/native-mobile-compiler-coverage.test.ts tests/unit/native-mobile-workloads.test.ts`: **13 pass, 0 fail** (7.2 s); `bun scripts/test-unit.ts native-mobile-compiler-coverage`: 1 file passed (7.1 s).
- 17 related mobile test files (t3-parity, composer-and-sheets, thread-feed, layout, feed-size-estimate, artifacts, compaction-divider, provider-handoff, agents, conversation-cards, message-attachments, worktree-offer, thread-list, prs-actions, integrations, agent-profile, visible-clock): **223 pass, 1 fail**. The failure, `home project filter > a name two projects share is told apart…`, also fails on the before snapshot and `homeThreadList.ts` is unchanged since 8 October: it predates this work.
- One narrow typecheck, `measurement-compiler/tsconfig.compiler-stage2.json` (305 mobile source files, all changed ones included): 0 errors.
- `oxlint` on the new scripts: clean. On the 21 changed mobile files: the same 12 findings as on the snapshot, 0 new.

## 6. Measurement fixtures

`tests/fixtures/mobile-workloads.ts`, `tests/unit/native-mobile-workloads.test.ts`,
`scripts/measure-mobile-workloads.ts`; result `after-stage2/workloads-current.json`
(load average 2.0). The measured modules are identical in the snapshot, so these
are also the before numbers.

| Turns (rows) | Build from history | Derive feed rows | One streamed chunk | Feed rebuilds in 500 chunks |
| --- | --- | --- | --- | --- |
| 100 (400) | 0.77 ms | 0.14 ms | 0.21 µs | 0 |
| 1,000 (4,000) | 19.5 ms | 0.51 ms | 0.12 µs | 0 |
| 2,000 (8,000) | 75.1 ms | 0.92 ms | 0.08 µs | 0 |
| 4,000 (16,000) | 310.8 ms | 1.30 ms | 0.08 µs | 0 |

Invariants (test): a chunk changes one item and not the order; a shown-again
conversation reads the same order and rows. Typing, tab return render cost,
and compiler on/off render counts cannot be measured without a React Native
renderer (none installed; `react-dom` 19.2.8 does not match React 19.3.0).
Equal stores, feed size classes and list clock are measured by the store and
native-performance lanes.

**Observation (outside this lane, low):** building from history is quadratic.
While a page is read, `order` is empty, so `TranscriptModel.findTool` scans all
items from the start, twice per tool result. Pages are 10/20 turns, so the cost
per page is small; an older page scans the whole loaded order per tool result.

## 7. Gates not run

Device or simulator render counts and commit times with the compiler on/off
(typing, streaming, long feed, tab return, equal stores); behavior of each
migrated function on device (failed/aborted writes, end-follow and re-pin,
snooze, settled reset, Plan toggle, inspector animation, gestures, keyboard);
effects that relied on per-render identity; memory over long sessions; the
Android release bundle. The Metro graph and bundle were not built.

## 8. Cross-lane requirements

1. **Dependency writer / parent:** after the Expo 58.0.17 / Enriched t3.15
   update, send the final rerun. I then run the evidence run and
   `--update` on the new versions (the check fails until then by design).
2. **Composer owner:** `ThreadComposer` compiles only if the focus-on-enter
   effect leaves `useComposerQueuedEdit` (or the hook stops receiving the ref).
   A design choice for that lane.
3. **Optional, root `package.json` owner:** a `lint:mobile-compiler` script
   alias. Not added (package files are out of scope).
4. **Conversation owner:** the `findTool` scan in §6, if long histories matter.

## 9. Post-dependency verification (checkpoint, 19 October 2026, 13:52 EDT)

Installed set checked from `apps/mobile`: `expo` 58.0.14, `@expo/cli` 58.1.13,
`@expo/config` 58.0.6, `@expo/metro-config` 58.0.15, `babel-preset-expo`
58.0.18, `babel-plugin-react-compiler` 1.0.0, `@babel/core` 7.29.0, Reanimated
4.7.0, worklets 0.13.0, React 19.3.0, React Native 0.88.0-rc.3, Metro 0.87.1,
`hermes-compiler` 260318099.0.4 (pinned by React Native, not moved).

**Evidence before the baseline update.**
`bun scripts/check-mobile-compiler-coverage.ts --semantics --all-platforms --report=…/after-dependency/compiler-coverage-deps.json`:
965 module-platform pairs, 1041 compiled, 55 skipped, 0 problems, 0 iOS/Android
divergence, 1041/1041 source maps correct, `configuredCompiler` true.
Against the stage-2 report: 0 outcome, memo-slot or interface changes.

**Toolchain effect isolated on identical sources.** A fresh tree from the
verified archive (`--source-root`) against `before/compiler-coverage-before.json`
(`after-dependency/snapshot-sources-new-toolchain.json`): 0 outcome, memo-slot
or interface changes; output bytes changed in two modules only. (A first
attempt used an old scratch tree that held 17 stage-2 probe files; it was
discarded.)

Cause, read from the cached 58.0.12 and 58.0.18 preset builds:
`configs/hermes-v1.js` (used for `hermes-stable`) no longer applies the three
Hermes v1 fixes (async arrows with non-simple parameters, `super` in object
accessors, a class in `finally`). Router env inlining also changed; the app
does not read those variables. Effect on the shipped (compiler-on) build:
only `nativeReviewDiffSurface.ts` (−52 bytes): `scrollToFile` and
`scrollToTop` are async arrows with default parameters, in the known skip
`NativeReviewDiffView`, so they now reach Hermes as written. In compiled hooks
(`use-github-connection`, `use-pull-request-list`) the compiler already lowers
those parameters, so only their compiler-off output changed. The other live
byte change, `EnrichedMarkdownText.tsx` (+32), is the dependency lane's
`enableCodeBlockWrapToggle={false}` source edit.

The pinned `hermesc` compiled a scratch file of each of the five affected
forms (default, destructured and rest parameters on async arrows, `super` in
an accessor, a class in `finally`) with exit 0. That proves syntax acceptance
only, not runtime behavior. A release build may use the `hermesc` of the
Hermes pod, which can differ from the npm package.

**Baseline.** `--update` with no `--accept`: only the three toolchain lines
changed (`@expo/cli` 58.1.13, `@expo/metro-config` 58.0.15,
`babel-preset-expo` 58.0.18). 541 compiled, 28 known skips, 501 modules; the
check then exits 0. `bun run lint:mobile-compiler` (alias added by the
dependency lane): exit 0.

**Focused suites.** `bun scripts/test-unit.ts native-mobile-compiler-coverage native-mobile-workloads native-mobile-t3-parity native-mobile-composer-and-sheets native-mobile-thread-feed native-mobile-layout native-mobile-feed-size-estimate native-mobile-artifacts native-mobile-compaction-divider native-mobile-provider-handoff native-mobile-agents native-mobile-conversation-cards native-mobile-message-attachments native-mobile-worktree-offer native-mobile-thread-list native-mobile-prs-actions native-mobile-integrations native-mobile-agent-profile native-mobile-visible-clock native-mobile-enriched-markdown native-mobile-boundaries native-mobile-fingerprint-guard native-mobile-review-diff native-mobile-settings-selection`:
26 of 27 files passed. The failure is `native-mobile-thread-list.test.ts`,
case `home project filter > a name two projects share is told apart only
among the projects the host filter keeps` (27 pass, 1 fail in that file). It
fails on the before snapshot too, and `homeThreadList.ts` is unchanged since
8 October: it predates this work.

**Workload fixtures** (model and host values on Bun, Apple M4, load 4.1; not
native speed): `after-dependency/workloads-after-dependency.json`. Build from
history 0.78 / 20.5 / 85.3 / 352.0 ms for 100 / 1,000 / 2,000 / 4,000 turns;
feed rows 0.14 / 0.70 / 0.99 / 1.56 ms; one streamed chunk 0.08–0.33 µs; 0 feed
rebuilds in 500 chunks. The invariant test passes (3/3). The measured modules
are unchanged since the snapshot, so the earlier numbers differ only by load.

**Not yet done, by decision.** The #20785 fix (`ThreadAgents.tsx`, its helper
and the `ThreadDetailScreen` caller, composer worker) had not landed at 13:52.
The final guard, a final `--update` if that source changes outcomes, and the
one integrated typecheck (`node_modules/.bin/tsc --noEmit -p apps/mobile/tsconfig.json`)
wait for it, so the single typecheck covers the final source.

**Additional device and release gates from this update:** PR file-diff
scroll-to-file and scroll-to-top on device (Hermes v1 now runs their default
parameters as written); the Hermes pod's `hermesc` in a release build; the
native rebuilds the dependency lane lists.

## 10. Final verification with the #20785 roster change (19 October 2026, 13:58 EDT)

The composer lane's roster change (`ThreadAgents.tsx` `useAgentRoster`, new
`agent-roster.ts`, the `ThreadDetailScreen` caller) landed at 13:54–13:55 and
the parent accepted it.

- Guard before the update: one change only, `useAgentRoster` compiles.
- Evidence run, `…/after-dependency/compiler-coverage-final.json`: 967
  module-platform pairs, 1043 compiled, 55 skipped, 0 problems, 0 iOS/Android
  divergence, 1043/1043 source maps correct. Against the 13:46 run, every
  change is in `ThreadAgents.tsx`, `ThreadDetailScreen.tsx` (still compiled)
  and the new `agent-roster.ts`. Compiled modules: 2,674,209 → 3,583,684 bytes
  of Babel output before minification.
- `--update` with no `--accept`: the baseline adds `useAgentRoster` and nothing
  else. **Final: 542 compiled, 28 known skips, 502 modules.**
  `bun run lint:mobile-compiler`: exit 0.
- `bun scripts/test-unit.ts native-mobile-compiler-coverage native-mobile-workloads native-mobile-agent-roster native-mobile-agents native-mobile-composer-and-sheets native-mobile-t3-parity`:
  6 of 6 files passed. The wider suite from §9 ran on code that has not
  changed since, except these files; its one failure predates this work.
- The one integrated typecheck, `node_modules/.bin/tsc --noEmit -p apps/mobile/tsconfig.json`
  (`index.ts`, `uniwind-types.d.ts`, all of `src`): exit 0, **0 errors**, 4.3 s,
  1.1 GB peak memory, load average 6.0. No earlier integrated run exists in
  this work; the narrow configs were also at 0, so there is no old-versus-new
  finding.

Gates still open: §7 and §9 (device render counts and commit times with the
compiler on and off, behavior of each migrated function, effects that relied
on per-render identity, memory, the Android release bundle, the Hermes pod's
`hermesc`, PR diff scroll-to-file and scroll-to-top, native rebuilds), and the
roster's own device check (the composer lane's list).
