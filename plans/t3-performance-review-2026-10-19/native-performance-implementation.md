# Native-performance lane — implementation report (19 October 2026)

Scope: #21269 feed size classes, #20814 thread-list clock, #20848 settings selection, #21026 "Last synced" clock. No build, no dev server, no device run, no commit. All numbers come from deterministic fixtures and models. They are not device timings.

## Baseline (before the edits)

`native-performance-baseline.test.ts` ran once against the unchanged source. Its output is in `native-performance-baseline-output.txt`. The probe characterizes the old list item shape, so it does not compile against the new shape. It is kept as evidence, not as a test to run again.

## 1. Feed size classes (#21269)

**Installed estimator.** The installed estimator is `@legendapp/list` 3.3.5 `react-native.js`. `updateItemPositions` sets `useAverageSize = true`. A row with no measurement gets `averageSizes[itemType].avg`. A row that is measured again changes the average of the type that was cached when its container was assigned: `avg += (size − prev)/num`. The container keeps that type until the data epoch or the `getItemType` identity changes. A guard test pins these lines.

**Change.** `threadFeedItemType` (`apps/mobile/src/features/threads/thread-feed-item-type.ts`) uses the T3 doubling-length buckets: `max(0, floor(log2(len/1000)))`. Prompts with attachments get their own `:attachments` class. The streaming reply also gets its own class, `message:assistant:streaming`. This is a Solus adaptation: Solus rows do not change for each token, so without this class the streamed growth of a reply is added to the short bucket where the reply started. `ThreadFeed` now reads `store.item(id)` only when the list asks for a type. It adds no subscription and does not rebuild rows. `getItemType` is a stable callback that changes only when the streaming row changes. Before, it was an inline arrow that got a new identity on every feed render.

**Fixture model** (`tests/unit/native-mobile-feed-size-estimate.test.ts`). The model replays the 3.3.5 averaging rules with fixture heights. It uses the feed's draw distance (500) and estimate (180). MVCP holds the anchor.

| Scenario | Role-only types (before) | Size classes (after) |
| --- | --- | --- |
| 80 short replies prepended above 4 long replies, then scroll to top: max passes per step | 28 | 2 |
| total passes | 73 | 4 |
| estimate error absorbed by the anchor (pt) | 151,491 | 132 |
| short-reply estimate after the settle (pt) | 617 | 48 |
| reply streamed to 12,000 pt under a short class, then 40 short replies prepended: short estimate / passes | 345 / 19 (buckets only, no streaming class) | 48 / 1 |

T3's browser test sets a limit of fewer than 8 nested commits. The model counts render passes and does not count React commits.

## 2. Thread-list clock (#20814)

**Before.** Home and the iPad sidebar each kept a minute counter in the parent component. Each tick did all of these: one parent render, one partition (`buildThreadListV2Items`), and one list-item rebuild. LegendList then received a data change. In the baseline fixture (35 rows), 31 of the 37 items were unequal after a tick. For 30 of them, the only difference was `snoozePresetMinute`.

**Change.** A new `ThreadListClock` (`thread-list-clock.ts`) ticks just after each minute boundary. It runs only while Home is focused (`useFocusEffect`) or while the sidebar is visible, and only while the app is active (AppState, the same pattern as `use-visible-second-clock`). The sidebar uses `visible` and not the mount because `AdaptiveWorkspaceLayout` keeps a hidden sidebar mounted (zero width, `pointerEvents="none"`, `visible={panes.primarySidebarVisible}`). `useThreadListClockWhile(clock, props.visible)` stops the clock and releases its AppState listener when the pane hides. When the pane shows again, the clock reads the time at once. Each start reads the time at once. Rows read the clock through `useThreadListTime` and re-render only when their own answer changes. List items now carry stable inputs (`timeLabelAt`, `snoozedUntil`, `snoozable`) instead of formatted strings. `buildThreadListV2ListItems` no longer takes `now`, and the partition no longer depends on the minute tick.

**Snooze timing.** The exact snooze-wake timer is unchanged: wake time + 50 ms, with the 32-bit clamp and re-arm. A test checks that the partition changes at the wake time. The snooze-wake timer runs whether the pane is hidden or shown, so the partition is already current when the pane shows again or the app resumes. A row with a snooze menu draws its presets at the selected clock time (`new Date(snoozePresetTime)`), so a render is deterministic. A pick still resolves the presets again at press time. The Svelte `SessionSidebar` retention clock is not changed.

**After (fixture).** A tick does no parent render, no partition, and no list rebuild, and gives 0 unequal items. Row re-renders: 31 (the 30 rows with a snooze menu, plus label changes); 4 rows are not re-rendered. Rows with a snooze menu still re-render each minute, because the native menu shows minute-precise preset times ("In 1 hour · 1:42 PM"). To remove those re-renders, the menu content must build when the menu opens. That needs native menu verification, so it is not part of this change. Note: the baseline label count (1) used the wall clock inside `relativeTime`. It cannot be compared with the after label count.

## 3. Settings selection (#20848)

**Before.** `NotificationSettingsScreen` and `AgentDefaultsScreen` read the whole personal-settings value. Every write uses `structuredClone`, so each unrelated write (a theme change, or a remote `applyRemote`) changed both the snapshot and the `notifications` identity. Result: 2 of 2 writes re-rendered the readers.

**After.** Each notification switch is a `NotificationSwitchRow` that reads only its own boolean. Agent defaults reads six primitive values. `setDefaultModel` now reads `current().defaultModels` when it writes. Result: 0 re-renders across 18 selected readers for the unrelated writes. One switch toggle re-renders only that switch row (`tests/unit/native-mobile-settings-selection.test.ts`). The written values and their order are unchanged.

## 4. "Last synced" (#21026)

**Change.** `SettingsTabAccount.svelte` now passes `now` from the shared `messageTimestampClock` to `relativeTime`. It subscribes only while a last-sync time exists and the section is visible. The clock is visibility-aware, the effect cleanup releases it, and no new timer is added. The Svelte compiler compiles the file with no warnings. Mobile `AccountSyncScreen` shows an absolute time (`toLocaleString`), so it needs no clock.

## Changed files

- `apps/mobile/src/features/threads/ThreadFeed.tsx` (`getItemType` only; the other changes already in this file are kept)
- `apps/mobile/src/features/threads/thread-feed-item-type.ts` (new)
- `apps/mobile/src/features/threads/thread-list-clock.ts` (new)
- `apps/mobile/src/features/threads/threadListV2.ts`, `thread-list-v2-items.tsx` (shared row and list helpers of Home and the sidebar; no other lane owns them)
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`, `apps/mobile/src/features/home/HomeScreen.tsx`
- `apps/mobile/src/lib/time.ts` (`relativeTime` takes an optional `now`)
- `apps/mobile/src/features/settings/AgentDefaultsScreen.tsx`, `NotificationSettingsScreen.tsx`
- `packages/workspace-ui/src/components/settings/SettingsTabAccount.svelte`
- Tests: `tests/unit/native-mobile-feed-size-estimate.test.ts`, `native-mobile-thread-list-clock.test.ts`, `native-mobile-settings-selection.test.ts` (new); `native-mobile-thread-list.test.ts` (updated for the new item fields); `native-mobile-agents.test.ts`, `native-mobile-provider-handoff.test.ts` (stale `turn-images` expectations)
- `plans/t3-performance-review-2026-10-19/native-performance-tsconfig.json` (the scoped typecheck)

## Verification

- The three new test files pass: 16 tests. The sidebar visibility test renders a hook host through react-dom in jsdom. It checks four things: a hidden pane has no timer and no AppState listener; two hidden hours and an AppState background/active cycle cause no render; a pane shown again renders the current time at once; an unmount releases everything. The test fails when the hook ignores `visible` (checked by a temporary mutation, then restored). react-dom carries its own React copy (19.2.8; the root React is 19.3.0), so the test maps `react` to that copy with `mock.module`.
- A set of 10 related test files ran: 105 pass, 1 fail. The failure is in a test that was there before these edits; its cause is below.
- The cause of each earlier failure:
  - `native feed: agent groups > a finished turn folds…` and `provider handoff rules > the pending row ends the feed…`: these expectations are stale. HEAD commit `7dad20043` ("more remote fixes", `thread-feed-presentation.ts:149-150`) made every turn with an assistant entry emit a `turn-images` row after the reply. That row shows the images inside the prose and draws nothing when there are none (`ThreadTurnImages` returns null). Neither the dirty tree nor this lane changed it. I added `turn-images` to the two expected arrays. Both tests still prove their rules: the agents stay in the fold, and the handoff-pending row comes last, after the live slot. Both now pass.
  - `home project filter > a name two projects share is told apart…`: not stale on its face, so I did not change it. Commit `f453fbfeb` added the test with `distinctProjectLabels`. Commit `faf8769f7` ("more changes", 2026-10-11) then removed that function from `new-task-project-selection.ts`, so the scope title is now `folderName` only. The function no longer exists in the repository. The failure is at HEAD. It is a product decision: restore the disambiguation of same-named projects, or delete the test. The owner of the Home filter or new-task picker must decide.
- Scoped `tsc` on the changed mobile files and their imports: `./node_modules/.bin/tsc --noEmit -p plans/t3-performance-review-2026-10-19/native-performance-tsconfig.json`. It exits 0 with no output.
- `oxlint` on the changed files reports only the complexity and anti-slop errors that HEAD already has. The counts are the same; the new files have no errors.

## Device gates not run

- iOS and Android scrolling into mixed long and short history. The anchor must hold, with no nested-update loop.
- Streaming growth while the list follows the end.
- Load earlier, expanding tool groups, images, width, rotation, split resize, and keyboard changes.
- React profiler counts for Home and the sidebar across a minute tick, with the sidebar shown and hidden.
- The native snooze menu shows current preset times after a tick.
- After background and resume, labels and snooze wake times update at once.
- Desktop and web: "Last synced" advances while Settings is open and stops while the window is hidden.

## Cross-lane notes and open work

- `apps/mobile/UPSTREAM.md` (dirty, not edited): the coordinator should add rows for the T3 #21269 adaptation (`thread-feed-item-type.ts`) and #20814 (`thread-list-clock.ts`).
- navigation-controls-share: if the native iOS segmented control replaces `SettingsChoiceRow` in `AgentDefaultsScreen`, keep the per-value `useListened` reads.
- measurement-compiler: `ThreadListV2Row` now has three `useSyncExternalStore` reads with inline selectors. `useThreadListTime` takes a fresh closure on each render, which `useSyncExternalStore` supports.
- measurement-compiler: the clock test maps `react` to react-dom's own React copy with `mock.module`. Bun keeps a module mock for the whole process. A test file that runs after it in the same process and depends on root React 19.3 behavior would see 19.2.8. The 10 test files above pass together. A shared React render harness with one React version would remove the need for this mapping.
- Not done: lazy snooze-menu content, which would stop the remaining per-minute re-renders of rows with a snooze menu. It needs native menu behavior to be proven on device first.
