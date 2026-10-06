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
| `src/native/*`, `src/features/layout/*` | `src/native/*`, `src/features/layout/*` | Unchanged; the Mail-style search toolbar uses T3's `react-native-screens@4.28.0` patch. |
| `src/features/settings/appearance/AppearancePreferencesProvider.tsx` | same path | Solus adapter with T3's context shape: light/dark is the person's `themeMode`; text sizes stay on the device. |
| `patches/uniwind@1.11.0.patch`, `@react-native-menu__menu@2.0.0`, `react-native-screens@4.28.0`, `react-native-gesture-handler@3.2.1`, `react-native-keyboard-controller@1.22.6`, `expo-glass-effect@58.0.3`, `expo-blur@58.0.3`, `@legendapp__list@3.3.5`, `@react-navigation%2Fnative-stack@7.17.6` | `patches/` | Unchanged; versions match exactly (Expo SDK 58). |

| `src/navigation/RootNavigator.tsx`, `src/features/layout/AdaptiveWorkspaceLayout.tsx`, `workspace-*`, `src/lib/layout.ts`, `src/lib/adaptive-navigation.ts`, `src/lib/useMobileNavigationTheme.ts` | `src/Stack.tsx`, the same layout files | T3's header presets and the iPad split view; routes keep Solus names; settings and new task are form sheets on a compact iPhone. |
| `src/features/home/*`, `src/features/threads/threadListV2.ts`, `thread-list-v2-*`, `ThreadNavigationSidebar.tsx`, `sidebar-*` | the same paths | Data from `app.threads` (every session on every host) and `app.threadList` (settled, snoozed, live status, PR links). No delete, archive, pin, reorder, drafts, or custom snooze sheet. |
| `src/features/threads/ThreadRouteScreen.tsx`, `ThreadDetailScreen.tsx`, `ThreadFeed.tsx`, `thread-work-log*`, `floating-working-*`, `Pending*Card.tsx`, `ThreadPlanCard.tsx`, `ThreadComposer.tsx`, `ThreadSettingsSheet.tsx`, `ThreadQueueSheet.tsx`, `NewTask*`, `src/components/Composer*.tsx` | the same paths | On the Solus conversation controller. The composer editor is a TextInput. Markdown renders through T3's native module (see the media and Markdown table below). No forking, review comments, terminal, dictation, or timestamps. |
| `src/features/threads/ThreadAgents.tsx`, `agent-card-presentation.ts` | `features/threads/thread-subagent-group.tsx`, `SubagentRow.tsx`, `SubagentStatusDot.tsx`, `ThreadAgentsSheet.tsx`, `threadAgentsPresentation.ts`, `subagent-card-presentation.ts` | On Solus agents: other Solus sessions (`features/conversation/lib/agent-cards.ts`, the desktop card rules) and provider subagent calls. The Agents sheet is T3's form-sheet route (`ThreadAgents`, detents 0.5/0.9, native header on iOS). Provider icons are the built-in ones; the host sends no icon URLs. A fifth tone, waiting, covers Needs input and Rate limited. A provider subagent has no session, so its row does not open; there is no read-only child thread screen. |
| `src/features/settings/*`, `src/features/settings/components/*`, `src/features/connection/*`, `src/features/hosts/*` (UI), `src/features/onboarding/WelcomeScreen.tsx`, `src/features/account/*Screen.tsx` | `src/features/settings`, `src/features/connection`, `src/features/cloud` | Solus words ("host", "Solus Cloud") and data. No theme library, Clerk, T3 Connect, scheduled tasks, usage, or host rename. |
| `src/features/files/*`, `src/features/prs/*`, `src/features/notifications/NotificationsScreen.tsx`, `src/features/devices/BuildsScreen.tsx`, `src/features/projects/*` | `src/features/files`, `src/features/threads/git`, `src/features/review`, `src/features/archive` | T3's list, sheet, and code-surface styles on Solus screens T3 does not have in this form. Syntax colors and media previews are in the table below. |

## Native Markdown, syntax colors, and media (2026-10-04, commit `77823bd102`)

| Solus path | T3 source | Local changes |
| --- | --- | --- |
| `modules/t3-markdown-text/` (iOS Fabric text view, Android selection module, JS renderer, file and link icons, `LICENSE`, `UPSTREAM.md`) | `modules/t3-markdown-text/` | Package name `@t3tools/mobile-markdown-text` kept: the codegen spec and podspec carry it. T3's composer context references (`t3-context://` chips, the context clipboard fragment, `contextClipboardFragment`) are removed; the copy ranges keep `$skill` and `@file` sources with an empty fragment. `src/markdownLinkTargets.ts` is a local copy of `packages/client-runtime/src/markdownLinks.ts` and `packages/shared/src/path.ts`; `src/fileMentions.ts` copies the `@path` mention scan of `packages/shared/src/composerInlineTokens.ts` and the video extensions of `packages/shared/src/video.ts`. The module's vitest files are ported to `tests/unit/`. Native code is unchanged. The module carries the Bluesky PBC MIT notice (`modules/t3-markdown-text/LICENSE`). |
| `src/native/SelectableMarkdownText.ios.tsx`, `.android.tsx`, `.tsx` | the same paths | No `hasNativeSelectableMarkdownText`: every Solus client is iOS or Android, so T3's `react-native-nitro-markdown` `Markdown` fallback is not ported. |
| `src/features/review/shikiReviewHighlighter.ts`, `incrementalSnippet.ts`, `reviewHighlighterEngine.ts`, `reviewHighlightedToken.types.ts` | the same paths | Snippet and source-file highlighting only: no review diffs, word diffs, or `@pierre/diffs` (a local extension map replaces `getFiletypeFromFileName`). The Effect Schema error is a plain `Error` subclass. |
| `src/features/files/sourceHighlightingState.ts` | the same path | T3's Effect atom family is a promise cache with the same idle TTL and a `useSourceHighlight` hook. |
| `src/features/files/SourceFileSurface.tsx` | the same path | The JavaScript surface only (no `t3-review-diff` canvas, no attachment selection mode, no line target); Solus's code font; a failed highlight shows "Plain text" and highlighting shows no loading strip. |
| `src/features/files/FileMarkdownPreview.tsx`, `WorkspaceFileImagePreview.tsx` | the same paths | Solus's host connection: images and links resolve next to the Markdown file and load through `host-media-url.ts`. No media actions menu. |
| `src/features/threads/ThreadMarkdown.tsx`, `ThreadMarkdownImage.tsx`, `markdownImageSize.ts`, `src/lib/nativeMarkdownTextStyle.ts` | `src/features/threads/ThreadFeed.tsx` (`useMarkdownStyles`, `onMarkdownLinkPress`, `renderMarkdownImage`), `ThreadMarkdownImage.tsx`, `markdownImageSize.ts` | File links open the Solus file screen; host images and videos load through a signed URL; no skills list (Solus has none on the phone), no file chip menu, no artifact templates or Codex citations. |
| `src/components/FilePreview.tsx`, `MediaImagePreview.tsx`, `MediaSourceCaption.tsx`, `MediaVideoPlayer.tsx`, `VideoThumbnailImage.tsx`, `AudioFilePreview.tsx`, `src/lib/videoThumbnails.ts` | the same paths | Images only in `FilePreview` (no Quick Look module or document viewer). No media actions menu or share sheet. Thumbnails come from a URL only. |
| `patches/expo-audio@58.0.4.patch`, `patches/react-native-nitro-markdown@0.5.8.patch`, `patches/react-native-nitro-modules@0.35.9.patch` | `patches/` | Unchanged; versions match exactly. `expo-audio` builds from source so its patch applies. |
| `metro.config.js` (Shiki) | `metro.config.js` | T3's resolution of `shiki` and every `@shikijs/*` package from the app's Shiki 4.2.0. |

## Adapted pieces

| Solus file | T3 source | What was taken | Local changes |
| --- | --- | --- | --- |
| `src/features/layout/lib/layout.ts` | `src/lib/layout.ts` | The split-layout thresholds: a sidebar needs a window at least 720 wide and 600 tall; the sidebar is 32% of the width, from 280 to 380. | Only the compact/split decision. The auxiliary pane, the file inspector, and the animated sidebar are not adopted. |
| `src/features/hosts/PairHostScreen.tsx` | `src/features/connection/ConnectionsNewRouteScreen.tsx` | The presentation: a scanner shown on request, camera permission asked only when scanning is chosen, the "open Settings" path after a permanent denial, and a lock against duplicate scans. | Rewritten for Solus. Pairing links, codes, `/health`, and `/pair` are Solus's own (`@solus/client-core/pairing`). A confirmation step shows the target before pairing. No Uniwind, no T3 components. |
| `modules/solus-keyboard-commands/ios/SolusKeyboardCommandsModule.swift` | `modules/t3-native-controls/ios/T3KeyboardCommandsModule.swift` | The mechanism: an Expo view that wraps the app, offers `UIKeyCommand`s to the responder chain, takes first responder when no text input has it, and reports the command as an event. | Solus commands and meanings only (send, new session, sidebar, focus input, stop, back); no command palette or thread jumps; no Android counterpart. |
| `src/features/keyboard/keyboard-commands.ts` | `src/features/keyboard/hardwareKeyboardCommands.ts` | The rule that the newest mounted handler answers first and may pass a command on. | Plain class with listeners; no `useSyncExternalStore` registry of its own. |
| `src/features/account/CloudHostsScreen.tsx` | `src/features/cloud/ConnectOnboardingRouteScreen.tsx` | Pull to refresh on the account's host list, and a signed-out explanation. | Rewritten for Solus account services: device sign-in, the host directory, organizations, and managed host start. No Clerk, relay, or Effect. |
| `src/features/settings/SettingsScreen.tsx`, `AppearanceScreen.tsx` | `src/features/settings/SettingsRouteScreen.tsx`, `SettingsAppearanceRouteScreen.tsx` | The settings root's section order (connections, interface, server settings, app) and the three color-scheme cards with a phone preview. | Solus sections: each host's settings are a row per host, not a filter menu. No theme palettes or text-size slider. The choice stays on the device. |
| `src/features/prs/` | `src/features/threads/thread-list-v2-items.tsx`, `src/state/thread-pr-presentation.ts`, `src/features/review/ReviewCommentComposerSheet.tsx` | The pull request row anatomy and state colors (open green, merged violet, closed rose, draft muted), and the comment sheet's layout. | Solus's own list (host-wide, in the web's Authored / Review requested / Others sections) and detail screen; no T3 review or diff code. |
| `src/features/files/FilesScreen.tsx` | `src/features/files/ThreadFilesRouteScreen.tsx` | A pushed folder screen per level, folders first. | Built on the host's flat file index (`listProjectFiles`); read-only. |

## Evaluated, not adopted in milestone one

| T3 source | Reason |
| --- | --- |
| `modules/t3-composer-editor/`, `src/native/T3ComposerEditor.*` | Same reason. The composer is a React Native `TextInput`. |
| `modules/t3-review-diff/`, `modules/t3-terminal/` | Later parity work. `t3-terminal` carries its own third-party notices (Ghostty, MesloLGS NF) that must come with it. |
| `src/connection/`, `src/state/`, Clerk and T3 Connect configuration, `Stack.tsx` | Not to be copied (plan 017 §3). |

`modules/t3-markdown-text/` began as Bluesky PBC's
`react-native-uitextview` (MIT); its `LICENSE` and `UPSTREAM.md` stay with the
module. No Expo notice applies: no file that carries one was adopted.

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
