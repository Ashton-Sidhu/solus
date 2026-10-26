# Vendored native dependencies

## `react-native-screens-5.0.0-t3.27.tgz`

T3 Code's fork of react-native-screens 5. The app does not patch this
package: the fork contains the changes that the old
`patches/react-native-screens@4.28.0.patch` added (the `editor` navigation
item style, the Mail-style search toolbar, the search bar placement item, and
the bar item axis behavior), and also the v5 `Stack`, `Split`, `Tabs`, and
`FormSheet` components that the iOS navigation shell uses.

- **Copied from:** T3 Code, `apps/mobile/deps/react-native-screens-5.0.0-t3.27.tgz`,
  commit `e2e95a39d` (the archive was added in T3 Code #18527, `462e7f4de`).
- **Fork source:** the `t3-fork.json` in the archive records the repository
  `juliusmarminge/react-native-screens` (now `pingdotgg/react-native-screens`),
  commit `176ff64880ddd0a6122a1f18eda826479c8e73c7`, tag `t3-v5.0.0-t3.27`,
  on the upstream commit `72f38a66c188bdebee7a7798c9b72a121b7a8451`.
- **SHA-256:** `844610ae7a670426e49a66a10891129cf40985494b6ee9d7b4f488f1179139a3`
- **License:** MIT (`LICENSE` in the archive, Software Mansion).

The root `react-native-screens` override must use the same `file:deps/...`
path as the mobile manifest. Bun 1.3.14 resolves this override from the mobile
workspace. A root-relative `file:./apps/mobile/deps/...` override fails with
`ENOENT extracting tarball` during a clean install. Keep the override so
React Navigation's peer dependency uses this fork too.

T3's procedure to build an archive is in its
`docs/operations/mobile-screens-fork.md`. To replace this archive, copy the
new archive from T3 Code, change the path in `apps/mobile/package.json`,
record the new source and SHA-256 here, and run `bun install` at the
repository root. The native clients must be built again when this archive
changes.

## `react-native-enriched-markdown-1.2.0-t3.16-558767d9.tgz`

T3 Code's fork of Software Mansion's Enriched Markdown. It draws all the
app's Markdown (`src/native/EnrichedMarkdownText.tsx`): native text with
selection, pills for file links, iOS link menus, code blocks with a header and
tree-sitter colors, tables, and images in React block renderers. Upstream now
ships the block renderers and image sources (`renderers`,
`resolveImageSource`). The fork adds native streaming memory bounds (an 8 MiB
budget for iOS measurement keys, and only the newest pending render is kept),
the `onLinksChange` link list, Android inline image alignment, clipboard link
metadata, and development-host autolinks.

- **Copied from:** T3 Code, `apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.16-558767d9.tgz`,
  at the merge of T3 Code #24263 (`ba006f2dfa68962247025dc87dc3be8d637b90ad`).
  Earlier Solus used `t3.15` (T3 #20400, `6cecd22789`). Solus skips T3's
  intermediate archives `t3.15-fee84114` (#18735, LaTeX; Solus keeps math off)
  and `t3.16-8d2f84a8` (#24534, block renderers).
- **Fork source:** the `t3-fork.json` in the archive records the repository
  `pingdotgg/enriched-markdown`, commit
  `558767d9bccec81805d960f792ab0fcda7c1e7c8`, on the upstream commit
  `69c3330dd6d75cacd8d046f4e0c4b8fe5c42a6e1`. The package version is
  `1.2.0-t3.16`.
- **SHA-256:** `d9b75931bafb1847172550bb4eaafb7b8f59632a79b796e6174a93261e95c0fd`
- **Integrity:** `sha512-Dl8Raid4175mHijMpsIRLB3yXBZ1s04YxaQoIdHwy64KPHBVdt26x2OYRhYyjMM3VEo4U24AAYNXUh271zYDQw==`
  (the same in `bun.lock` and in T3's `pnpm-lock.yaml`)
- **Changes from `t3.15`:** the media slots and the document asset manifest
  are removed. `renderMedia` becomes `renderers.image`, `onDocumentAssets`
  becomes `onLinksChange`, and `resolveImageSource` receives a
  `MarkdownImageOccurrence` and is asked about each image once. Links that
  `linkRecognition` adds are not in `onLinksChange`, so the wrapper adds them
  (`recognizedLinkUrls`), and `useRetryingImageSource` asks the next resolver
  for an image that failed. `enableCodeBlockWrapToggle` stays `false`. The
  parser is now also a TurboModule (`EnrichedMarkdownParser`), so the native
  clients must be built again.
- **License:** MIT (`LICENSE` in the archive, Software Mansion).

The archive's `postinstall` downloads the tree-sitter grammars for code
colors. Bun runs it only for a trusted package, so the root `package.json`
lists `react-native-enriched-markdown` in `trustedDependencies`. A
`trustedDependencies` list replaces Bun's default list, so it also names the
packages Bun trusted by default that this repository builds at install:
`electron-winstaller`, `esbuild`, `fs-xattr`, `macos-alias`, and `workerd`.
The `enriched-markdown` block in `apps/mobile/package.json` turns off math (no
RaTeX download) and video. T3 turns math on since #18735; Solus keeps it off.

T3's procedure to build an archive is in its `apps/mobile/deps/README.md`. To
replace this archive, copy the new archive from T3 Code, change the path in
`apps/mobile/package.json`, record the new source and SHA-256 here, and run
`bun install` at the repository root. The native clients must be built again
when this archive changes.
