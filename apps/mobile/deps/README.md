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

## `react-native-enriched-markdown-1.2.0-t3.18-4287c5d3.tgz`

T3 Code's fork of Software Mansion's Enriched Markdown. It draws all the
app's Markdown (`src/native/EnrichedMarkdownText.tsx`): native text with
selection, pills for file links, iOS link menus, code blocks with a header and
tree-sitter colors, tables, and images in React block renderers. Upstream now
ships the block renderers (also for code blocks), image sources, the
`onLinksChange` link list, Android inline image alignment, and the iOS
streaming memory bounds. The fork carries only changes with an open upstream
pull request: clipboard link metadata, development-host autolinks and
hash-route link fragments, `md4cFlags.preserveWindowsPaths`, GitHub's
strikethrough rules for `~`, `\(…\)` and `\[…\]` math delimiters, iOS Copy as
Markdown that keeps bold spans whole, and line breaks in copied table cells
written as `<br>`.

- **Copied from:** T3 Code, `apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.18-4287c5d3.tgz`,
  at the merge of T3 Code #32180 (`986a4f56a80963cc139dbc581665b40411855659`).
  Earlier Solus used `t3.16-558767d9` (T3 #24263) with the table-cell copy fix
  of T3 #29355 packed in (`solus.1`). Solus skips T3's intermediate archive
  `t3.16-29ddd424`.
- **Fork source:** the `t3-fork.json` in the archive records the repository
  `pingdotgg/enriched-markdown`, commit
  `4287c5d3b306dfc0dca3604606baf7a02a5ec1c4`, on the upstream commit
  `1d00a92abc3f7cf953946cf42f999523dec699dc`. The package version is
  `1.2.0-t3.18`.
- **Unchanged from T3:** the fork now carries the table-cell copy fix
  (`serializeTableCell` on Android, `markdownFromTableCellNode` on iOS), so
  Solus uses T3's archive as it is. Do not change an archive in this
  directory with a patch: Bun does not apply `patchedDependencies` to a
  `file:` archive, and the next archive drops it without a trace.
- **SHA-256:** `28dec670d521760cc4ae4e9aeb0a23b5451b60cabfc20f4a137eac5f57aeecd6`
- **Integrity:** `sha512-zVB0Kaac8iNHumPDCV/CBR3I8p+lbFIO56kQGyIMH7ja5I6mHBhw1R/l48TkNye3wk2wsXXX51m1FYa9o+OwDQ==`
  (the same in `bun.lock` and in T3's `pnpm-lock.yaml`)
- **Changes from `t3.16`:** `renderers.code` replaces a code block with a
  React element (Solus draws closed Mermaid fences with it), `onTextPress` reports a tap
  on plain text (Solus does not use it), a link block's `label` is the URL for
  a bare link (Solus has no link renderer), math has spoken labels, and on iOS
  a new message draws in its first frame. The app now generates the library's
  codegen itself (upstream #1121), so the native clients must be built again.
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
