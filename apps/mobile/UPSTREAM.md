# Upstream sources

This app wears T3 Code's mobile interface with Solus's theme (plan 017 §3
amendment, 2026-10-04). T3's screens, components, navigation presets, and
styling system are ported at T3's own paths, with an attribution line at the
top of each ported file. It copies no T3 state, connection, or authentication
runtime: each ported screen reads Solus stores. It imports nothing from the T3
checkout at build time.

- **Source:** T3 Code, `apps/mobile/`, commit `43bd667739` (checked 2026-10-02).
  The settings, pull request, and files rows were read at commit `77823bd102` (2026-10-03).
- **License:** MIT. The notice is reproduced below and must stay with any
  adapted file.

## Ported interface (2026-10-04, commit `77823bd102`)

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `global.css`, `metro.config.js` (uniwind) | `global.css`, `metro.config.js` | Same styling system: uniwind, 14px rem, T3's type scale, `font-t3-*` utilities. The text is the system font, as Solus's `--solus-font-family`; the DM Sans files in app.json `expo-font` are no longer referenced. |
| `src/lib/mobileTheme.ts`, `scripts/generate-uniwind-theme.ts`, `generated-uniwind-theme.css` | `src/lib/mobileTheme.ts`, `scripts/generate-uniwind-themes.mts` | T3's token derivation run on the Solus palette (`src/theme/theme-colors.ts`); one theme in light and dark; no OKLCH input, no theme library. |
| `adaptive-colors.css` | `generated-uniwind-themes.css` (adaptive tokens) | T3's Tailwind status pairs, unchanged. |
| `src/components/*` | `src/components/*` | Voice components are not ported yet; media and preview components are in the table below. A composer image opens full screen inside `ComposerAttachmentStrip` rather than through the caller. `ProjectFavicon` draws T3's folder fallback until Solus's favicon resolver moves to client-core. `ProviderIcon` maps `claude-code` to T3's `claudeAgent` mark. |
| `src/lib/*` (appearancePreferences, mobileThemeRuntime, copyTextWithHaptic, layout helpers, …) | `src/lib/*` | Effect error classes replaced with plain `Error` subclasses; single theme. |
| `src/native/*`, `src/features/layout/*` | `src/native/*`, `src/features/layout/*` | Unchanged, except the v5 navigation files in the table below. |
| `src/features/settings/appearance/AppearancePreferencesProvider.tsx` | same path | Solus adapter with T3's context shape: light/dark is the person's `themeMode`; text sizes stay on the device. |
| `patches/uniwind@1.11.0.patch`, `@react-native-menu__menu@2.0.0`, `react-native-gesture-handler@3.2.1`, `react-native-keyboard-controller@1.22.6`, `expo-glass-effect@58.0.3`, `expo-blur@58.0.3`, `@legendapp__list@3.3.5`, `@react-navigation%2Fnative-stack@7.17.6` | `patches/` | Unchanged; versions match exactly (Expo SDK 58). The native-stack patch is T3's copy at `e2e95a39d` (it adds `presentationEnvelope`). The `react-native-screens@4.28.0` patch is removed: the v5 fork in `deps/` has its changes. |

| `src/navigation/RootNavigator.tsx`, `src/features/layout/AdaptiveWorkspaceLayout.tsx`, `workspace-*`, `src/lib/layout.ts`, `src/lib/adaptive-navigation.ts`, `src/lib/useMobileNavigationTheme.ts` | `src/Stack.tsx`, the same layout files | T3's header presets, its workspace navigator, and the iPad split view; routes keep Solus names and one flat stack (no nested Settings or New Task navigator); settings and new task are form sheets on a compact iPhone. |
| `src/features/home/*`, `src/features/threads/threadListV2.ts`, `thread-list-v2-*`, `ThreadNavigationSidebar.tsx`, `sidebar-*` | the same paths | Data from `app.threads` (every session on every host) and `app.threadList` (settled, snoozed, live status, PR links). No delete, archive, pin, reorder, drafts, or custom snooze sheet. |
| `src/features/threads/ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx`, `ThreadFeed.tsx`, `thread-work-log*`, `floating-working-*`, `Pending*Card.tsx`, `ThreadPlanCard.tsx`, `ThreadComposer.tsx`, `ThreadSettingsSheet.tsx`, `ThreadQueueSheet.tsx`, `NewTask*`, `src/components/Composer*.tsx` | the same paths | On the Solus conversation controller. The composer editor is a TextInput. Markdown renders through Enriched (see the Enriched Markdown table below). No forking, review comments, terminal, dictation, or timestamps. |
| `src/features/threads/ThreadAgents.tsx`, `agent-card-presentation.ts` | `features/threads/thread-subagent-group.tsx`, `SubagentRow.tsx`, `SubagentStatusDot.tsx`, `ThreadAgentsSheet.tsx`, `threadAgentsPresentation.ts`, `subagent-card-presentation.ts` | On Solus agents: other Solus sessions (`features/conversation/lib/agent-cards.ts`, the desktop card rules) and provider subagent calls. The Agents sheet is T3's form-sheet route (`ThreadAgents`, detents 0.5/0.9, native header on iOS). Provider icons are the built-in ones; the host sends no icon URLs. A fifth tone, waiting, covers Needs input and Rate limited. A provider subagent has no session, so its row does not open; there is no read-only child thread screen. |
| `src/widgets/AgentActivity.tsx`, `src/features/live-activity/*`, `plugins/withWidgetLogoAsset.cjs`, `plugins/lib/addWidgetAssetCatalog.cjs` | `src/widgets/AgentActivity.tsx`, `src/features/agent-awareness/agentLiveActivity*.ts`, `plugins/withWidgetLogoAsset.cjs`, `plugins/lib/addWidgetAssetCatalog.cjs` | The Live Activity (Lock Screen, Always-On Display, Dynamic Island) on `expo-widgets`. Solus has no relay or APNs: the app builds the aggregate from its host lists and updates the card while it runs; the 10-minute stale date covers suspension. No `expo-widgets` patch, so no Liquid Glass tint or rendering-mode check; no home-screen Agent Activity widget; a `limited` (rate-limited) phase; the Solus mark; `solus://thread/<host>/<session>` links. |
| `src/features/settings/*`, `src/features/settings/components/*`, `src/features/connection/*`, `src/features/hosts/*` (UI), `src/features/onboarding/WelcomeScreen.tsx`, `src/features/account/*Screen.tsx` | `src/features/settings`, `src/features/connection`, `src/features/cloud` | Solus words ("host", "Solus Cloud") and data. No theme library, Clerk, T3 Connect, scheduled tasks, usage, or host rename. |
| `src/features/files/*`, `src/features/notifications/NotificationsScreen.tsx`, `src/features/devices/BuildsScreen.tsx`, `src/features/projects/*` | `src/features/files`, `src/features/threads/git`, `src/features/review`, `src/features/archive` | T3's list, sheet, and code-surface styles on Solus screens T3 does not have in this form. Syntax colors and media previews are in the table below. |

## v5 navigation (2026-10-12, commit `e2e95a39d`)

T3 Code #16733 (v5 navigation and native iPad columns), #18396, and #18476.
The fork is vendored in `deps/` (see `deps/README.md`).

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `src/native/createV5StackNavigator.ios.tsx`, `.tsx`, `V5StackHeader.ios.tsx`, `NativeColumnContent.ios.tsx`, `NativeWorkspaceColumns.ts`, `v5-workspace-context.tsx`, `workspace-stack-projection.ts`, `StackHeader.tsx`, `NativeHeaderToolbar.tsx` | the same paths | No sheet-stack navigator (Solus has no nested navigators), no inspector column. No `T3NativeControls` module: iPad columns need iOS 26 (Liquid Glass), the column's header height is its safe area top, and there are no fold (Duo) metrics. |
| `src/features/layout/createWorkspaceStackNavigator.ios.tsx`, `.tsx` | the same paths | Thread keys from Solus `Thread` params; the empty detail column has only the sidebar button. |
| `src/features/workspace/WorkspaceNativeTabs.ios.tsx`, `WorkspaceTabsContext.tsx`, `WorkspaceToolbar*.tsx`, `WorkspaceSidebarTabs*.tsx`, `use-sidebar-workspace-tabs.ts`, `assets/icons/pull-request*.png` | the same paths, `useSystemWorkspaceTabBar.ts` | The provider also keeps the Pull Requests filters. No scroll offsets for each tab and no `focusSearch` keyboard command. `HomeHeader.tsx` and `PullRequestsHeader.tsx` are empty on iOS, as T3's `usesWorkspaceToolbar`. |

## Syntax colors and media (2026-10-04, commit `77823bd102`)

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `src/features/review/shikiReviewHighlighter.ts`, `incrementalSnippet.ts`, `reviewHighlighterEngine.ts`, `reviewHighlightedToken.types.ts` | the same paths | Snippet and source-file highlighting only: no review diffs, word diffs, or `@pierre/diffs` (a local extension map replaces `getFiletypeFromFileName`). The Effect Schema error is a plain `Error` subclass. |
| `src/features/files/sourceHighlightingState.ts` | the same path | T3's Effect atom family is a promise cache with the same idle TTL and a `useSourceHighlight` hook. |
| `src/features/files/SourceFileSurface.tsx` | the same path | The JavaScript surface only (no `t3-review-diff` canvas, no attachment selection mode, no line target); Solus's code font; a failed highlight shows "Plain text" and highlighting shows no loading strip. |
| `src/features/files/WorkspaceFileImagePreview.tsx` | the same path | Solus's host connection: the image loads through `host-media-url.ts`. No media actions menu. |
| `src/features/threads/thread-context-divider.tsx` | the same path | Draws only the compaction divider (no handoff divider). It reads its item from the conversation store and uses the desktop divider words (`@solus/contracts/context-compaction`). |
| `src/components/FilePreview.tsx`, `MediaImagePreview.tsx`, `MediaSourceCaption.tsx`, `MediaVideoPlayer.tsx`, `VideoThumbnailImage.tsx`, `AudioFilePreview.tsx`, `src/lib/videoThumbnails.ts` | the same paths | Images only in `FilePreview` (no Quick Look module or document viewer). No media actions menu or share sheet. Thumbnails come from a URL only. |
| `patches/expo-audio@58.0.4.patch` | `patches/` | Unchanged; versions match exactly. `expo-audio` builds from source so its patch applies. |
| `metro.config.js` (Shiki) | `metro.config.js` | T3's resolution of `shiki` and every `@shikijs/*` package from the app's Shiki 4.2.0. |

## Enriched Markdown (2026-10-13, T3 `main` at `42160f2925`)

T3 Code #16979 (`c5d7309152`, Markdown through Enriched) and #18679
(`701fc83169`, the `t3.11` archive that honors `enableMath: false`). Every
Markdown surface (thread messages and plans, Markdown file previews, pull
request text) draws through Software Mansion's Enriched Markdown in T3's fork,
vendored in `deps/` (see `deps/README.md`). The old `modules/t3-markdown-text/`
renderer, `react-native-nitro-markdown`, `react-native-nitro-modules`, and their
patches are removed.

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `src/native/EnrichedMarkdownText.tsx` | the same path | T3's styles, native pills, iOS link menus, code-block header and tree-sitter colors, tables, and media slots. No context chips, context clipboard (`selectionClipboard`), skills recognition, or file chip menu (so no `AndroidAnchoredMenu` or `ActionSheetIOS` long press): a link's long press on iOS shows Open, Copy, and Share. The text is the system font, so bold text and headings ask for a bold weight (T3's DM Sans Bold is a font file). |
| `src/native/SelectableMarkdownText.tsx`, `SelectableMarkdownText.types.ts`, `useEnrichedLinkVariants.ts` | the same paths | One file for iOS and Android, as T3; the `.ios` and `.android` files are removed. Props are only what Solus uses: no `skills`, `fileContextMenu`, `linkCustomization`, `contextClipboardFragment`, or margins. Pills for file links and the GitHub mark only. |
| `src/lib/markdownLinks.ts`, `markdownLinkTargets.ts`, `markdownFileIcons.ts`, `markdownFileIcons.generated.ts`, `markdownLinkIcons.ts`, `assets/file-icons/`, `assets/link-icons/` | the same paths (moved out of `modules/t3-markdown-text/` in #16979) | `markdownLinkTargets.ts` is a local copy of `packages/client-runtime/src/markdownLinks.ts` and `packages/shared/src/path.ts` (only the file-link parser; Enriched's inline-code pattern replaced `inlineCodeFilePathCandidate`). No thread links (`t3-thread://`), no `resolveMarkdownInlineCodePresentation` or `markdownIconAssetUri` (Solus has no work log chips or composer editor). The video extensions of `packages/shared/src/video.ts` are a pattern in `markdownLinks.ts`. |
| `src/lib/enrichedLinkPresentation.ts` | the same path | Only the link-variant pattern and the inline-code file pattern: no context or skill presentation. |
| `src/lib/markdownDocument.ts` | the same path | Only `markdownWithHtml` (HTML image embeds, `<details>`, and comments in Markdown); no `parseMarkdownDocument` or `markdownImageSources` (no image gallery). Adds `unified`, `remark-parse`, `remark-gfm`, and `@types/mdast` to the app. |
| `src/features/threads/ThreadMarkdown.tsx`, `src/lib/nativeMarkdownTextStyle.ts` | `src/features/threads/ThreadFeed.tsx` (`useMarkdownStyles`, `onMarkdownLinkPress`, `renderMarkdownImage`), `src/native/useMarkdownImageSource.ts` | File links open the Solus file screen. A standalone host image or video is a React media slot that loads through a URL the host signs (`host-media-url.ts`); an image Enriched draws itself (in a table, list, or quote) gets the same signed URL through `resolveImageSource`, and a press on it opens the image preview. No skills list, file chip menu, artifact templates, Codex citations, context chips, thread links, or PDF viewer. |
| `src/features/threads/ThreadMarkdownImage.tsx`, `markdownImageSize.ts` | the same paths | Unchanged by #16979 except T3's SVG drawing (`format: "svg"`, `resolveSvgImageSize`), which is not ported: React Native `Image` draws raster images only. |
| `src/features/files/FileMarkdownPreview.tsx` | the same path | Images and links resolve next to the Markdown file and load through `host-media-url.ts`, also for an image Enriched draws itself. No media actions menu, video or PDF viewer modal. |
| `src/features/prs/detail/PullRequestMarkdown.tsx` | `src/features/pull-requests/PullRequestMarkdown.tsx` | GitHub media in an image Enriched draws itself loads through the host's signed URL (`pull-request-media.ts`), as the media slots do. No image gallery or `githubMarkdownLinks` rewrite. |
| `deps/react-native-enriched-markdown-1.2.0-t3.11.tgz`, `package.json` (`enriched-markdown`, `expo.install.exclude`), root `package.json` (`trustedDependencies`) | `apps/mobile/deps/`, `apps/mobile/package.json`, `pnpm-workspace.yaml` (`allowBuilds`) | Bun runs the archive's `postinstall` (tree-sitter grammars) only for a trusted package, so the root lists it in `trustedDependencies` with the packages Bun trusted by default. Needs `pod install` and a new native build. |

Not adopted from #16979: `modules/t3-source-text/` (Solus's `SourceFileSurface`
is the JavaScript surface), the native FormSheet for context previews
(`ComposerContextSheet`, `ContextSheetSize`), terminal line selection, the iOS
worktree details sheet, the media actions menu and `state/mediaActions.ts`, the
`ThreadMarkdownVideo` and PDF viewers (Solus's `MediaVideoPlayer` keeps playing
videos), `markdownMedia.ts` and `markdownMediaSource.ts` (T3's asset routes; the
host signs Solus media), `composerChipPresentation.ts` and `fileChipMenu.ts`
(no composer chips or file chip menu), and `scripts/sync-pierre-file-icons.mjs`.
Solus also loses the old renderer's `@path` mention chips in prose: T3 replaced
them with context references, which Solus does not have.

## Adapted pieces

| Solus file | T3 source | What was taken | Local changes |
| --- | --- | --- | --- |
| `src/features/layout/lib/layout.ts` | `src/lib/layout.ts` | The split-layout thresholds: a sidebar needs a window at least 720 wide and 600 tall; the sidebar is 32% of the width, from 280 to 380. | Only the compact/split decision. The auxiliary pane, the file inspector, and the animated sidebar are not adopted. |
| `src/features/hosts/PairHostScreen.tsx` | `src/features/connection/ConnectionsNewRouteScreen.tsx` | The presentation: a scanner shown on request, camera permission asked only when scanning is chosen, the "open Settings" path after a permanent denial, and a lock against duplicate scans. | Rewritten for Solus. Pairing links, codes, `/health`, and `/pair` are Solus's own (`@solus/client-core/pairing`). A confirmation step shows the target before pairing. No Uniwind, no T3 components. |
| `modules/solus-keyboard-commands/ios/SolusKeyboardCommandsModule.swift` | `modules/t3-native-controls/ios/T3KeyboardCommandsModule.swift` | The mechanism: an Expo view that wraps the app, offers `UIKeyCommand`s to the responder chain, takes first responder when no text input has it, and reports the command as an event. | Solus commands and meanings only (send, new session, sidebar, focus input, stop, back); no command palette or thread jumps; no Android counterpart. |
| `src/features/keyboard/keyboard-commands.ts` | `src/features/keyboard/hardwareKeyboardCommands.ts` | The rule that the newest mounted handler answers first and may pass a command on. | Plain class with listeners; no `useSyncExternalStore` registry of its own. |
| `src/features/account/CloudHostsScreen.tsx` | `src/features/cloud/ConnectOnboardingRouteScreen.tsx` | Pull to refresh on the account's host list, and a signed-out explanation. | Rewritten for Solus account services: device sign-in, the host directory, organizations, and managed host start. No Clerk, relay, or Effect. |
| `src/features/settings/SettingsScreen.tsx`, `AppearanceScreen.tsx` | `src/features/settings/SettingsRouteScreen.tsx`, `SettingsAppearanceRouteScreen.tsx` | The settings root's section order (connections, interface, server settings, app) and the three color-scheme cards with a phone preview. | Solus sections: each host's settings are a row per host, not a filter menu. No theme palettes or text-size slider. The choice stays on the device. |
| `src/features/files/FilesScreen.tsx` | `src/features/files/ThreadFilesRouteScreen.tsx` | A pushed folder screen per level, folders first. | Built on the host's flat file index (`listProjectFiles`); read-only. |

## Upstream fixes ported (2026-10-09)

T3 Code mobile fixes merged after the port, applied where Solus has the same defect.

| T3 pull request | Solus files | Local changes |
| --- | --- | --- |
| #16729, highlight batches keep grammar state | `src/features/review/shikiReviewHighlighter.ts` | None. |
| #15397, elapsed-time clocks pause while hidden | `src/features/threads/use-visible-second-clock.ts` | The working timer and the agent rows share it. The AppState gate is a plain function (`tickWhileAppActive`) so a Bun test can drive it. |
| #16296, collect the UI runtime on an iOS memory warning | `src/lib/ui-runtime-memory-warning-gc.ts`, `src/App.tsx` | A start/stop function in the app's lifecycle effect instead of a hook. |

## Upstream fixes ported (2026-10-13, T3 `main` at `42160f2925`)

T3 #18534, #18535, #18536, and #18538 (shared chips, sliders, notices, and the
component catalog) merged only into an open stack (#18532); port them when
they reach T3 `main`. #18679 is in the Enriched Markdown section. #18527 (native-sized pull request bar) is in `PullRequestActionToolbar.tsx`.

| T3 pull request | Solus files | Local changes |
| --- | --- | --- |
| #18510, shared list rows and sections | `src/components/ListRowLayout.tsx`, `ListRow.tsx`, `ListSection.tsx`, `src/features/settings/components/SettingsRow.tsx`, `SettingsSection.tsx` | `RowLeadingSymbol` draws the leading icon (same values). `ListRow` takes an optional `accessibilityHint`. `SettingsRow` keeps `onPress` (one stack, no settings-sheet targets). |
| #18511, shared toggle rows | `src/components/ListToggleRow.tsx`, `src/features/settings/components/SettingsSwitchRow.tsx`; `SettingsControlRow.tsx` removed | The mixed value says "every selected host". |
| #18516, shared choice rows | `src/components/ListChoiceRow.tsx`, `MaterialRadioIndicator.tsx`, `src/features/settings/components/SettingsChoiceRow.tsx` | `ListChoiceRow` takes an optional leading `icon` (permission modes). The radio indicator is one file with only T3's drawn ring in `--color-primary-text`; Solus has no system colors, so the Compose `RadioButton` branch is not ported. |
| #18506, theme contrast across surfaces and actions | `src/lib/mobileTheme.ts`, `generated-uniwind-theme.css`, `src/features/prs/detail/PullRequestMergeControls.tsx`, `src/features/threads/{PendingApprovalCard,PendingUserInputCard,ThreadFeed,thread-context-divider}.tsx` | Only the `--color-prominent-action` tokens (ink with a canvas label) and the theme-token classes. The grouped-card and tint changes apply only to T3's color themes. The dock, file-tree selection, work-log image, clone banner, browser preview, HTML render, and MCP fullscreen have no Solus counterpart. |
| #18698, pull requests load from another host when theirs is offline | `src/features/prs/lib/pull-request-host-fallback.ts`, `use-pull-request-host-fallback.ts`, `lib/pull-request-list.ts`, `use-pull-request-list.ts`, `PullRequestsScreen.tsx`, `PullRequestScreen.tsx` | Matches the project `repositoryKey` from the thread directory's checkouts; the repository comes from the saved pull request, else from the route's own checkout. The route moves `hostId` and `projectPath`. Review drafts are kept per host and do not move with the route (T3 has the same limit). |
| #18565, menu dismiss taps no longer press the view underneath | `modules/solus-menu-dismiss-gate/` (`ios/SolusMenuDismissTouchGate.swift`, podspec, `expo-module.config.json`, `LICENSE`) | Its own iOS module (Solus has no `t3-native-controls`). Classes have a `Solus` prefix; the gate is unchanged. A trimmed copy of expo-modules-core's `SystemMenuTouchGate`; `LICENSE` has the T3 Tools and Expo MIT notices. Needs a native build. |
| #18507, native scroll-edge effects on forms and pull requests | `src/native/NativeScrollViewMarker.tsx`, `src/components/ScreenScrollView.tsx`, `src/native/createV5StackNavigator.ios.tsx`, `src/features/prs/PullRequestScreen.tsx`, `PullRequestDiscussionScreen.tsx` | Settings screens get it through `ScreenScrollView`, with no edit to each screen. Solus never forced `soft` on pull request screens. |

## Pull requests and the diff surface (2026-10-12, commit `e2e95a39d`)

T3 Code #18126 (browse and review pull requests), #18267 (guided reviews), and
#18351 (pull requests offline). Plan: `docs/plans/mobile-pull-requests.md`.

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `modules/t3-review-diff/` (iOS and Android diff canvas, podspec, native tests) | `modules/t3-review-diff/` | Package name `@t3tools/mobile-review-diff-native` kept. Native code is unchanged; each native file has an attribution line. The podspec license is `MIT`. Needs a new native build. |
| `src/features/diffs/*`, `src/features/review/{reviewModel,reviewWordDiffs,nativeReviewDiffAdapter,reviewCommentSelection,useReviewCommentSelectionController,useNativeReviewDiffBridge,useNativeReviewDiffHighlighting,reviewDiffHighlightScheduler,reviewDiffBridgeKeys}.ts`, `src/features/settings/appearance/useAppearanceCodeSurface.ts`, `src/native/nativeViewResolutionError.ts` | the same paths | Plain TypeScript instead of Effect. One theme, so `createNativeReviewDiffTheme` takes no theme id. The comment selection gives a target to a callback; it does not open T3's thread review sheet. No thread or checkpoint review (`ReviewSheet`, `useReviewSections`, `reviewState`), and no review comments sent to the agent composer. |
| `metro.config.js` (`@pierre/diffs`), `tsconfig.json` `paths` | T3's `@pierre/diffs` patch | `@pierre/diffs` 1.4.1 exports no `./utils/*` or `./types`. Metro and `tsc` resolve those two deep paths to `dist/` instead of a package patch, so the phone bundle does not load the web renderer. |
| `src/features/prs/pull-request-*.ts`, `src/features/prs/lib/pull-request-*.ts`, `src/platform/pull-request-cache-sqlite.ts` | `src/features/pull-requests/use*.ts`, `pullRequest*.ts`, `guide/reviewGuideState.ts`; `packages/client-runtime/src/state/{pullRequests,queryPersistence}.ts`; `src/persistence/mobile-database.ts` | Solus stores (`Listeners`, `LoadState`) instead of Effect atoms. Reads go through the host for every connected host. Commits and reviewers come from the host's overview. The pull request cache keeps T3's bounds (30 days, 256 records, 32 MiB for each host, 4 MiB for each answer) and also keeps review drafts and viewed files (the device's own marks, or the copy of GitHub's for offline display). Agent work starts a Solus session on the host's checkout; no "watch" task. |
| `src/features/workspace/*`, `src/features/home/HomeRouteScreen.tsx`, `ThreadListFilters.tsx`, `home-list-options.ts` | `src/features/workspace/*`, `src/features/home/ThreadListFilters.tsx` (#18476 stock tab bar and saved list filters) | Chats and Pull Requests tabs. iOS uses the UIKit tab bar (`WorkspaceNativeTabs.ios.tsx`) with compose as its search-role tab, and T3's header toolbar (`WorkspaceToolbar.ios.tsx`); Android has a Material navigation bar in React Native (T3 has a native view). One query for both tabs. Both tabs' filters are kept on the device and checked with zod when read. |
| `src/features/prs/PullRequestsScreen.tsx`, `PullRequestListRow.tsx`, `PullRequestListFilters.tsx`, `PullRequestsHeader*.tsx`, `use-pull-request-list.ts`, `lib/list-filter-menu.ts` | `src/features/pull-requests/PullRequestsScreen.tsx`, `PullRequestListRow.tsx`, `PullRequestListFilters.tsx`, `usePullRequestList*.ts`, `MaterialPullRequestToolbar.android.tsx` | Every host in one list. The old per-host `PullRequests` route is removed: `Home { tab: 'pullRequests', hostId }` opens the tab for one host. |
| `src/features/prs/PullRequestScreen.tsx`, `PullRequestFilesScreen.tsx`, `PullRequestAskScreen.tsx`, `detail/*`, `assets/icons/file-diff*.png`, `PullRequestReviewSheet.tsx`, `PullRequestInlineCommentScreen.tsx`, `PullRequestDiscussionScreen.tsx`, `PullRequestReviewersScreen.tsx`, `lib/{pull-request-markdown,bot-badge-images,pull-request-file-filters,pull-request-diff-comments,pull-request-guide-tour}.ts` | `src/features/pull-requests/PullRequestRouteScreen.tsx` and its parts, `PullRequestControls.tsx` (`PullRequestActionToolbar`), `guide/*` | T3's layout: Overview, Guide, and Activity tabs (commits are in Activity), the actions menu in the header, and the bottom toolbar (agent tasks, main action, changed files). The changed files open on one diff screen (`PullRequestFiles`), not one screen for each file. The main action asks an agent through a question sheet (`PullRequestAsk`), because Solus does not link threads to a pull request. The Guide tab shows the Solus `ReviewGuide`: one stop for each section, with its `hunks` as excerpts. Stack merge, workflow approval, and revert use the host's calls (`prMergeStack`, `prPendingWorkflowRuns`/`prApproveWorkflowRuns`, `prRevert`); stack merge shows as its own "Merge stack" button, also when only this layer lands (as on desktop and web). Viewed files are GitHub's when the host sets `capabilities.viewedFiles` (written in a short batch, no write offline); an older host keeps them on the device. GitHub media loads through `prMediaUrl` (collaboration plane) when the host has `githubMediaUrls`, else by its direct address. Images in a description are found by a line scan, not a Markdown parser. |
| `src/features/prs/PullRequestLabelsScreen.tsx` | none | Solus addition: T3's phone app shows labels but does not edit them. |

## Evaluated, not adopted in milestone one

| T3 source | Reason |
| --- | --- |
| `modules/t3-composer-editor/`, `src/native/T3ComposerEditor.*` | Same reason. The composer is a React Native `TextInput`. |
| `modules/t3-terminal/` | Later parity work. `t3-terminal` carries its own third-party notices (Ghostty, MesloLGS NF) that must come with it. |
| `src/connection/`, `src/state/`, Clerk and T3 Connect configuration, `Stack.tsx` | Not to be copied (plan 017 §3). |

No Expo notice applies: no file that carries one was adopted. The Bluesky PBC
notice of the old `modules/t3-markdown-text/` (from `react-native-uitextview`)
went with that module: no code from it remains.

## T3 Code license

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
