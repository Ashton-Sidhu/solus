# T3 follow-up implementation coordination

User authorization: implement the five native UI proposals (navigation, compact composer, native iOS segmented controls, PR Share, sheet close/apply icons) and the six work steps in the reviewed investigation. User requested durable Opus 5.5 sessions. This file coordinates those sessions; it is not an instruction to create PRs or deploy.

Baseline: current dirty working tree of /Users/sidhu/solus, HEAD 14eec2300a7619ffa21a42b2bf126de38dbd4d47. Preserve all pre-existing changes. Sessions share this checkout because the reviewed mobile work is not all in HEAD. Never reset, revert, stash, discard, or commit other work. Do not move to a clean-main worktree that loses the reviewed baseline.

Read AGENTS.md and its map before narrow searches. Evidence lives beside this file: investigation-summary.md, investigation-results.json, review-ledger.json, report.md and reproducible probes. The audit scripts characterize current behavior, including bugs; do not mistake them for desired-behavior regression tests.

## Ownership

| Session lane | Exclusive source scope | Stage |
| --- | --- | --- |
| server-correctness | Codex adapter/lifetime and focused session event consumers if needed; project file mutation/containment; browser masked-value extraction; central Git guard and its actual callers. Focused tests and domain docs. | Implement now. Keep concerns separate. |
| store-stability | HostFacts; mobile ThreadDirectory; PR directory/reads/list selectors/view hook and cache boundaries; GuideNoticeCard hook-order fix in PullRequestGuide.tsx. Focused tests and store docs. | Implement now; measure before/after counts. |
| composer-and-sheets | ThreadComposer.tsx, ComposerEditor.tsx, ThreadDetailScreen.tsx, ThreadSettingsSheet.tsx, AppSheet.tsx, MaterialMenuPopup.android.tsx; sibling sizing/focus helpers and platform editor adapters. | Implement compact-until-wrap, precise close/apply semantics, Android keyboard/menu fixes. |
| navigation-controls-share | RootNavigator and route declarations; HomeRouteScreen; AdaptiveWorkspaceLayout; workspace tabs/navigation/retention; SegmentedControl and native control adapter; PullRequestScreen menu and Share helper. | Implement five-UI-request portions owned here. No HomeScreen/ThreadFeed/ThreadSettings/Composer changes without coordination. |
| native-performance | ThreadFeed.tsx and feed size helpers; ThreadNavigationSidebar.tsx; HomeScreen.tsx clock/subscriptions; AgentDefaultsScreen/NotificationSettingsScreen; SettingsTabAccount.svelte relative-time clock. | Measure then change supported list/clock/settings issues. |
| measurement-compiler | Dedicated measurement fixtures/scripts/tests/docs and compiler guard infrastructure. | Stage 1 now: baseline and guard only. No app config, package or feature-source edits. Stage 2 after coordinator release: compiler enablement and diagnosed function migrations across settled lanes. |
| dependency-maintenance | Dependency analysis and tests/docs first; eventually apps/mobile package versions, native archives/patches and root lockfile. | Stage 1 read-only dependency audit now. No install, lockfile/package/config/patch mutation until coordinator release. Single dependency writer later. |

Workers must report needed cross-lane edits instead of taking another lane's files. Read current files again immediately before each edit. Do not bulk format. Name new test files uniquely by lane. Docs may be added per lane; do not replace shared report/ledger/this coordination file. The coordinator owns those.

Navigation lane can add a focused native adapter if supported by current dependencies. If it needs package/app config changes, report exact requirements; dependency/compiler lanes will coordinate these. The current user request authorizes the described native navigation change (including Settings destination/expandable Android rail), compact composer, native iOS selector, Share and close/apply icons. Update the affected product docs to reflect that decision. Preserve phone/tablet behavior and existing navigation state; do not copy known upstream transition defects. Do not put a phone layout in desktop/web.

## Verification and safety

- No production/live data, real secrets, unrelated process termination, git stash/reset/revert, whole-app builds, Vite/electron builds, or surprise dev-server startup.
- Use focused tests and targeted checks; no full Playwright suite. Use isolated fixtures. Do not run concurrent full mobile typechecks; report a requested integrated check to the coordinator.
- Use available sanctioned browser infrastructure on an existing server if useful; do not start a dev server or claim physical-device measurements from source tests. Report unavailable native runtime/device gates precisely. No native rebuild merely to verify a styling choice.
- No PRs, commits, pushes, releases, or deployment unless the user separately asks.
- Preserve IPC/WebSocket, multi-host, stale guards, permission/loading/error states, keyboard focus, async cleanup and per-item transcript subscriptions. Decide applicability for Claude/Codex and desktop/web/mobile explicitly.
- No broad unknown records; exact types. Follow repo conventions, module boundaries and file-size rules. No speculative refactors.
- Return concrete implementation, focused test results, changed-file list, cross-lane requirements and remaining device/release gates. Do not claim completion for unrun verification.

## Work stages

1. Server correctness, stores, mobile UI and native performance lanes work within ownership. Measurement captures unchanged baselines where feasible before the relevant edit; each implementation lane also records its own focused before/after proof. If concurrent changes invalidate a baseline, report it and use reproducible fixtures/revisions rather than an invented timing claim.
2. Once source lanes settle, coordinator releases compiler lane for staged activation and targeted cleanup. Preserve manual caches until compilation and behavior are proved. Keep rejection/finally semantics. Compile success is not a speed measurement.
3. Dependency lane provides a reviewed version/patch/archive matrix first. Coordinator releases changes separately; keep measurements on identified versions. Fix fingerprint compatibility before any future OTA adoption; do not add OTA as part of this work. Defer PR-link caching unless renderer evidence justifies it.
4. Coordinator reviews reports, handles integration, runs one appropriate integrated check, and updates the original document with done versus pending results.

The previous source investigation found 16 ready references grouped into six work areas, three covered, four rejected as separate changes, three deferred and six decisions. Those labels are evidence, not permission to ignore the user's newer authorization for the five UI proposals.
