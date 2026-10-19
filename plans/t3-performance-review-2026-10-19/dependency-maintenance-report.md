# Dependency maintenance lane — stage 1 report (revision 2)

Date: 2026-10-19. Base: dirty tree on HEAD `14eec2300`. This stage changed no
manifest, lockfile, app config, patch or archive, and ran no install or build.
The dependency-writer phase is not released yet. The coordinator releases it;
the user already authorized the dependency work.

## Primary sources

- T3 Code #20389, Expo SDK 58 patch versions and patch removal:
  https://github.com/pingdotgg/t3code/pull/20389 (merge `ac251a23f22f3aaa08a41773bcfa7efa9c507278`,
  base `3b99fb2d2114f57c96bf92e4ed1c7ce5eaa67b1e`).
- T3 Code #20400, Enriched Markdown t3.13 → t3.15:
  https://github.com/pingdotgg/t3code/pull/20400 (merge `6cecd22789f11fd325933a5d8859d6c09d6e7261`).
  Intermediate archives: #19970 (t3.11 → t3.12) and #20080 (t3.12 → t3.13;
  it adds `enableCodeBlockWrapToggle` to T3's app code).
- T3 Code #20384, Android fingerprint: https://github.com/pingdotgg/t3code/pull/20384.
  Upstream fix proposal: https://github.com/expo/expo/pull/51710, closed by its author on
  2026-10-16 without a merge. `packages/@expo/fingerprint/src/sourcer/Expo.ts` on
  Expo `main` still has no `sourceDir` check.
- Enriched fork: https://github.com/pingdotgg/enriched-markdown. Compare
  `3824d119a1ed6206f51ba3ec8ddf9ff93b8852f9...9fe6c6d23e8544376bcc024bc50a8653e562e745`
  (38 commits ahead, 0 behind). Upstream PRs carried:
  https://github.com/software-mansion/enriched-markdown/pull/1021 (wrap toggle),
  #1015 (list marker width), #1018 (character references), #1017 (iOS
  explicit line breaks), #1019 (table copy), #922 (parser prefix). Fork-only
  Android fixes: pingdotgg/enriched-markdown#5 (upstream #1011) and #6
  (upstream #1012).
- Expo upstream changes cited: https://github.com/expo/expo/pull/51640 (blur),
  #51639 (glass), #51368 (JSI ABI break and rebuilt precompiled artifacts),
  #51655, #51654 and #51641 (widgets 58.0.20), and the `@expo/ui` 58.0.16 changelog
  entry for the numeric `width()` `FieldCastException`. These entries are in each
  package's `CHANGELOG.md` in the npm tarballs (`npm pack <name>@<version>`).

## Evidence in this repository

- `fingerprint-probe-results.json` and `probe-fingerprint.cjs`: the first
  investigation's Android source probe (33 modules → 0 sources; 35 with the
  `sourceDir` check in memory).
- `investigation-upstream-20384.json`: the T3 #20384 patch and workflow guard, verbatim.
- `tests/unit/native-mobile-fingerprint-guard.test.ts`: the release guard below.
- Local files read: `apps/mobile/package.json`, root `package.json`
  (`patchedDependencies`, `overrides`, `trustedDependencies`), `bun.lock`,
  `patches/`, `apps/mobile/deps/README.md`, `apps/mobile/UPSTREAM.md`,
  `apps/mobile/app.json`, and `node_modules/*/package.json`.

## Current state (read from disk)

The working tree already holds uncommitted dependency work by someone else:
`expo-audio` 58.0.4 → 58.0.9 with no patch, `react-native-keyboard-controller`
1.22.6 → 1.22.7 with T3's 1.22.7 patch, `uniwind` 1.11.0 → 1.12.1 with no patch,
and `expo-audio` removed from `buildFromSource`. `node_modules` matches it, and
every listed patch is applied. Keep this work. Installed: `expo` 58.0.7,
`expo-modules-core` 58.0.15, `expo-modules-jsi` 58.0.10, `expo-modules-macros`
0.15.0, `@expo/ui` 58.0.15, `expo-widgets` 58.0.15, `expo-blur` and
`expo-glass-effect` 58.0.3 (patched), `@expo/fingerprint` 0.21.4, Enriched
Markdown `1.2.0-t3.11`, React Native `0.88.0-rc.3` (root override).

## Findings

1. **#20389, blur and glass patches.** The Solus files `expo-blur@58.0.3.patch`
   (SHA-256 prefix `d0311b0c0b05bd94`) and `expo-glass-effect@58.0.3.patch`
   (`f750041c45ab838a`) are byte-identical to the T3 copies at the #20389 base
   commit. They change ref types only (`View` → `ViewInstance`). The 58.0.4 npm
   sources fix the same types with `ComponentRef<typeof View>`. The other 58.0.4
   differences are the version, the CHANGELOG and dev dependencies. No native
   code changes. Solus passes no ref to these views, and the mobile tsconfig
   uses `skipLibCheck`. Remove both patches when the versions move.
2. **#20389, the Expo SDK 58 patch set. This is a correctness item.** Installed
   `@expo/ui` 58.0.15 declares the Compose `width` modifier as
   `Either<Int, IntrinsicSizeType>` (`android/src/main/java/expo/modules/ui/ModifierRegistry.kt:150`).
   The `@expo/ui` 58.0.16 changelog says a numeric `width()` crashes with
   `FieldCastException`, because JS numbers arrive as `Double`. 58.0.20 declares
   `Either<Double, IntrinsicSizeType>`. Solus calls numeric `width()` in
   `MaterialFloatingActionButton.android.tsx:57` (the non-extended "Filter
   threads" FAB in `MaterialThreadListToolbar.tsx:132`) and in
   `MaterialMenuPopup.android.tsx:57` (every Android anchored menu). This is
   static evidence only; no device run. `@expo/ui` ≥ 58.0.16 ships precompiled
   artifacts rebuilt for the `expo-modules-jsi` ABI break (#51368; Swift
   `JavaScriptValue` becomes non-copyable). The precompiled Expo packages
   (`expo`, `@expo/ui`, `expo-camera`, `expo-file-system`, `expo-font`,
   `expo-image`, `expo-video`, `expo-modules-core`, `expo-modules-jsi`) must
   therefore move as one set. A piecemeal `@expo/ui` bump is not safe. No Solus
   local module and no third-party Expo module uses `JavaScriptValue` in Swift.
   `expo-widgets` 58.0.17–58.0.19 crash Android at launch and fail the Android
   build (fixed in 58.0.20). Never stop on those versions. The set also contains
   upstream memory and launch changes; these are not measured Solus gains.
3. **#20389, patches that T3 keeps and Solus does not adopt.** `expo-sharing`
   (only incoming share intents; Solus only shares out), `expo-widgets` (T3's
   widget and live activity types), and `@expo/ui` (an Android `TopAppBar` and
   `Host` changes). The navigation lane confirmed on 2026-10-19 (exchange
   `50abfae2a8fe9b1b08f1bc102ebdc2b099f51b296f10341f844b61bb205ef8b7`) that it
   needs no `TopAppBar`, no T3 `@expo/ui` patch and no other native package
   patch. Its Android rail and bar use React Native and Reanimated, and its
   iOS `Picker` uses APIs that 58.0.15 already has. The numeric `width()` fix
   (finding 2) is still necessary for the existing FAB and menu callers.
4. **#20400, Enriched Markdown t3.11 → t3.15.** The t3.15 archive at T3 merge
   `6cecd22789`:
   - SHA-256 `0ed111e464dbc77438b49c96ba153c6dfe30f68fe6d9fda8077e6123c13fb99c`
   - integrity `sha512-p9o8zNoVoNwqdlG8a9Fvhj0RFUjmpE6VecwOVsO6a8Alj2HPfCDzeLBq0SFn2KdUYX32MC2fH1gJJs/HyfP5Mg==`
     (equal to T3's `pnpm-lock.yaml` entry)
   - `t3-fork.json`: `pingdotgg/enriched-markdown` commit
     `9fe6c6d23e8544376bcc024bc50a8653e562e745`, upstream
     `2547e709d759eda2ee3a5c6d9d37b51f8fa51321`, version `1.2.0-t3.15`.

   The current t3.11 archive, for comparison: SHA-256
   `29c0867f3d0ecae90b3cf4cd6d0f029ad1e860fcd7cd7dcdb843480818690b0e` (equal to
   `deps/README.md`), `bun.lock` integrity
   `sha512-flSZglM98BMtQHffAu1HVq8Y295sff1aT9vMdUZMnSj/3QojV21DSlSITNNhPAArIsAr1rdUrLhipggO8TvfIg==`.

   Provenance: 709 archive files match the fork tree blob for blob (683 under
   `packages/react-native-enriched-markdown/`, 26 `cpp/` files under
   `packages/core/`). Only `package.json` differs (version, and the pack scripts
   were stripped). The rest is build output (`lib/`), codegen output, docs, and
   four highlight files that are byte-identical to t3.11. The postinstall and
   vendor scripts are byte-identical to t3.11, so `trustedDependencies` stays
   valid by name. The public API change is additive: `enableCodeBlockWrapToggle`
   (default `true`) and `accessibilityLabels.codeBlock`. Codegen output is
   additive. The podspec and CMake rename the embedded parser `md4c` →
   `enrmrkd`. Gradle is unchanged. Relevant fixes: Android link long-press opens
   only the link menu; Android drag selection in the feed is not stolen by the
   list scroll; character references; iOS tight width for explicit line breaks;
   table copy keeps line breaks. The iOS measurement code changed, so take the
   feed measurements again after this archive.

   **Decision (parent, 2026-10-19):** pass `enableCodeBlockWrapToggle={false}`.
   This keeps today's behavior on mobile and the parity with desktop and web,
   whose `CodeBlock.svelte` has no wrap toggle. No new toggle feature.
5. **#20384, fingerprint.** Reproduced through the public API under Node:
   Android has 0 `expoAutolinkingAndroid` sources, iOS has 37. 0.21.4 and
   0.21.5 have byte-identical `build/sourcer/Expo.js` (git blob `785ec516`, the
   same blob that T3's patch names), so T3's 5-line patch applies to either.
   Solus has no consumer: no `expo-updates`, no `runtimeVersion`, no
   `buildCacheProvider`, no `eas.json`, no EAS or fingerprint workflow, and
   `ios-dev-build.sh` calls `xcodebuild`. Decision: do not carry the patch now.
   A release guard replaces it (below).

## Reproduce the archive verification

Run from any directory. The download goes into its own new temporary
directory, and nothing in it is executed:

```bash
set -euo pipefail
work=$(mktemp -d)
merge=6cecd22789f11fd325933a5d8859d6c09d6e7261
fork=9fe6c6d23e8544376bcc024bc50a8653e562e745
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/pingdotgg/t3code/contents/apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.15.tgz?ref=$merge" \
  > "$work/archive.tgz"
shasum -a 256 "$work/archive.tgz"   # expect 0ed111e4…b99c
echo "sha512-$(openssl dgst -sha512 -binary "$work/archive.tgz" | base64)"   # expect sha512-p9o8zNoV…Mg==
mkdir "$work/x" && tar xzf "$work/archive.tgz" -C "$work/x"
cat "$work/x/package/t3-fork.json"
# Blob-for-blob provenance against the fork tree (package files, then cpp/ from packages/core/).
tree() { gh api "repos/pingdotgg/enriched-markdown/git/trees/$fork?recursive=1" \
  --jq ".tree[] | select(.type==\"blob\") | select(.path|startswith(\"$1\")) | \"\(.path|ltrimstr(\"$1\")) \(.sha)\""; }
tree packages/react-native-enriched-markdown/ > "$work/pkg.tree"
tree packages/core/ > "$work/core.tree"
match=0; differ=""
while read -r f; do
  t="$work/pkg.tree"; case "$f" in cpp/*) t="$work/core.tree";; esac
  want=$(awk -v p="$f" '$1==p{print $2}' "$t")
  [ -z "$want" ] && continue
  if [ "$want" = "$(git hash-object --no-filters "$work/x/package/$f")" ]; then match=$((match+1)); else differ="$differ $f"; fi
done < <(cd "$work/x/package" && find . -type f | sed 's#^\./##')
echo "provenance: $match files match; differ:${differ:- none}"   # expect 709 match; differ: package.json
rm -rf "$work"
```

This exact block was run on 2026-10-19 and printed the expected values. In the
writer phase, copy the verified archive from the block's `$work` before the
`rm`, then check its SHA-256 again in `apps/mobile/deps/`.

To check the Expo changelog claims again: `npm pack @expo/ui@58.0.20`,
`expo-modules-core@58.0.22`, `expo-widgets@58.0.20`, `expo-blur@58.0.4` and
`expo-glass-effect@58.0.4` in an empty directory, extract them, and read
`package/CHANGELOG.md` and
`package/android/src/main/java/expo/modules/ui/ModifierRegistry.kt:150`.

## Version and patch matrix for the dependency-writer phase

`apps/mobile/package.json` — the T3 #20389 set, limited to the packages Solus
declares. Exact pins where T3 pins:

| Package | Now | Target | Patch |
| --- | --- | --- | --- |
| `expo` | `~58.0.7` | `58.0.14` | — |
| `@expo/ui` | `~58.0.15` | `58.0.20` | none |
| `expo-blur` | `~58.0.3` | `58.0.4` | remove `expo-blur@58.0.3.patch` |
| `expo-glass-effect` | `~58.0.3` | `58.0.4` | remove `expo-glass-effect@58.0.3.patch` |
| `expo-widgets` | `~58.0.15` | `58.0.20` (never 17–19) | none |
| `expo-sharing` | `58.0.13` | `58.0.19` | none |
| `expo-build-properties` | `~58.0.10` | `~58.0.11` | — |
| `expo-camera` | `~58.0.9` | `~58.0.10` | — |
| `expo-crypto` | `~58.0.6` | `~58.0.7` | — |
| `expo-file-system` | `~58.0.8` | `~58.0.9` | — |
| `expo-font` | `~58.0.7` | `~58.0.8` | — |
| `expo-haptics` | `~58.0.5` | `~58.0.7` | — |
| `expo-image` | `~58.0.13` | `~58.0.15` | — |
| `expo-sqlite` | `~58.0.11` | `~58.0.13` | — |
| `expo-system-ui` | `~58.0.5` | `~58.0.6` | — |
| `expo-video` | `~58.0.9` | `~58.0.11` | — |
| `babel-preset-expo` (dev) | `~58.0.0` | `~58.0.17` | — |
| `react-native-enriched-markdown` | `file:deps/…-1.2.0-t3.11.tgz` | `file:deps/…-1.2.0-t3.15.tgz` | — |
| `@expo/fingerprint` (transitive) | 0.21.4 | whatever `expo` resolves | none; guard test |

Unchanged: `expo-audio` 58.0.9, clipboard, document-picker, image-picker,
network, secure-store, status-bar, symbols and web-browser. These already
equal the SDK 58.0.14 list.

Exact edits:

1. Make the manifest edits above.
2. Root `package.json` `patchedDependencies`: delete the `expo-blur@58.0.3` and
   `expo-glass-effect@58.0.3` lines. Delete those two files under `patches/`.
3. Copy the verified t3.15 archive into `apps/mobile/deps/` and remove the t3.11
   archive. Update `apps/mobile/deps/README.md` with the source (T3 #20400,
   `6cecd22789`), the fork commit and upstream, the SHA-256 and the integrity
   above. `trustedDependencies` needs no change.
4. `apps/mobile/UPSTREAM.md` line 26: remove `expo-glass-effect@58.0.3` and
   `expo-blur@58.0.3` from the patch list, and note the 58.0.4 upstream fix.
5. `apps/mobile/src/native/EnrichedMarkdownText.tsx`: add
   `enableCodeBlockWrapToggle={false}` (parent decision). This file has someone
   else's uncommitted changes. Read it again first. Owner: this lane in stage 2.
6. Run one `bun install` at the root. Do not add `overrides` and do not move
   unrelated React Native packages. Then record, from `bun.lock`, the exact
   resolved versions of the ABI set: `expo`, `expo-modules-core`,
   `expo-modules-jsi`, `expo-modules-macros`, `expo-modules-autolinking`,
   `@expo/ui`, `expo-camera`, `expo-file-system`, `expo-font`, `expo-image`,
   `expo-video`, `expo-widgets` and `@expo/fingerprint`. Check that there is one
   copy of each (the current `node_modules` has stray
   `expo/node_modules/expo-file-system` and `expo-font` copies that are not in
   the lock), and that the Enriched integrity is `sha512-p9o8zNoV…Mg==`. No
   release-age policy is configured, so `~` ranges can resolve to releases from
   2026-10-19. Example: `expo-modules-core` 58.0.23 needs `expo-modules-jsi`
   ~58.0.16 and `expo-modules-macros` 0.21.0 exactly. 58.0.22 needs
   `expo-modules-jsi` ~58.0.15 and `expo-modules-macros` 0.20.0. Record what
   resolves; measurements and device checks name these versions.
7. Run the guard test again after the install.

Out of scope (not in #20389, #20400 or #20384; no change proposed): React Native
`0.88.0-rc.3` → `0.88.0` (root override), gesture-handler 3.2.1 → 3.3.0,
reanimated 4.7.0 → 4.7.1, safe-area-context 5.9.1 → 5.10.1, svg 15.15.5 → 15.16.0.
`expo install --check` will report them. PR-link caching (#21147) stays
deferred. Nothing here introduces it.

## Release guard: `tests/unit/native-mobile-fingerprint-guard.test.ts`

- Node computes the fingerprint, because under Bun the config loader's IPC
  fails and the sources come back empty. The child has a 30-second
  `execFileSync` timeout. The reading comes back through a temporary file,
  because Bun's `execFileSync` drops this child's stdout.
- The test asserts that the iOS Expo source count is above 0. This proves that
  the reading works.
- If the Android fingerprint has 0 Expo module sources, the test fails and names
  each fingerprint consumer that it can see: each resolved Expo config setting
  (`runtimeVersion`, `ios.runtimeVersion`, `android.runtimeVersion`,
  `buildCacheProvider`, `experiments.buildCacheProvider`, reported one by one),
  the `expo-updates` dependency, `apps/mobile/eas.json`, and any workflow that
  runs `eas build`, `eas update` or names a fingerprint. The config comes from
  `@expo/config` `getConfig`, so a dynamic `app.config.*` is read too. The
  guard sees only these files. An external release process that it cannot read
  is not covered.
- Fix when it fails: in the same change, apply T3's `@expo/fingerprint` patch or
  an upstream release that has the fix.

## Verification run (revision 2)

- `bun test tests/unit/native-mobile-fingerprint-guard.test.ts`: 1 pass, 2 expects, about 1.0 s.
- `bun scripts/test-unit.ts native-mobile-fingerprint-guard`: 1 file passed (1.4 s).
- Negative copies outside the repo: (a) a copy with both `runtimeVersion` and
  `androidRuntimeVersion` set fails and lists both; (b) a copy with a 50 ms
  timeout fails with `spawnSync node ETIMEDOUT` after 54 ms. Both copies were deleted.
- The archive verification block above: expected SHA-256, integrity,
  `t3-fork.json` and 709 matching files.
- `oxlint` and the root tsconfig do not cover `tests/`. No typecheck applies.

## Device and native gates (not run)

The Expo set and the archive change native code. iOS (pods) and Android must be
built again. On a device or simulator, check:

- Android: the Home list "Filter threads" FAB and an anchored menu render
  without `FieldCastException`. Do this before and after, to confirm the
  static finding.
- Android: the app launches with `expo-widgets` 58.0.20. iOS: the live activity
  starts.
- Glass and blur views render. Camera, image, video, file-system and font load.
- Enriched: link long-press shows only the link menu (Android). Drag selection
  in the feed keeps the handles (Android). `&amp;` renders as `&`. Ordered
  lists past 100 keep their numbers. Code blocks have no wrap button. File-link
  pills, media slots, signed images and dev-host links still work.
- Take the feed measurement baselines again after the archive change. Make no
  speed claim from these version numbers.

## Stage 2 — dependency writer results (2026-10-19)

Released by the coordinator. One root `bun install` (exit 0, 120 packages, the
lockfile was saved). The root postinstall ran as usual: `install-electron`,
`electron-builder install-app-deps` (Electron native dependencies for
Electron 42.11.3, prebuilt) and `scripts/patch-dev-icon.sh`. No app build, no
native rebuild, no dev server, no live data.

### Files changed

- `apps/mobile/package.json`: the matrix above, exactly. The existing
  uncommitted edits (`expo-audio` 58.0.9, keyboard-controller 1.22.7, uniwind
  1.12.1, `buildFromSource`) are kept.
- `package.json`: removed the `expo-blur@58.0.3` and `expo-glass-effect@58.0.3`
  `patchedDependencies` entries. Added
  `"lint:mobile-compiler": "bun scripts/check-mobile-compiler-coverage.ts"`.
  `overrides` are unchanged (React Native `0.88.0-rc.3` kept, nothing added).
- `patches/expo-blur@58.0.3.patch`, `patches/expo-glass-effect@58.0.3.patch`: deleted.
- `apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.11.tgz`: deleted.
  `…-1.2.0-t3.15.tgz`: added after the verification block passed (SHA-256
  `0ed111e4…b99c`, integrity `sha512-p9o8zNoV…Mg==`, 709 files equal to the
  fork, only `package.json` different).
- `bun.lock`: the result of the install.
- `apps/mobile/src/native/EnrichedMarkdownText.tsx`: `enableCodeBlockWrapToggle={false}`.
  The existing uncommitted `onQuote` and `contextMenuItems` edits are kept.
- `apps/mobile/deps/README.md`: t3.15 source, fork commit, upstream, provenance,
  SHA-256, integrity and the toggle decision.
- `apps/mobile/UPSTREAM.md`: the patch row (blur and glass 58.0.4 with no
  patch) and the Enriched archive row. The weekend review rows are unchanged.
- `apps/mobile/app.json`: not touched (`experiments.reactCompiler` kept).

### Resolved native ABI set (from `bun.lock`, one entry each, equal to `node_modules`)

| Package | Before | Now |
| --- | --- | --- |
| `expo` | 58.0.7 | 58.0.14 |
| `expo-modules-core` | 58.0.15 | 58.0.23 |
| `expo-modules-jsi` | 58.0.10 | 58.0.16 |
| `expo-modules-macros` | 0.15.0 | 0.21.0 (the exact pin of core 58.0.23) |
| `expo-modules-autolinking` | 58.0.11 | 58.0.13 |
| `@expo/ui` | 58.0.15 | 58.0.20 |
| `expo-camera` | 58.0.9 | 58.0.11 |
| `expo-file-system` | 58.0.8 | 58.0.10 |
| `expo-font` | 58.0.7 | 58.0.9 |
| `expo-image` | 58.0.13 | 58.0.16 |
| `expo-video` | 58.0.9 | 58.0.12 |
| `expo-widgets` | 58.0.15 | 58.0.20 |
| `@expo/fingerprint` | 0.21.4 | 0.21.5 |

Other Expo packages: `expo-blur` and `expo-glass-effect` 58.0.4, `expo-sharing`
58.0.19, `expo-asset` 58.0.17, `expo-constants` 58.0.12, `expo-crypto` 58.0.7,
`expo-haptics` 58.0.7, `expo-sqlite` 58.0.13, `expo-system-ui` 58.0.6,
`expo-build-properties` 58.0.11, `expo-audio` 58.0.9 (unchanged), `expo-server`
58.0.5. Tooling: `@expo/cli` 58.1.13, `@expo/config` 58.0.6,
`@expo/metro-config` 58.0.15, `babel-preset-expo` 58.0.18,
`babel-plugin-react-compiler` 1.0.0. `~` ranges resolved to the newest patch
releases, several from 2026-10-19 (core 58.0.23, jsi 58.0.16, camera 58.0.11,
image 58.0.16, video 58.0.12, `@expo/cli` 58.1.13). No override was added.

Transitive moves, all caused by the Expo set: `@expo/metro-config` →
`noxcturnal` 0.1.1 → 0.1.5 → `@oxc-project/types` 0.141.0 → 0.154.0; `@expo/cli`
and `@expo/metro-*` → `2g` 0.4.4 → 1.0.1; `@expo/cli` tooling
`@react-native/{asset-utils,dev-middleware,debugger-*,js-polyfills,codegen,babel-plugin-codegen}`
0.88.0-rc.4 → 0.88.0. `react-native` stays 0.88.0-rc.3, and so does its
top-level `@react-native/codegen` (the one the native build uses). The Babel
`@react-native/babel-plugin-codegen` is now 0.88.0 (it was rc.4, so it already
differed from rc.3). No other React Native package moved.

Coherence checks: one lock entry and one installed copy for each package above.
No nested `expo*`, `@expo/ui`, `@expo/fingerprint`, Enriched or
`babel-preset-expo` copy under any `node_modules/*/node_modules`. The old stray
`expo/node_modules/expo-file-system` and `expo-font` copies are gone; the
install replaced the `expo` folder, and nothing was deleted by hand. Every
installed mobile dependency satisfies its manifest range. `shiki` 4.4.3 at the
root and 4.2.0 under `apps/mobile/node_modules` is the hoisting that was there
before. The 6 remaining patches are applied. The installed source shows the
fixes: `@expo/ui` `width: Either<Double, IntrinsicSizeType>`, `expo-widgets`
`CustomNotification` has a constructor, `expo-blur` uses `ComponentRef`.

### Checks run after the install

- `bun scripts/test-unit.ts native-mobile-fingerprint-guard native-mobile-enriched-markdown native-mobile-boundaries`:
  3 files passed.
- Fingerprint on 0.21.5: Android 0, iOS 37 Expo sources. The defect is still
  there, as expected. The guard passes because there is no consumer.
- `bun run lint:mobile-compiler`: exit 1, as expected. 541 compiled, 28
  skipped, 501 modules. It fails only on the toolchain baseline: `@expo/cli`
  58.1.13 (baseline 58.1.6), `@expo/metro-config` 58.0.15 (58.0.11),
  `babel-preset-expo` 58.0.18 (58.0.12). The baseline was not changed; the
  compiler worker owns it.
- Archive verification block: passed before the copy.
- Not run: mobile typecheck and the integrated checks (the parent assigns them to
  the compiler worker), all builds.

### Still pending

The native rebuilds (`pod install`, iOS and Android) and every device check in
"Device and native gates" above. No speed claim.
