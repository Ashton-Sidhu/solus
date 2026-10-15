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

## `react-native-enriched-markdown-1.2.0-t3.11.tgz`

T3 Code's fork of Software Mansion's Enriched Markdown. It draws all the
app's Markdown (`src/native/EnrichedMarkdownText.tsx`): native text with
selection, pills for file links, iOS link menus, code blocks with a header and
tree-sitter colors, tables, and images and videos in React media slots. Over
upstream, the fork adds clipboard metadata, parsed asset manifests, signed
image sources, React media slots, and development-host autolinks.

- **Copied from:** T3 Code, `apps/mobile/deps/react-native-enriched-markdown-1.2.0-t3.11.tgz`,
  `main` at `42160f2925` (the archive was added in T3 Code #18679, `701fc83169`,
  after #16979, `c5d7309152`, moved T3 to Enriched).
- **Fork source:** the `t3-fork.json` in the archive records the repository
  `pingdotgg/enriched-markdown` (branch `fork/t3-mobile`), commit
  `3824d119a1ed6206f51ba3ec8ddf9ff93b8852f9`, on the upstream commit
  `9684fdf425d3aa86825b69c8f65a5dedb03630bf`.
- **SHA-256:** `29c0867f3d0ecae90b3cf4cd6d0f029ad1e860fcd7cd7dcdb843480818690b0e`
- **License:** MIT (`LICENSE` in the archive, Software Mansion).

The archive's `postinstall` downloads the tree-sitter grammars for code
colors. Bun runs it only for a trusted package, so the root `package.json`
lists `react-native-enriched-markdown` in `trustedDependencies`. A
`trustedDependencies` list replaces Bun's default list, so it also names the
packages Bun trusted by default that this repository builds at install:
`electron-winstaller`, `esbuild`, `fs-xattr`, `macos-alias`, and `workerd`.
The `enriched-markdown` block in `apps/mobile/package.json` turns off math (no
RaTeX download) and video, as T3 does.

T3's procedure to build an archive is in its `apps/mobile/deps/README.md`. To
replace this archive, copy the new archive from T3 Code, change the path in
`apps/mobile/package.json`, record the new source and SHA-256 here, and run
`bun install` at the repository root. The native clients must be built again
when this archive changes.
