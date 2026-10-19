# Native compiler and tooling investigation

Read the Solus Codebase Map and the audit playbook sections **3. Performance**, **7. DX & Tooling**, and **Finding format**. This investigation used the current working tree, including existing modifications. It changed no product source or configuration and installed nothing. All scripts and results are in this review folder.

## Measured coverage

The 117-file sample covers the settings, PR, files, home and layout regions, plus the named conversation and shared component owners. These are source transforms, not app performance measurements.

| Probe | Result |
| --- | --- |
| Current Expo compiler flag | Disabled. The app has no `experiments.reactCompiler`; installed CLI converts absence to false. |
| Current caller, 117 files | 0 compiler events and no compiler runtime imports. |
| Enabled caller, same 117 files | 232 functions compile; 31 distinct functions skip in 28 files. |
| Enabled diagnostics | 76 total: 41 ref, 18 unsupported syntax, 8 memo-preservation, 7 mutation, 1 hook order, 1 compiler invariant. Multiple diagnostics can concern one function. |
| Transform crashes | 0. |
| Serial transform time | About 5.9 seconds for 234 transforms; this is machine-specific diagnostic duration, not a runtime benchmark. |
| Installed versions | Babel 7.29.0; Expo preset 58.0.12; React Compiler 1.0.0. |
| Direct Expo transformer smoke | `SourceFileSurface.tsx`: compiler flag false gives no compiler runtime and 0 memo-cache calls; true gives compiler runtime and 2 calls. |
| Hook naming scan | 484 native TS/TSX files, 87 `use*` definitions, 0 hookless candidates under the upstream lexical rule. |
| Android fingerprint source enumeration | 33 modules resolve; installed fingerprint 0.21.4 returns 0 sources. An in-memory source-directory guard returns 35 sources, including 34 native directories. |

The 117-file diagnostic uses the installed Babel Expo preset and a reconstructed Metro caller. The separate one-file smoke calls the installed `@expo/metro-config/babel-transformer` with the real local Babel config. Neither starts Metro, creates a dependency graph, bundles, builds or runs a native client. The broad sample uses the iOS caller; it does not certify Android-specific transforms. Seven sampled files have no attempted component/hook functions; they are not failures. The 31 skipped functions retain their existing behavior and manual caches.

Reproduce from the repository root:

```sh
node plans/t3-performance-review-2026-10-19/probe-mobile-compiler.cjs --manifest plans/t3-performance-review-2026-10-19/compiler-probe-files.json
node plans/t3-performance-review-2026-10-19/probe-expo-transformer.cjs
node plans/t3-performance-review-2026-10-19/probe-compiler-variants.cjs
node plans/t3-performance-review-2026-10-19/probe-hook-names.cjs
node plans/t3-performance-review-2026-10-19/probe-fingerprint.cjs
```

The variant probe changes source strings only in its own memory. The fingerprint variant loads a changed copy of the library only in its Node process. No installed dependency file is edited.

### [DX-01] Establish the compiler baseline before enabling compilation

- **Evidence:** `apps/mobile/babel.config.js:3` names the Expo preset; `node_modules/@expo/cli/build/src/start/server/metro/MetroBundlerDevServer.js:871` gets the flag from `exp.experiments.reactCompiler`; `node_modules/babel-preset-expo/build/common.js:187` defaults the caller flag to false. `compiler-probe-results.json` contains function names, exact diagnostics and source lines.
- **Impact:** Current native code gets no automatic React compilation. Enabling it already covers 232 sampled functions, but skips include the feed, composer and sidebar. Transitive installation of the compiler does not activate it.
- **Effort:** M, including the baseline and focused failure tests.
- **Risk:** MED. Removing manual caches can change callback identity, external subscriptions, timers and resource lifetime.
- **Confidence:** HIGH for the configuration and compiler results; runtime benefit is unmeasured.
- **Fix sketch:** Use the supported `expo.experiments.reactCompiler` flag and keep the existing Expo preset. Add a transform-output coverage baseline that rejects new failures and lost successes. Do not add the plugin twice or mechanically remove all manual caches. Treat the ready rows as stages of one native compiler project.

### [PERF-01] Fix exact native blockers, with failure cleanup intact

- **Evidence:** `apps/mobile/src/features/files/FileMarkdownPreview.tsx:51`, `apps/mobile/src/features/prs/detail/use-pull-request-action.ts:21`, `apps/mobile/src/components/ComposerEditor.tsx:65`, `apps/mobile/src/features/threads/ThreadComposer.tsx:388`, and `apps/mobile/src/features/threads/ThreadFeed.tsx:529`, plus the remaining diagnosed owners in `investigation-compiler.json`.
- **Impact:** Unsupported async cleanup and conservative ref alias analysis stop whole component/hook functions from compiling. This is a proved compiler coverage gap, not a measured frame-time regression.
- **Effort:** M for each coherent owner group; do not sum the upstream PRs as independent projects.
- **Risk:** MED. A moved cleanup must still run for synchronous throws and rejected promises; timers and gestures must keep the correct owner.
- **Confidence:** HIGH for identified blockers. Complete migration and device behavior remain to be verified.
- **Fix sketch:** In-memory probes make FileMarkdownPreview and the PR action hook compile by preserving cleanup in supported promise settlement. Destructuring ComposerEditor's ref removes 17 conservative ref diagnostics and compiles the function. Larger edits expose further diagnostics: feed ref destructuring leaves one memo-preservation failure; sidebar/Home reset-state changes expose callback memo failures; composer cleanup exposes queued-edit ref inference; ThreadDetail cleanup exposes its end-follow ref write. Resolve them in order under the baseline instead of claiming the first rewrite completes the migration.

Already compiling owners need no corresponding cleanup: SourceFileSurface, AboutScreen, NotificationSettingsScreen, both inspected video modals, AdaptiveWorkspaceLayout, NewTaskContextPickerScreens and ThreadRouteScreen. Upstream native components often have different state and promise semantics from Solus.

Before removing Home/sidebar manual memo dependencies, make time an actual state input. Current code reads `Date.now()` inside a memo and uses minute/wake counters as explicit dependencies. Removing those wrappers without a clock replacement can make the snooze result stale. Test expiry, clamped far-future wake, and an idle period without a rapid timer loop.

### [CORRECTNESS-01] Keep the guide notice hook unconditional

- **Evidence:** `apps/mobile/src/features/prs/detail/PullRequestGuide.tsx:43` keeps GuideNoticeCard mounted. Line 65 returns for ready before `useState` at line 69.
- **Impact:** Hook order depends on notice state. The compiler reports the violation. No runtime crash was reproduced.
- **Effort:** S, including a focused ready/non-ready transition check.
- **Risk:** LOW. Move the hook above the return and preserve the detail-panel state policy.
- **Confidence:** HIGH.
- **Fix sketch:** Make the state hook unconditional before the ready guard. The in-memory rewrite compiles all four functions in this file. This is a correctness prerequisite within #21136, separate from any speedup claim.

### [DX-02] Defer the fingerprint fix until native compatibility uses fingerprints

- **Evidence:** `node_modules/@expo/fingerprint/build/sourcer/Expo.js:371` passes `plugin.sourceDir` to `path.relative`; its catch at 398 returns an empty list. `node_modules/expo-widgets/expo-module.config.json:9` declares the Maven-only plugin. `fingerprint-probe-results.json` reproduces zero sources and the in-memory guarded result.
- **Impact:** If used for Android OTA compatibility, the current tool can omit all Expo native modules. The inspected Solus app has no `expo-updates`, EAS config, runtime version or mobile fingerprint release workflow, so there is no established current delivery exposure.
- **Effort:** S when that release workflow is added.
- **Risk:** LOW for the narrow guard; deployment compatibility needs explicit validation.
- **Confidence:** HIGH.
- **Fix sketch:** Before enabling fingerprint-based releases, use a fixed package or guard missing source directories and fail a release if native-module sources are empty. Then verify a real native source change changes the Android hash and that iOS compatibility is preserved. No full fingerprint hash or EAS operation was run here.

## Decisions and remaining proof

The per-PR JSON resolves all 15 assigned rows. Web ChatView/sidebar/composer migrations are not separate native ports. The hookless-use rule has no current violations to fix; its spelling-only analysis can reject aliased hook imports or legitimate platform stubs, so it should not be added as a substitute for compiler output checks.

Remaining release proof: Android-specific transforms and platform resolution; integration into the actual release dependency graph when builds are authorized; and native device checks for typing, streaming, scrolling/history, keyboard insets, tablet sidebar, gesture lifetime, snooze expiry, failed writes and aborted operations. No runtime performance gain is claimed by these transform diagnostics. Upstream itself reports no reliable streaming improvement from several compiler-only layers.
