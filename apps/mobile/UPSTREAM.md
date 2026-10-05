# Upstream sources

This app adapts a small number of ideas from T3 Code. It copies no T3 runtime,
state, authentication, connection, or build code, and it imports nothing from
the T3 checkout. Plan 017 §3 governs what may be adopted.

- **Source:** T3 Code, `apps/mobile/`, commit `43bd667739` (checked 2026-10-02).
  The settings, pull request, and files rows were read at commit `77823bd102` (2026-10-03).
- **License:** MIT. The notice is reproduced below and must stay with any
  adapted file.

## Adapted pieces

| Solus file | T3 source | What was taken | Local changes |
| --- | --- | --- | --- |
| `src/features/layout/lib/layout.ts` | `src/lib/layout.ts` | The split-layout thresholds: a sidebar needs a window at least 720 wide and 600 tall; the sidebar is 32% of the width, from 280 to 380. | Only the compact/split decision. The auxiliary pane, the file inspector, and the animated sidebar are not adopted. |
| `src/features/hosts/PairHostScreen.tsx` | `src/features/connection/ConnectionsNewRouteScreen.tsx` | The presentation: a scanner shown on request, camera permission asked only when scanning is chosen, the "open Settings" path after a permanent denial, and a lock against duplicate scans. | Rewritten for Solus. Pairing links, codes, `/health`, and `/pair` are Solus's own (`@solus/client-core/pairing`). A confirmation step shows the target before pairing. No Uniwind, no T3 components. |
| `modules/solus-keyboard-commands/ios/SolusKeyboardCommandsModule.swift` | `modules/t3-native-controls/ios/T3KeyboardCommandsModule.swift` | The mechanism: an Expo view that wraps the app, offers `UIKeyCommand`s to the responder chain, takes first responder when no text input has it, and reports the command as an event. | Solus commands and meanings only (send, new session, sidebar, focus input, stop, back); no command palette or thread jumps; no Android counterpart. |
| `src/features/keyboard/keyboard-commands.ts` | `src/features/keyboard/hardwareKeyboardCommands.ts` | The rule that the newest mounted handler answers first and may pass a command on. | Plain class with listeners; no `useSyncExternalStore` registry of its own. |
| `src/features/account/CloudHostsScreen.tsx` | `src/features/cloud/ConnectOnboardingRouteScreen.tsx` | Pull to refresh on the account's host list, and a signed-out explanation. | Rewritten for Solus account services: device sign-in, the host directory, organizations, and managed host start. No Clerk, relay, or Effect. |
| `src/ui/app-symbol.tsx` | `src/components/AppSymbol.tsx` | Icons by meaning: one table maps each to an SF Symbol on iOS and an Android counterpart, and settings rows carry a 22px icon. | Android uses `expo-symbols`' Material Symbols, not Tabler; Solus's own names and table. |
| `src/ui/grouped-rows.tsx` | `src/features/settings/components/SettingsSection.tsx`, `SettingsRow.tsx`, `SettingsChoiceRow.tsx`, `SettingsActionRow.tsx` | The grouped-list measurements of the iOS path: a sentence-case section title over a 24px card, 14px row padding, 18px labels, 16px values, choice rows divided by a hairline, footers under the card. | Plain React Native `StyleSheet` values and Solus colors. Icons come from `app-symbol.tsx`. No Uniwind, no Material variant. |
| `src/features/settings/SettingsScreen.tsx`, `AppearanceScreen.tsx` | `src/features/settings/SettingsRouteScreen.tsx`, `SettingsAppearanceRouteScreen.tsx` | The settings root's section order (connections, interface, server settings, app) and the three color-scheme cards with a phone preview. | Solus sections: each host's settings are a row per host, not a filter menu. No theme palettes or text-size slider. The choice stays on the device. |
| `src/features/prs/` | `src/features/threads/thread-list-v2-items.tsx`, `src/state/thread-pr-presentation.ts`, `src/features/review/ReviewCommentComposerSheet.tsx` | The pull request row anatomy and state colors (open green, merged violet, closed rose, draft muted), and the comment sheet's layout. | Solus's own list (host-wide, in the web's Authored / Review requested / Others sections) and detail screen; no T3 review or diff code. |
| `src/features/files/FilesScreen.tsx` | `src/features/files/ThreadFilesRouteScreen.tsx` | A pushed folder screen per level, folders first. | Built on the host's flat file index (`listProjectFiles`); read-only. |

## Evaluated, not adopted in milestone one

| T3 source | Reason |
| --- | --- |
| `modules/t3-markdown-text/` | A native module needs a native build proof first (plan 017 §3). A small TypeScript parser (`src/features/conversation/lib/markdown.ts`) renders transcript markdown with React Native `Text`. |
| `modules/t3-composer-editor/`, `src/native/T3ComposerEditor.*` | Same reason. The composer is a React Native `TextInput`. |
| `modules/t3-review-diff/`, `modules/t3-terminal/` | Later parity work. `t3-terminal` carries its own third-party notices (Ghostty, MesloLGS NF) that must come with it. |
| `src/connection/`, `src/state/`, Clerk and T3 Connect configuration, `Stack.tsx`, the patch set | Not to be copied (plan 017 §3). |

No Expo or Bluesky notice applies: no file that carries one was adopted.

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
