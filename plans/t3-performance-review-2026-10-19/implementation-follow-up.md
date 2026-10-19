## Implementation follow-up — 19 October 2026

**The user approved the five UI changes and the six work steps after the investigation. Seven Opus 5.5 sessions implemented and reviewed the changes below.** The investigation and all 446 PR rows remain below as a historical record. Their statements about unapproved choices, unchanged source, and compiler activation describe the earlier investigation, not the current checkout.

**Source implementation and the planned automated verification are complete.** The final compiler guard passes after the dependency update and #20785 correction. The full mobile typecheck reports zero errors. Native device and live-provider verification remain pending.

### Performance numbers we can support

These are fixture counts and compile results. They do not measure phone frame rate, typing delay, memory, or end-to-end response time.

| Check | Before | After | Meaning and limit |
| --- | --- | --- | --- |
| Earlier-history mounting model | Up to 28 passes | Up to 2 passes | About 93% fewer passes in the fixture model. This is not a measured React commit count. |
| Thread-list item identities changed on a minute tick | 31 of 37 | 0 of 37 | The list no longer rebuilds its items for the clock. The 30 rows with snooze menus still update each minute. |
| Extra HostFacts notification for an equal refresh | 1 | 0 | Reads and freshness updates still occur when required. |
| Project-array replacements on an equal reload | 2 | 0 | Equal project snapshots remain stable. |
| PR notifications on an equal refresh | 3 | 2 | Loading and loaded states still notify. The unchanged listing and rows stay stable, and the selector skips walking the listing again. |
| Unrelated settings writes that re-rendered the observed readers | 2 of 2 | 0 of 2 | Measured with focused fixtures. |
| Known React Compiler skips | 52 | 28 | The final guard compiles 542 of 570 attempted functions across 502 modules. This is coverage, not a measured speed gain. |

Evidence: [store report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/store-stability-implementation.md), [native performance report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/native-performance-implementation.md), and [compiler report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/measurement-compiler/implementation-report.md).

### What changed

| Area | Implemented behavior | Remaining proof |
| --- | --- | --- |
| Shared and mobile stores | Equal host facts, project data and PR data keep stable values. PR content reads are separate from loading state. The guide notice obeys hook order. | Client runtime checks over IPC and WebSockets. |
| Native list and settings work | Feed size classes improve history estimates. Hidden sidebars stop their display clock. Settings read only the values they need. Desktop/web “Last synced” uses a shared clock. | Native scrolling, anchor stability, resume and render measurements. |
| Compiler | Expo enables React Compiler. A guard checks the installed Expo transformer, function outcomes, toolchain versions and source maps. Diagnosed functions were corrected; manual caches remain. | Final guard and full mobile typecheck pass. The 28 known skips retain manual caches. Device comparison with the compiler on and off is unrun. |
| Navigation and controls | Android has Chats, Pull Requests and Settings navigation, plus an expandable rail. Chats and PR lists retain state with hidden effects stopped. iOS uses the native segmented picker. PR menus have Share. | Native navigation, accessibility, retained-tab behavior and share-sheet checks. |
| Composer and sheets | The composer stays compact until text wraps. Sheets distinguish close and apply. Android menu icons accept taps, and keyboard resume handling respects composer focus. | Real TextInput wrap parity, IME, large fonts, RTL, focus, menu single-tap behavior and accessibility. |
| Server correctness | Codex children can outlive their root turn as visible background tasks with Stop. Project mutations reject intermediate symlink escapes and occupied rename targets. Browser snapshots omit masked input values. Git requires explicit bare-repository access. | Live Codex late-child behavior, cross-platform checks and browser runtime verification. No synthetic parent wake was added. |
| Dependencies | One coordinated install updated the Expo native set, including the numeric-width fix in @expo/ui 58.0.20. Enriched Markdown t3.15 is verified and installed. Obsolete blur/glass patches were removed. | Native rebuild and device checks. The fingerprint defect has a guard but is not fixed; no current release consumer uses it. |
| Agents list, #20785 | The mobile pill and sheet keep earlier agents while they work or wait. Item subscriptions update their status without a new transcript row. Repeated session cards use the newest card. | Focused tests and final compiler integration pass. Only loaded history is covered; the hook has no React-renderer subscription test. Native checks remain pending. |

Detailed source and test results are in the [execution register](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/execution-sessions.json), [server report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/lane-server-correctness-report.md), [composer report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/lane-composer-and-sheets-report.md), [navigation report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/lane-navigation-controls-share.md), and [dependency report](/Users/sidhu/solus/plans/t3-performance-review-2026-10-19/dependency-maintenance-report.md).

### Final automated verification

The parent reran `bun run lint:mobile-compiler`: it passes. The worker's final evidence covers both platforms, with zero reported problems, no iOS/Android divergence and all 1,043 source maps correct. The six final test files pass. The one integrated mobile typecheck reports zero errors. The earlier wider run passed 26 of 27 files; the Home project-name disambiguation case also fails on the before snapshot.

### Remaining runtime checks

Run the native and live-provider checks with an approved runtime setup. Record real latency, frame and memory results before making device-speed claims. Check composer wrap and IME behavior, navigation and retained tabs, long-list scroll anchors, native controls and Share, accessibility, and the Agents list. Check Codex late-child completion and Stop in a live run; a synthetic parent wake is not implemented.

The native dependency update needs a rebuild before device verification. The Expo preset now leaves async default parameters intact in the PR diff scroll functions. The pinned Hermes compiler accepts their syntax, but scroll-to-file, scroll-to-top and the release Hermes compiler still need runtime/release checks.

PR-link caching remains deferred because the measured parsing cost did not justify it. Existing failures involving Home project-name disambiguation and an unrelated theme-token edit remain documented separately. No app build, release, commit or pull request is part of this verification.

---
