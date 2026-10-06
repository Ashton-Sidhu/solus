# Solus mobile (native)

The native iPhone, iPad, and Android client for Solus (plan 017,
`plans/017-native-mobile-client.md`). It is an **internal prototype**: the
source for the first conversation milestone exists, its logic is tested, and
Metro bundles it for iOS and Android. No native compile or device run has been
done yet: this machine has no Xcode or Android SDK (see "Native build").

It is a client of an existing Solus host. It uses the same RPC contract,
socket transport, host supervisor, record API, and account services as the
desktop and web clients. It adds no server code and no mobile protocol.

## Stack

- Expo SDK 58 (`expo` 58.0.3), React Native 0.88.0-rc.3, React 19.3.0 — T3
  Code's runtime, so that T3's dependency patches apply at their exact
  versions (plan 017 §3 amendment). The root `package.json` lists the patches
  under `patchedDependencies`, and its `overrides` keep one React Native: Expo
  packages do not accept a prerelease as a peer, and without the override Bun
  installs a second React Native for them.
- React Navigation 7 native stack.
- **T3 Code's interface with Solus's theme** (plan 017 §3 amendment): uniwind
  1.11 (Tailwind v4 for React Native, 14px rem, patched like T3), DM Sans,
  `react-native-reanimated` and `react-native-worklets`,
  `react-native-gesture-handler`, `react-native-keyboard-controller`,
  `expo-glass-effect`, `expo-blur`, `expo-haptics`, `expo-clipboard`,
  `expo-image`, `react-native-svg`, `@legendapp/list`, `@react-native-menu/menu`
  (patched like T3), `@tabler/icons-react-native` (Android icons), and
  `@expo/ui` (Android Material controls). T3's color tokens are generated from
  the Solus palette: edit `src/theme/theme-colors.ts`, then run
  `bun apps/mobile/scripts/generate-uniwind-theme.ts`. `UPSTREAM.md` lists
  every ported file.
- `expo-secure-store` for credentials only; `expo-sqlite/kv-store` for host
  metadata, drafts, the send outbox, and the last route; `expo-camera` for
  pairing codes; `expo-web-browser` for account sign-in; `expo-network` for
  network changes; `expo-image-picker`, `expo-document-picker`, and
  `expo-file-system` for attachments; `expo-font` with JetBrains Mono (the
  Solus default code font) and DM Sans (T3's interface font); `expo-build-properties` to allow plain `http://` to LAN hosts on
  Android; `expo-system-ui` for Android light and dark; `expo-symbols` for
  icons: SF Symbols on iOS, T3's Tabler mapping on Android (`src/components/AppSymbol.tsx`).
- Two local native modules, autolinked from `modules/`:
  `modules/solus-keyboard-commands` (iOS) for hardware keyboard commands, and
  T3 Code's `modules/t3-markdown-text` (iOS Fabric text view, Android copy
  helper) for selectable Markdown. The Markdown module is a `file:` dependency,
  so Bun copies it into `node_modules`: run `bun install` after editing it.
- Markdown parsing through `react-native-nitro-markdown` (md4c); code colors
  through Shiki 4.2.0 with `react-native-shiki-engine` (Metro resolves every
  `@shikijs/*` package from this app's Shiki copy); media through `expo-video`,
  `expo-audio`, and `react-native-image-viewing`. Host files load through a URL
  the host signs (`src/features/files/host-media-url.ts`).
- TypeScript stays at the repository's 5.9.3. TypeScript
  is not part of the app at runtime, so `expo.install.exclude` lists it.
- Bun workspace dependencies. `@solus/contracts` and `@solus/client-core`
  resolve from source through Metro (`metro.config.js`).

## Layout

| Path | Owns |
| --- | --- |
| `src/app/` | `SolusApp`, the composition root (registry, connections, account, sessions, open conversations), the load barrier, and the restored route |
| `src/platform/` | Ports for storage and the keychain, the Expo adapters, app lifecycle wake signals, and the one `AbortSignal.timeout` polyfill |
| `src/features/hosts/` | Saved hosts and their credentials, one connection and supervisor per host, pairing |
| `src/features/account/` | Solus Cloud device sign-in, the host directory, organizations, managed host start |
| `src/features/home/` | Home: every session on every host, T3's list, search, and filters |
| `src/features/threads/` | The thread directory across hosts, the thread screen (feed, composer, cards), and the new-task sheet |
| `src/features/conversation/` | Transcript model, conversation controller and store |
| `src/features/projects/` | Open project: new, existing folder, GitHub, or a URL; reached from the new-task sheet |
| `src/features/layout/` | The iPad split view and the Mail-style search toolbar |
| `src/features/prs/` | Pull requests across a host's projects, one pull request, comments and reviews |
| `src/features/files/` | A project's files from the host index, and a read-only file view |
| `src/features/settings/` | Settings by owner (plans/018): the personal profile (theme, agent defaults, notifications) and its opt-in sync, organization rules and host policy, each host's own settings and GitHub connection, and About |
| `src/features/notifications/` | Notifications across hosts, and where each one opens on this device |
| `src/components/`, `src/lib/`, `src/native/` | T3's shared components, styling helpers, and native wrappers (see `UPSTREAM.md`) |
| `src/theme/` | The Solus palette in T3's color roles (`theme-colors.ts`) |

Logic lives in plain TypeScript beside each feature and is tested with Bun
without loading React Native. Components subscribe to small slices: a streamed
token re-renders one transcript row.

## Commands

```sh
bun run --cwd apps/mobile check        # tsc --noEmit for the app and the shared code it loads
bun run --cwd apps/mobile test:logic   # tests/unit/native-mobile-*.test.ts through the unit runner
```

### Native build

`ios/` and `android/` are generated by `expo prebuild` from `app.json` and are
not committed. Checks that need no Xcode, all passing on 2026-10-03:

```sh
CI=1 npx expo export --platform ios --platform android --output-dir /tmp/solus-mobile-export   # Metro + Hermes bytecode for both platforms
CI=1 npx expo prebuild --no-install --clean                                                    # native projects, config plugins, Info.plist and manifest
npx expo-modules-autolinking resolve -p apple                                                  # finds SolusKeyboardCommands
```

A compile and a simulator run need Xcode 26 with an iOS simulator runtime and
CocoaPods (about 40–50 GB free), and Android needs Android Studio with an SDK
and a JDK. Then, from this folder:

```sh
bunx expo run:ios --device "iPhone 17"     # also an iPad simulator for the split layout
bunx expo run:android
```

A Debug build has no JavaScript in it: it loads the bundle from Expo's Metro
on `localhost:8081`, with Fast Refresh. Installed without Metro, it stops at
"No script URL provided". The Devices pane's **Build & run** profiles
(`.solus/config.json`):

- **iOS simulator (Expo dev)** runs `scripts/ios-dev-build.sh`. The script
  reuses a Metro that serves this checkout, or starts Expo in its own session,
  which outlives the build. Then it builds Debug. Metro logs to
  `.expo/metro.log` and keeps its PID in `.expo/metro.pid`; stop it with
  `kill "$(cat .expo/metro.pid)"`. A port 8081 held by another project stops
  the build.
- **iOS simulator (standalone)** and **iOS device (standalone)** build
  `Release` with the bundle embedded, so the app starts by itself, without Fast
  Refresh.

Do not use the Solus desktop or web build commands for the mobile app.

## Known limits and decisions

- **Solus Cloud sign-in needs a deploy.** The app signs in with the device
  flow as client `solus-mobile`. The solus-cloud working tree now lists it in
  `DEVICE_CLIENTS` (`src/lib/server/auth/device-clients.ts`, with a test), but
  that change is not deployed. Until it is, sign-in says that Solus Cloud does
  not accept this app yet. The desktop client id is not reused.
- **Keyboard after send.** The composer closes the software keyboard after a
  message is sent, as T3 Code does, so the reply is visible. This is an
  approved exception to the rule that focus returns to the input (plan 017 §3
  amendment). The hardware keyboard's ⌘L still focuses the input.
- **Hardware keyboard:** ⌘↩ send, ⌘N new session, ⌘B sidebar, ⌘L focus the
  input, Ctrl+C stop, ⌘[ back — the desktop meanings, except Send: a plain
  Return breaks a line in a multiline input. iOS only; the Swift source is
  typechecked against UIKit but not yet compiled with Expo.
- **History and replay.** The app follows the host's contract: history first,
  then `watchSession` with `attachRuntime`, which replays the turn in progress.
  A history page read during a turn may already hold part of that turn, and
  the replay has no id to match it against. The desktop client has the same
  exposure. This is an open protocol question, recorded in plan 017.
- **Bundle identifier** `sh.solus.mobile` (from the `solus.sh` domain) is a
  placeholder until signing and store identity are decided.

## Replacement coverage (plan 017 stage 5)

Status values: **source** = implemented and logic-tested, not proven on a
device; **missing** = not in the native app; **n/a** = not applicable. Native
device evidence is required before any row is called done. Owner is the
feature area that implements it.

| Capability | Owner | Native | Web | Evidence / next step |
| --- | --- | --- | --- | --- |
| Pair a host (QR, link, address + code) | hosts | source | yes | `native-mobile-hosts`, `native-mobile-host-integration`; device proof of camera flow |
| Solus Cloud sign-in and existing hosts | account | source, blocked on client id | yes | `native-mobile-account`; solus-cloud change above |
| Organizations (select, Local vs organization view) | account | source | yes | `native-mobile-app` |
| Host management (retry, forget, sign out) | hosts | source | yes | `native-mobile-hosts`, `native-mobile-app` |
| Sessions across hosts (Home), open project | threads, projects | source | yes | `native-mobile-thread-list`, `native-mobile-host-integration` |
| Start a session (Claude Code, Codex) | conversation | source | yes | `native-mobile-conversation` |
| Conversation: history, streaming, older pages, reconnect | conversation | source | yes | `native-mobile-conversation` |
| Send, stop, queued and failed prompts | conversation | source | yes | `native-mobile-conversation` |
| Permissions, questions, rate limits | conversation | source | yes | `native-mobile-conversation` |
| Plan approval and request changes (own session) | conversation | source | yes | `native-mobile-conversation` |
| Plans of another session (`decideSessionPlan`) | conversation | source (live only) | yes | `native-mobile-agent-plans`; a reloaded conversation does not rebuild these cards from history yet |
| Run settings (model, effort, permission mode) | conversation | source | yes | `native-mobile-run-settings`; the window always follows the model |
| Attachments (photos, videos, files) | conversation | source | yes | `native-mobile-attachments`; device proof of pickers and upload |
| Voice input | input | missing | yes | Needs a native recorder feeding `transcribeAudio` |
| Hardware keyboard commands | keyboard | source (iOS), unbuilt | yes | `native-mobile-run-settings` (registry); Swift typechecked against UIKit; Android has none |
| Adaptive iPad sidebar | layout | source | n/a | `native-mobile-layout`; device proof in full and reduced windows |
| Markdown, code, selectable text | conversation | source | yes | `native-mobile-markdown-text`, `native-mobile-incremental-snippet`; T3's native text view with Shiki code colors, tables, and images and videos from the host |
| Tasks, goals | tasks | missing | yes | Next step after milestone one |
| PRs, diffs, reviews | prs, review | source: list, detail, checks, reviewers, files, comment, approve, request changes; diff, merge, and lifecycle missing | yes | `native-mobile-prs`; `t3-review-diff` is the diff candidate |
| Plans gallery, works, documents, artifacts, diagrams | plan, work | missing | yes | Later parity |
| Automations | automations | missing | yes | Later parity |
| Files, browser panes, terminal | files, browser | source: browse and read files with Shiki colors, Markdown preview, images, and video; audio plays only from a host that signs audio URLs (current hosts do not); PDF and SVG open in the browser; edit, browser, terminal missing | yes | `native-mobile-files-settings`, `native-mobile-file-preview-kind`, `native-mobile-host-media-url`; device previews are plan 016 |
| Settings | settings | source: account and hosts, appearance (this device), agent defaults, notification preferences, GitHub connection, About; instructions, tasks, review, tools, providers missing | yes | `native-mobile-files-settings` |
| Share links, collaboration, presence | sharing | missing | yes | Guest links stay a browser feature |
| Notifications and navigation from them | notifications | source: inbox; pull request notifications open the pull request | yes | `native-mobile-notifications`, `native-mobile-prs`; native push needs its own registration (plan 015) |
| Android | all | source, unproven | yes (mobile web) | Keep the mobile web shell until Android is proven |
| Full cloud onboarding (provision a host, connect providers) | account | handoff to the setup page | yes | Explicit handoff in `CloudHostsScreen` |
