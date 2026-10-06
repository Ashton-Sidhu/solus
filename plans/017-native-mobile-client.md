# Plan 017: Build the Solus native mobile client

## Status and execution rules

- **Status:** IN PROGRESS (2026-10-03). Source for stages 0–4 is in the working tree with focused logic tests, a disposable-host socket test, and Metro bundles for iOS and Android. No native compile, simulator, or device run: this machine has no Xcode or Android SDK. The `solus-mobile` client registration is in the solus-cloud working tree, not deployed. See §8.
- **Baseline:** 2026-10-02, Solus `d1ae9bc43` plus the existing working tree; T3 reference checkout `/Users/sidhu/t3code`, commit `43bd667739`.
- **Priority / effort / risk:** P1 / L / medium-high. Native transport integration, authentication, transcript recovery, and scope of replacement are the main risks. Full mobile replacement is larger than the first conversation milestone.
- **Dependencies:** Existing Solus contracts, host connections, record APIs, and account services. Reconcile plans 010 and 013 with the actual deployed account service. Plan 015 owns the future notifications hub and its delivery semantics. Plan 016 owns device previews; it is not a prerequisite for this app.
- **Authorization:** The user selected React Native/Expo, reuse of selected T3 components and onboarding, the existing Solus backend, and later retirement of the dedicated mobile web shell. This plan does not authorize a deployment, store submission, PR, live-data mutation, or starting a dev server or simulator.

Read AGENTS.md and this entire plan before implementation. Preserve other work. The working tree already has changes to `package.json`, client files, account code, and `plans/README.md`. Never reset or stash them. First run:

```sh
git status --short
git diff --stat d1ae9bc43..HEAD -- apps/client apps/desktop packages/client-core packages/contracts packages/workspace-ui tests/unit package.json plans
git diff --stat -- apps/client apps/desktop packages/client-core packages/contracts packages/workspace-ui tests/unit package.json plans
git -C /Users/sidhu/t3code rev-parse --short HEAD
```

Reconcile changed behavior before editing; a changed SHA alone is not a reason to discard work. Do not change the T3 checkout. Do not import its files by absolute path into the app.

## 1. Outcome and fixed decisions

Add `apps/mobile/`: React Native, TypeScript, Expo, and React Navigation native stack. Use custom native modules only where they provide needed behavior. iPhone and iPad are the first runtime proof targets. Keep the app structure compatible with Android; an iOS-only prototype does not authorize removing Android's current access.

The app is a client of the existing Solus server. Agents, execution, durable records, organization policy, and provider credentials remain on their existing hosts or record homes. Desktop and web stay in Svelte. Do not fork the server, introduce a mobile RPC dialect, or make a T3-to-Solus protocol translator.

The first milestone is an internal native app with this flow:

1. Open the app. Restore saved connections and the last accessible conversation on a returning launch.
2. With no connection, show **Connect to a host** and **Sign in to Solus Cloud**.
3. Direct host: scan a Solus pairing QR code, paste a pairing link, or enter an address and code. Show the target before connection. A cloud account is optional.
4. Cloud: authenticate with Solus, select the applicable organization and an existing host. Preserve Local and organization boundaries.
5. Select a project and an existing session, or start a session in an existing project. Show an explicit empty state when none exist.
6. Send prompts, read streamed text and tool activity, stop a turn, and answer permission, question, and plan-decision cards.

A first-time cloud account with no configured host is a distinct case. Explain what is missing and open the existing Solus setup page. In-app managed-host provisioning, provider-account connection, repository selection, and checkout are later parity work. Do not display an empty conversation that cannot execute, and do not claim full cloud onboarding at milestone one.

Native layout: iPhone uses a navigation stack; iPad uses a persistent session sidebar when its window has room. Respond to window size, including multitasking, rather than a device-name check. Apply Solus colors, typography, spacing, and light/dark appearance to React Native and native controls. Preserve accessibility text sizing, touch targets, and hardware keyboard use. Solus Svelte markup and CSS are references, not reusable native components.

## 2. Current source and reuse boundaries

| Source | What it provides / constraint |
| --- | --- |
| `packages/contracts/src/rpc.ts`, `host-api.ts`, `host-events.ts` | Shared commands, response types, and normalized events for both agent providers. |
| `packages/contracts/src/solus-api/client.ts` | Fetch-based record API client with credential exchange and stale-context checks. Native fetch/abort compatibility still needs proof. |
| `packages/client-core/src/host-supervisor.ts`, `host-event-subscriber.ts` | Connection lifecycle and typed subscriptions. Reuse the policy and single-owner model. |
| `packages/client-core/src/ws-transport.ts` | Socket.IO, authenticated host calls, request tracking, and event delivery. Its API construction also includes DOM file selection, `FileReader`, `window.open`, and document visibility. |
| `packages/client-core/src/server-connection.ts`, `server-registry.ts`, `workspace-registry.ts` | Host identity, routing, saved connections, and record homes. Current integration includes browser globals and storage. |
| `packages/client-core/src/pairing.ts` | Solus link parsing and `/pair` exchange. Supply a native device label; do not invoke browser-dependent defaults. |
| `packages/client-core/src/device-authorization.ts` | Existing device-code sign-in request and approval state machine with injected fetch/time dependencies. |
| `apps/desktop/src/main/account/account-session.ts`, `uplink-client.ts` | Existing token-based sign-in, host directory, and host-access flow. Extract needed client logic without importing Electron or server logging into mobile. |
| `packages/client-core/src/cloud-account.ts`, `uplink-session.ts` | Web account access assumes same-origin cookies. Do not use that assumption in native. |
| `packages/client-core/src/session-history-page.ts`, `send-outbox.ts` | Bounded history reads and stable prompt IDs. The outbox currently uses `localStorage` and imports the transport error. |
| `packages/workspace-ui/src/contexts/workspace/session-transcript.ts`, `hooks/agentEvents.svelte.ts` | Existing transcript and event behavior to inspect before implementing native state. Svelte ownership must not leak into native. |
| `apps/client/src/shell/mobile/`, `shell/WebLayout.svelte` | Dedicated mobile browser composition and its route branches. These remain until the replacement gate. |
| `apps/client/src/GuestApp.svelte`, `components/ServerSetupSurface.svelte` | Guest link rendering and server setup remain browser features. Server setup currently imports `MobileSheet`. |

Load-bearing excerpts to compare with the live source:

```ts
// packages/contracts/src/host-api.ts
watchSession(input: WatchSessionInput): Promise<WatchSessionResult>
unwatchSession(sessionId: string): Promise<void>

// packages/client-core/src/host-supervisor.ts
export interface SupervisedTransport {
  start(): void
  probe(): Promise<void>
}

// packages/contracts/src/solus-api/client.ts
// One client for desktop, web, mobile, external HTTP callers, and an execution host's agent runs.
export class SolusApiClient {

// packages/client-core/src/host-api.ts — browser file types need a native boundary
uploadFiles(files: File[], ctx: IpcContext): Promise<Attachment[] | null>
```

Follow existing typed errors and schemas. Name hosts, sessions, projects, turns, and works consistently; do not carry T3's environment/thread terminology into the Solus domain. No broad unknown records, blanket type casts, or ambient `window.solus` shims. Keep native components thin and place state, parsing, and algorithms beside their feature.

## 3. T3 adoption policy

Copy the smallest useful pieces, preserving licenses and recording their source commit and local changes in `apps/mobile/UPSTREAM.md`. Retain upstream notices, including module-specific Expo and Bluesky notices. Use Solus app identities, icons, domains, signing, and update configuration from the start.

| T3 reference under `apps/mobile/` | Adoption |
| --- | --- |
| `src/features/connection/ConnectionsNewRouteScreen.tsx` | Adapt the QR/manual-entry presentation and camera/error states. Replace pairing parsing and commands with Solus behavior. |
| `src/features/cloud/ConnectOnboardingRouteScreen.tsx` | Adapt host selection and connection states. Replace Clerk, relay, and Effect dependencies with Solus account services. |
| `src/lib/layout.ts`, `src/features/layout/AdaptiveWorkspaceLayout.tsx` | Reuse useful layout rules; implement Solus navigation/state ownership. Do not copy the full adaptive component dependency tree. |
| `src/features/keyboard/`, `src/native/T3ComposerEditor.*` | Adapt hardware keyboard behavior and evaluate composer reuse. Composer types and clipboard fragments are T3-specific and need explicit conversion or removal. |
| `modules/t3-composer-editor/`, `modules/t3-markdown-text/` | Candidates for needed native input and selectable text. Prove module build and rendering before broad adoption. |
| `modules/t3-review-diff/`, `modules/t3-terminal/` | Later parity candidates, not milestone-one dependencies. |
| `src/connection/`, `src/state/`, Clerk/T3 Connect configuration | Do not copy as the Solus runtime. |

Do not copy the entire `Stack.tsx`, conversation feed, dependency manifest, or patch set. The inspected feed is 3,189 lines, composer 1,165 lines, and navigation patch 2,232 lines. Each imported patch needs a named behavior, a compatible dependency version, and a regression check. Prefer the supported upstream API where it already satisfies that behavior. Do not assume T3's pinned prerelease runtime is required for Solus.

### §3 amendment (2026-10-04): T3 Code's interface, Solus's theme

The developer asked that the app look exactly like T3 Code's mobile app, except for the theme, and approved porting T3's UI code to get there. This replaces the "smallest useful pieces" rule above for the interface only:

- **Adopted:** T3's screens, components, navigation presets, layout, styling system (uniwind with a 14px rem, T3's type scale, DM Sans), and T3's color-token derivation (`src/lib/mobileTheme.ts`) run on a Solus palette (`src/theme/theme-colors.ts`). Ported files keep T3's paths and code style and start with an attribution line. Patches are taken only where the version matches T3's exactly; the root `package.json` lists them under `patchedDependencies`.
- **Still not adopted:** T3's state and connection runtime (`src/state/`, Effect atoms, `@t3tools/*`), Clerk, and T3 Connect. Each ported screen reads Solus stores instead.
- **Runtime (2026-10-04):** the app moved to T3's runtime, Expo SDK 58 with React Native 0.88.0-rc.3 and React 19.3, so that T3's patches apply at their exact versions (`react-native-screens@4.28.0` with the iOS 26 Mail-style search toolbar, `react-native-gesture-handler@3.2.1`, `react-native-keyboard-controller@1.22.6`, `expo-glass-effect`, `expo-blur`, `@legendapp/list`, `@react-navigation/native-stack`, `uniwind`, `@react-native-menu/menu`). React Native 0.88.0-rc.3 is a prerelease, so Expo packages do not accept it as a peer and Bun installs a second React Native for them; the root `package.json` `overrides` pin `react-native` and `react-native-worklets` to keep one copy.
- **Navigation:** Home (every session on every host) is the root, as in T3. The older per-host Projects → Sessions → Conversation path is removed; the developer said it is not needed. Open project stays, reached from the new-task sheet, and returns its project to that sheet. App builds moved to Host settings.
- **Keyboard after send (exception to "refocus the active input"):** the composer closes the software keyboard after a message is sent, as T3 does, so the reply is visible on a phone. The developer approved this exception on 2026-10-04. Hardware keyboard focus (⌘L) is unchanged.
- **Theme:** colors are Solus's in light and dark; every other visual is T3's.

## 4. Ownership and allowed changes

- `apps/mobile/` owns native navigation, React subscriptions, feature stores, platform adapters, and native modules.
- `packages/contracts/` remains the wire and shared domain authority. Import focused subpaths so browser-only dependencies do not enter the native bundle.
- `packages/client-core/` owns reusable connection policy, protocol handling, record clients, and domain helpers. Extract only what the first native flow needs. Supply browser and native adapters for storage, file access, link opening, and lifecycle; do not duplicate the socket protocol.
- The server and record homes remain authoritative. Cached native state must not change access or scope rules.
- `apps/client/` and desktop adapter wiring may change only where extracting a shared boundary requires it; retain behavior and run the owning regression tests.
- Root workspace/dependency files, relevant TypeScript/lint configuration, focused tests, and this plan may change as needed. Keep native modules outside the desktop packaging output.

Milestone-one exclusions: web mobile deletion, full offline execution, new provider support, full document editors, diagrams, browser/device streaming, terminal, widgets, native push delivery, cloud provisioning, store submission, and OTA publication. No unrelated server refactor, credential migration, or theme overhaul.

## 5. Implementation stages

### Stage 0 — Prove the native integration boundary

1. Establish a compatible stable Expo/React Native/React set from current official documentation. Configure an independent mobile TS project and Metro workspace resolution. Do not inherit desktop DOM assumptions into the mobile project. Use Bun workspace dependencies; do not add T3's package manager or build system.
2. Add a minimal `apps/mobile/package.json`, Expo config, entry, native navigation, and a visible Solus connection screen. Add `check` (`tsc --noEmit`) and `test:logic` scripts. Keep pure state tests executable by Bun without loading React Native.
3. Inventory the transitive imports of the chosen client-core entry points. Move browser-only API construction behind platform boundaries while preserving existing exported behavior for web/desktop. Extract the transport error if needed to avoid dragging DOM code into the outbox. Do not install fake DOM globals.
4. In a disposable test host, prove pairing, one typed RPC, one event subscription, and one record HTTP read. Use test fixtures, not live sessions or tokens. Where native compilation is needed, record it as a separately authorized native verification step; never run Solus's prohibited desktop/web build aliases.
5. Confirm the native account client ID with the account-service owner and the current OAuth implementation. The inspected desktop flow uses device authorization; use its current supported semantics, not a second auth design. If a mobile client registration requires the cloud repo, specify the exact change there before proceeding with that branch.

**Gate:** mobile typecheck and import-boundary tests pass; desktop/web transport tests still pass. Native binary/Metro smoke proof and direct-host/account proof are separate evidence entries. Do not call the framework/module selection proven without the native build. Cloud work may remain pending while independent direct-host work proceeds.

### Stage 1 — Add host/account persistence and lifecycle adapters

1. Keep one connection supervisor and event subscription owner per host. Retain authenticated tickets/grants, identity checks, version handling, typed RPC errors, and recovery behavior from the current transport.
2. Separate credentials from host metadata. Store credentials in native secure storage. Store hosts, selected organization, drafts, and bounded caches in native persistence. Do not place transcripts or queues in a keychain value. Define a load barrier before restoring routes or sending requests.
3. Map native app-active/background and network changes to existing supervisor wake operations. Treat foreground return as a recovery event; do not assume a socket stayed alive while suspended. Dispose listeners and connections on removal/sign-out as applicable.
4. Reuse account and host identity/scope checks. Reject stale responses after host, account, or organization switches. Keep a per-source identity in every cache key; an equal session ID on two hosts is not the same session.
5. Forget host removes its credentials, caches, queued sends, and subscriptions. Cloud sign-out removes cloud credentials and cloud-derived state without silently deleting independently paired Local hosts. Never drain queued work under a different identity.

**Gate:** `bun run --cwd apps/mobile check`; `bun run --cwd apps/mobile test:logic`; shared supervisor, registry, and transport regression tests. Tests must prove restart persistence, stale-response rejection, identity mismatch, expired credentials, and single subscription ownership.

### Stage 2 — Adapt onboarding and navigation

1. Adapt the selected T3 screens with Solus labels and tokens. Use Solus QR/link decoding and `/pair`, not T3 pairing formats. Provide camera-denied, malformed-code, expired-code, offline, and retry states. Do not request camera access until scanning is selected.
2. Implement native cloud sign-in and cancellation with the approved client identity. Open the system browser using the supported account flow. Preserve pending sign-in across background/foreground as needed; handle expiry without a permanent spinner. Do not depend on browser cookies being shared with the app.
3. Load authorized hosts and organizations. Show unreachable, stopped, starting, and access-denied states using existing capabilities. Enable starting a stopped managed host only through its existing authorized operation.
4. Select a project/session using existing record APIs. Resolve a saved route only after access and connection state are known. Missing or revoked sessions return to the list with an explanation. Users with no configured host get an explicit setup path.
5. Supply connection management after onboarding: add host, retry, switch host/organization, forget host, sign out. Successful pairing must not replace all other saved hosts.

**Gate:** logic tests cover both entry paths, return launch, cancelled sign-in, empty directory, multiple hosts, stale account results, and reverse actions. Device proof records direct-host and cloud entry to a conversation, including browser return.

### Stage 3 — Implement the conversation loop

1. Read `packages/workspace-ui/src/contexts/workspace/session-plan-operations.ts` and current session creation, binding, history, and event callers in `packages/workspace-ui/src/contexts/workspace/` and `hooks/agentEvents.svelte.ts` before choosing native calls. Preserve `IpcContext`, host identity, asking-session identity, attribution, and selected provider/model. Do not simulate desktop tabs to make server calls work.
2. Add native feature stores under `apps/mobile/src/features/conversation/` and `sessions/`. Share pure domain helpers where useful; do not import Svelte stores. Subscribe React components at the smallest useful slice so one streamed token does not rebuild the session list or complete transcript.
3. Implement bounded initial history, loading older turns, watch/unwatch, live event merge, and reconnect reconciliation using the existing protocol. Read `WatchSessionResult` and its server implementation to preserve history/live ordering. Test events arriving during history load and recovered versus fresh connections. Do not invent ordering or replay guarantees.
4. Render user/assistant text, markdown/code, tool progress/results, turn state, errors, permission requests, question requests, plans awaiting a decision, and rate-limit states with clear supported actions. Preserve both Claude and Codex semantics through shared normalized contracts. Large tool bodies load on demand where the current API supports it.
5. Send with the existing stable `clientPromptId` and acknowledgement semantics. Persist a draft until acceptance; distinguish queued, sent, and failed. Retrying an uncertain send must use the same ID. Adapt the existing outbox storage rather than defining a new delivery protocol. Restore scroll position and selection without forcing scroll-to-bottom when the user reads older content.
6. Implement stop, permission/question responses, and plan approval/request-changes through their current methods and workflows. Inspect `acceptPlan`, `decideSessionPlan`, and their callers; they are not interchangeable. Preserve the existing implementation prompt, session handoff, and provider/model behavior after approval rather than treating approval as a status-only write. Do not optimistically show an approval as accepted when the server refused it. Reconcile requests answered on another client and subagent requests addressed to another asking session.

**Gate:** deterministic native logic tests prove history/event races, no duplicate prompt after reconnect, stale session response rejection, cross-client resolution of questions and plan decisions, successful continuation after plan approval, both providers, and bounded subscription/cache cleanup. Existing history/outbox tests pass.

### Stage 4 — Apply Solus design and verify iPhone/iPad behavior

1. Add feature-local native components and a small shared token layer in `apps/mobile/src/theme/`. Inspect the current Solus styling in `packages/workspace-ui/src/index.css`, `packages/workspace-ui/src/workspace.css`, and the shared primitives before mapping tokens. Avoid pulling the web CSS build into Metro.
2. Implement compact navigation and adaptive iPad sidebar. Preserve the selected session, composer draft, and scroll state across rotation/window resize. Keep a path back to the session list and connection settings.
3. Add hardware-keyboard send/new-session/navigation commands using existing Solus meanings. Return focus to the composer when typing is the next action; do not summon the software keyboard merely because onboarding or a list mounted.
4. Test software keyboard insets, multiline input, paste, selection, markdown links, safe areas, accessibility labels/text sizing, light/dark modes, and reduced motion. Keep native component imports/patches traceable to their source.
5. Add attachments only after the native URI-to-upload adapter obeys Solus upload size and permission rules. Do not pass a phone file path as a path on the host. If deferred in the prototype, mark attachments incomplete in the parity table.

**Gate:** focused logic/type checks pass. After explicit interactive verification authorization, record the device/OS/build and pass/fail results for an iPhone, an iPad in full and reduced windows, and an iPad hardware keyboard. Record restart, suspension during a turn, network loss, and expired-auth recovery. Use disposable host state. Desktop/web boundary changes receive their own focused regression proof.

### Stage 5 — Complete replacement coverage before web retirement

This is a planning and release gate, not permission to implement all later features in one change. Add a table to `apps/mobile/README.md` with owner, native status, web status, and evidence for:

- Projects, sessions, run settings, attachments, voice input, permissions/questions/plan decisions, and queued work.
- Tasks, goals, PRs, diffs/reviews, plans, works/documents/artifacts/diagrams, and automations.
- Files, browser panes, settings, account/host management, share links, and collaboration.
- Notifications and notification navigation, coordinated with plan 015. Native push requires its own registration/delivery integration; copying the web service worker does not provide it.
- Device previews if plan 016 has landed, plus any capability added to web during this migration.
- iPhone, iPad, Android, and browser access for people following shared links.

For each missing capability, create the next bounded implementation step or record an explicit product decision. A disabled control or silent omission is not parity. Keep milestone one labeled an internal prototype while required capabilities remain. Android needs a verified replacement or a retained supported browser path.

**Gate:** no required replacement row is unresolved. Feature teams use existing contracts rather than separate native behavior. Full cloud setup is implemented or has an explicit supported handoff, not an accidental gap.

### Stage 6 — Retire the dedicated mobile web shell

Execute only after stage 5. Re-read live imports; the shell will change while the native app is built.

1. Remove `apps/client/src/shell/mobile/` components after migrating any remaining non-mobile callers, including `ServerSetupSurface.svelte`'s sheet dependency.
2. Simplify mobile composition branches in `shell/WebLayout.svelte`, `shell/web-shell.svelte.ts`, and related app analytics/navigation. Keep a usable browser layout at small widths. Remove only unused styles, helpers, and tests.
3. Remove `lib/virtual-keyboard.svelte.ts` only when no remaining input needs it. `lib/back-stack.svelte.ts` still serves server setup today: remove it only after replacing that behavior or proving no callers remain.
4. Preserve guest shared-link pages, responsive shared controls, web sign-in/pairing, web notifications, and the service worker unless a separate product change owns their removal. Do not search-and-delete every `mobile`, `pointer-coarse`, or safe-area occurrence.
5. Verify desktop browser, narrow browser, touch browser, guest links, browser Back, and remaining Android access. Existing web installations must retain a working entry path and stored host/session data.

**Gate:** zero imports of removed files; client typecheck and focused shell tests pass; supported browser/device flows have recorded evidence. Update the product documentation to identify native mobile as the primary mobile workspace. Keep this cleanup separate from the first native app change.

## 6. Verification commands and test ownership

Existing commands checked in package manifests or existing test paths (not executed while writing this plan):

```sh
bun run --cwd packages/contracts check
bun run --cwd packages/client-core check
bun run --cwd apps/client check
bun test tests/unit/host-supervisor.test.ts tests/unit/socket-io-transport.test.ts
bun test tests/unit/pairing-decode.test.ts tests/unit/server-registry-decode.test.ts tests/unit/server-registry-uplink.test.ts
bun test tests/unit/session-history-pages.test.ts tests/unit/session-history-page-compatibility.test.ts tests/unit/send-outbox.test.ts
bun test tests/unit/account-store.test.ts tests/unit/cloud-account.test.ts
bun run lint:surfaces
```

Run only the groups that own changed behavior. Expected result: exit 0 and all relevant tests passing. Record baseline failures separately; do not claim a failure was introduced without comparison. `socket-io-transport.test.ts` is an existing real transport harness; inspect and reconcile its current imports before extending it. `host-supervisor.test.ts` shows injected time and explicit event assertions. Use those patterns rather than sleeps.

New scripts to add in stage 0, then run after each applicable stage:

```sh
bun run --cwd apps/mobile check
bun run --cwd apps/mobile test:logic
```

`test:logic` must run actual behavior tests, including `tests/unit/native-mobile-boundaries.test.ts` and focused pure native feature tests. The boundary check must follow transitive runtime imports and reject Svelte, Electron, server runtime, and browser-only modules in native entry points. Type-only imports do not imply runtime dependency. Do not substitute a source substring assertion for a native bundle/device proof.

Proposed test groups: native storage and cleanup; onboarding navigation; account transition races; host lifecycle; conversation history/event merge; stable prompt delivery; adaptive navigation/drafts. These test files are new deliverables, not existing commands claimed to pass. Keep wire/backend regression tests under `tests/unit/`; keep React/native component tests in the native project's supported test harness.

Do not run root `bun test`/`bun run test`, full suites, `bun run build`, build aliases, or direct desktop/web bundler builds. Do not start Metro, simulators, or development hosts until interactive verification is explicitly authorized. Native compilation is a separate required proof using the mobile toolchain, not a reason to run the Solus desktop build. Document exact resolved native commands in `apps/mobile/README.md` once the toolchain is selected. Use temporary `SOLUS_DATA_DIR`, captured process IDs, and test credentials for integration checks.

## 7. Completion record and stop conditions

Track each stage independently in this plan. Initial status: stages 0–6 TODO.

Milestone one requires stages 0–4, including both direct-host and existing-cloud-host paths, both agent providers, and native device evidence. Source-only work is not a verified native app. Full replacement requires stages 5–6 as well. Update `plans/README.md` with that distinction; do not mark the whole plan implemented after the conversation prototype.

Stop the affected branch and report if:

- Account client registration or grant semantics differ from the current desktop reference. Continue independent direct-host work; do not invent account endpoints or reuse the desktop client identity without checking its policy.
- A reused T3 module requires importing T3 runtime/auth or broad framework patches. Reassess a smaller module or a supported native component before expanding scope.
- History/event ordering or idempotent send guarantees cannot be established from existing contracts and tests. Resolve the protocol question before implementing guessed reconciliation.
- The first milestone requires replacing session execution, changing record ownership, or weakening admission. Those are separate design decisions.
- Web removal would leave a supported platform, feature, or guest-link path unusable. Keep that web path until replacement or an explicit product decision.

Future changes must keep one wire contract, native and web platform adapters, and a clear owner for each durable record. Check native compatibility when changing a client-core import. Review copied modules and patches when upgrading Expo/React Native. Keep T3 attribution with copied source; do not make tracking T3's entire app a maintenance requirement.

## 8. Completion record

Recorded 2026-10-03 against `d1ae9bc43` plus the working tree. T3 reference unchanged at `43bd667739`. Milestone one is **not** complete: it needs native compile and device evidence, and a deploy of the solus-cloud client registration.

The developer authorized native builds, simulators, and the solus-cloud change on 2026-10-03. The native build could not run: the machine has only the Command Line Tools (no Xcode, iOS SDK, or simulator runtime), no CocoaPods, no Android SDK or JDK, and 14 GB of free disk. Everything short of a compile was run instead.

| Stage | Status | Evidence |
| --- | --- | --- |
| 0 | SOURCE DONE; Metro bundle PASS; native compile NOT RUN (no toolchain) | `bun run --cwd apps/mobile check` passes. `expo export` bundles iOS (1116 modules) and Android (1110 modules) to Hermes bytecode. `expo prebuild --no-install` generates both native projects with every config plugin. `expo-modules-autolinking` resolves the local `SolusKeyboardCommands` module. `native-mobile-boundaries` follows the runtime import graph and rejects Svelte, Electron, server, Node built-ins, DOM packages, and nine browser-only client-core modules. `native-mobile-host-integration` pairs over `/pair`, makes one typed RPC, receives one event, and reads session records over HTTP against a disposable host with the real `WsTransport`. |
| 1 | SOURCE DONE | `native-mobile-hosts`, `native-mobile-account`, `native-mobile-app`. |
| 2 | SOURCE DONE; cloud entry needs the solus-cloud deploy; device proof NOT RUN | solus-cloud `src/lib/server/auth/device-clients.ts` lists `solus-mobile` ("Solus for iPhone and iPad"); `device-clients.test.ts` passes (2 tests). |
| 3 | SOURCE DONE | `native-mobile-conversation` (17), `native-mobile-agent-plans` (5): plans of another session through `decideSessionPlan`, from live events. |
| 4 | SOURCE DONE; device checks NOT RUN | Run settings (`native-mobile-run-settings`): model, effort, and mode for the next prompt, locked as on desktop; the context window always follows the model. Attachments (`native-mobile-attachments`): photos, videos, and files, uploaded by the host's RPC or signed route, named in the prompt by host path, a draft id before the first prompt. Hardware keyboard: `modules/solus-keyboard-commands` (iOS `UIKeyCommand`, typechecked against Mac Catalyst UIKit with Expo stand-ins, not compiled with Expo). JetBrains Mono for code. Android allows plain `http://` to LAN hosts; iOS allows local networking only. |
| 5 | STARTED | Parity table in `apps/mobile/README.md`. Rows are open; mobile web stays. |
| 6 | TODO | Gated on stage 5 and kept separate from the first native change. |

### Device evidence (2026-10-03, Xcode 26.6, iOS 26.5 simulators, debug build)

Built with `expo run:ios` (CocoaPods 1.17.0; 0 errors, including the `SolusKeyboardCommands` Swift module) and driven through the Solus Devices pane with `agent-device`. The host was a disposable standalone server (`dist/main/standalone.js`, temporary `SOLUS_DATA_DIR`) with disposable projects; provider turns used this Mac's Claude Code and Codex logins with one-word prompts.

| Check | Device | Result |
| --- | --- | --- |
| First launch: load barrier, welcome screen, Solus colors | iPhone 17 | PASS |
| Pair by address and code: target confirmation, `/pair`, host saved, connected | iPhone 17 | PASS |
| Pair by pasted pairing link (no code asked) | iPad Pro 13-inch (M5) | PASS |
| Hosts list with live state ("Connected"); projects; empty states | iPhone 17 | PASS |
| New Claude Code session: prompt sent, reply streamed, composer keeps focus | iPhone 17 | PASS |
| New Codex session: provider default model in run settings, reply received | iPhone 17 | PASS |
| Returning launch restores a saved conversation with its history | iPhone 17 | PASS |
| Returning launch after a new (unsaved) session restores its project's session list, not the conversation | iPhone 17 | GAP — remember a new session as a record after its first prompt |
| Session list current after returning from a conversation | iPhone 17 | FAIL, fixed (`use-session-list-refresh.ts`: reload on focus and on `session.statusChanged`), then PASS |
| iPad split layout: persistent session sidebar, selection, conversation beside it | iPad Pro 13-inch (M5) | PASS |
| Rotation, reduced window, hardware keyboard, suspension during a turn, network loss, expired access, attachments, plans | — | NOT RUN yet |

Host-side findings from this run, outside the mobile app: `deleteProject` failed with `no such column: project_key` on the 14:08 `dist` build, and a project under `/tmp` lists no sessions because transcripts record `/private/tmp`.

### Defects found and fixed in this round

- Every prompt sent `contextWindow: null`. The contract warns that a session resumed without its window drops to the provider default and loses history. The window now comes from the model's profile, or from Claude's `[1m]` runtime variant.
- A host whose config lacks newer fields (`defaultModels`) failed to open a conversation. The config is now parsed with `hostConfigPatchSchema` over `DEFAULT_HOST_CONFIG`.
- `toggleSidebar` as a Swift selector name is ambiguous with a UIKit action; renamed.
- A release Android build could not reach a LAN host over `http://`; `expo-build-properties` now allows it.

### Shared changes made for the native boundary

- `TransportDisconnectedError` moved to `rpc-error.ts` (re-exported from `ws-transport.ts`), so the outbox no longer loads socket.io.
- `WsTransport.buildSolusApi()` is now the transport-neutral RPC and record API. Window behavior (`isVisible`, `openExternal`, file picking, uploads) moved to `ws-browser-api.ts` (`withBrowserCapabilities`), which `server-connection.ts` applies. The record context key takes the organization from a new `organizationId` option. `invoke` and `serverId` are public for the browser layer.
- `defaultDeviceLabel` moved from `pairing.ts` to `device-label.ts`; `pairServer` requires the caller's label and takes an optional `fetchImpl`.
- `SendOutbox` takes its storage as a constructor argument; the browser default is still `localStorage`.
- `formatUserCode` moved from the desktop main process to `device-authorization.ts`. The CLI keeps its own copy (`apps/cli/src/lib/onboarding.ts`).
- The root `tsconfig.json` excludes `apps/mobile`, which has its own project.
- `tests/unit/socket-io-transport.test.ts` builds its upload tests through the browser layer.

### Verification run

- `bun run --cwd apps/mobile check`: pass. `bun run --cwd apps/mobile test:logic`: 11 files pass. oxlint on `apps/mobile` and the native tests: clean.
- `bun scripts/test-unit.ts` for host-supervisor, pairing-decode, server-registry-decode, server-registry-uplink, session-history-pages, session-history-page-compatibility, send-outbox, account-store, cloud-account, client-core, server-connections, outbox-changed, and native-mobile: 23 files pass.
- `socket-io-transport.test.ts` fails in the runner before any test with `No such built-in module: node:sqlite` (from `packages/server/src/browser/cookie-sources.ts`, not this change). With a temporary preload that maps `node:sqlite` to `bun:sqlite`, all 17 tests pass.
- `packages/client-core` check: two baseline errors (`local-api.ts` `window.solus`, `server-connection.ts` `window.solusNative`); a third baseline error in `ws-transport.ts` is fixed.

### Still needed for milestone one

1. A machine with Xcode 26, an iOS simulator runtime, and CocoaPods: `bunx expo run:ios` on an iPhone and an iPad simulator (full and reduced windows), a hardware keyboard, restart, suspension during a turn, network loss, and expired access. Android Studio for the Android run.
2. Deploy the solus-cloud registration, then a cloud sign-in on a device.
3. A disposable host with Claude Code and Codex logged in, for one turn on each provider from the device.

### Open questions

1. **History and replay overlap.** `watchSession({ attachRuntime })` replays the turn in progress (`turnLog`) to the joining client; a history page read during a turn may already hold part of it, and no shared id lets a client match the two. The desktop client has the same exposure. A fix needs a turn id on history rows and replayed events, which is a host change outside this plan.
2. **Bundle identity.** `sh.solus.mobile` is a placeholder; it must be fixed before the first TestFlight upload.
3. **Plans of another session after a reload.** The desktop rebuilds these cards from history rows and `sessionMessagesSentBy`; the native client shows them from live events only.
