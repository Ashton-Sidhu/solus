# Mobile source

This workspace contains the T3 mobile app, its workspace dependencies, native inputs and licenses. T3 Code is distributed under the MIT license in `LICENSE`. The source comes from `https://github.com/pingdotgg/t3code.git`. The initial Solus integration used upstream commit `194025ef11027c95b0d226a4d2bbdafb92279eab`.

`SOURCE_PATHS` lists paths in the upstream checkout. Files from upstream's `apps/mobile/` go directly in this folder. Other upstream paths stay relative to this folder. The workspace and app manifests share one `package.json`, and the app is the root importer in `pnpm-lock.yaml`. `SOLUS_FORK_REVISION` records the fork revision used for the original import.

Make Solus mobile changes here. See `AGENTS.md` for the frontend and backend integration rules. Installation and tests use the source in this repository.

For an upstream update, compare the new T3 revision with the previous import over the paths in `SOURCE_PATHS`. Apply the relevant changes in an isolated Solus checkout. Keep the production app identity, the local `solus-core` import, the LAN module, and these workspace instructions. Review changes to the native package manifest, native inputs, patches and workspace dependencies. Install with the frozen lockfile, run the mobile checks and export both native bundles. Record the tested revision with the update.

The model picker sheet, its catalog filter, and its iOS and Android rows match T3 Code revision `9b7f5eb4479c5287340a863407ad083e2fdbeb7a`. The Solus adapter gives the sheet the host's model groups. The default list hides legacy models unless they are selected or favorited. Search and the Show legacy models filter can include them. The picker reads the selected host’s reasoning and Fast Mode options and saves catalog preferences on the project’s provider instance. The scheduled-task picker uses the same host catalog.

The mobile New session project selection and draft headings follow T3 Code revision `dd19bce823d833b5612fd74851d50047e65347fa`. Project picker rows use the upstream icon component and thumbnail cache. The selected Solus host supplies the signed favicon URL.

The home session rows and tablet sidebar use the T3 Code row styles and swipe controls checked at `dd19bce823d833b5612fd74851d50047e65347fa`. The row reads its project icon, provider, live status and read state from the Solus host.

The Solus thread screen uses the T3 Code composer reset from `a09738fb435120d08707db0142ca55b3b7b5c7ec`. On iOS, the conversation gives LegendList the visible height above the composer on each keyboard movement frame. T3’s keyboard-aware list and the previous Solus build both moved a message in the opposite direction at the start of keyboard opening in the same simulator. During an iOS follow-up send, end following pauses while the keyboard closes. The screen checks the final list position before scrolling to the submitted message. The draft heading uses the collapsed composer height for its position. Its scroll area ends above the actual composer, including attachments.

Project drafts and sessions use the T3 thread header and Git menu. Files reads the active checkout through the selected Solus host. The Git menu uses host repository status, Git actions, and session diffs. Terminal has no mobile integration.

Uploaded documents open in the T3 attachment reader from both drafts and sent messages. The Git overview, branch form, and commit form use the selected checkout on the Solus host. The thread uses T3 approval and proposed-plan cards for Solus requests. Scheduled-task creation and editing share the T3 editor layout and host, project, model, date, time, and repeat controls. The host supplies the schedule types, permissions, and save commands.

Session loading was compared with T3 Code revision `0591d32888dbd2f2f25915c245e6f1fe93dc4755`. T3 screens consume session rows and per-thread updates from the Solus stores. Mobile can show an authorized first page before session details arrive, reuse confirmed history blocks, and resume a retained live turn from its last event. See [Session open performance](../../docs/plans/session-open-performance.md#native-session-loading-and-reconnect) for the measurements and their scope.

The Files routes for drafts and sessions open the same T3 tree and preview screens. The tablet file navigator uses the same file queries. The Solus adapter in `src/solus/checkout-files.ts` supplies directory entries, indexed search results, file contents, and signed preview URLs for the selected host and account.

The thread route owns the screen host, header, draft layout, and inspector. `useThreadScreenData` supplies session state, supported actions, and Solus-specific conversation cards. The new-task and thread routes share the first-prompt transition after the local outbox saves the prompt.

Session navigation now uses the T3 opening hold and queued-creation check. The selected Solus host supplies one account-scoped read and watch to that hold and the screen. Home uses T3's visibility subscription. Home, the tablet sidebar, and arrangement controls share the result of T3's multi-environment shell release rules. The only change to the upstream release algorithm is its TypeScript snapshot type parameter.

The conversation adapter translates messages and ordinary tools into T3 turn items. Solus cards enter at their row position. T3's `buildThreadFeed` handles history and streamed row updates with the same restart cache. Media URLs, tool details, host permissions, and the host replay cursor remain Solus operations. Earlier pages use T3's history metadata and retry state.

Successful workspace image reads use T3's viewed-image row. The Solus adapter supplies the file path, and the Solus host signs the preview URL.

The archive, project picker, source control screens, settings queries, and preview selection were compared with revision `0591d32888dbd2f2f25915c245e6f1fe93dc4755`. The archive uses T3's multi-host snapshot aggregation. Folder browsing, pull requests, issues, and host settings reuse T3's query state, stale-on-mount refresh, and unchanged-result sharing. PR and issue edits use its per-environment command scheduler. Solus supplies the host operations and scopes each read by account, organization, and host connection.

The device and browser viewers share their selection and presentation helpers with the T3 features. Browser selection first considers pages used by the active Solus session. Solus owns device control leases, stream URLs, and host sign-in. Archive tag hiding and PR actions require corresponding host capabilities.

New-session and scheduled-task branch pickers use T3's branch paging hook. Their shared read uses Solus Git status and branch refs. Searching and paging reuse the checkout's answer. The host identifies a remote-only branch by its branch name and does not supply a remote tracking ref.

The T3 pull request and issue sheets use the selected host for edits, labels, reviewers, assignees, and review submission. A review names the head revision shown in the diff. Session review uses T3’s file list, line selection, and comment composer for working-tree, session, and turn diffs. The draft host and branch pickers use the Solus host list and checkout. A Solus session has one checkout, so a draft offers one project at a time.

The mobile Issues list can open a pasted issue URL in the T3 issue screen. The selected Solus host resolves the address and supplies the read-only issue details. The Issues list keeps its existing sources.

Solus uses GitHub Octicons for issue and pull request navigation and status icons. The native iOS PNGs and Android drawables match the shared SVG paths in `packages/client-core/src/github-octicons.ts`.

The mobile Usage tab and command palette use a pulse icon to match desktop and web Insights. Scheduled tasks and messages from automations use a connected-step icon.

Session rows follow T3 Code revision `dd19bce823d833b5612fd74851d50047e65347fa` for the Input and Done indicators and linked pull request badges. The Solus host supplies outstanding questions and completions on connect. A session record supplies its Git links. A later host event updates the badge. A single badge opens the PR and a group opens the linked PR sheet. Solus also shows the session’s recorded Git branch on active and compact rows, even when the session has no linked PR.

Saved sessions use Archive and Unarchive in both the phone list and the tablet sidebar. Archiving changes only the current person’s list. The host keeps the session, its history, and other people’s access. The upstream Delete action is omitted for saved sessions.

Hosts advertise support for personal session order and the shared auto-settle setting. The list uses T3’s move planner and writes each rank to its owning host. Guest sharing uses a Solus viewer link with a 24-hour lifetime for newly created links. A linked session reads from its paired host or from the signed-in organization’s transcript mirror. The terminal has no Solus host operation.

The queue sheet and T3 pending feed rows read the same Solus queue snapshot. A provider-native agent opens T3’s read-only transcript list from the Agents sheet. The execution host resolves the provider call in its parent session and supplies each history page.

The mobile PR list, detail, activity, diff pages, change breakdown, and review guide use T3’s persisted query lifecycle. A saved query can show its answer while the host reconnects or refreshes it. Solus stores each answer in the phone’s bounded PR cache under the account, organization, host, and query input. Removing a host clears its saved answers. The live list still reads the host’s projects, PRs, and provider viewer.

Solus replaces the working and waiting icons of T3's session rows with state marks: animated dot marks for live work and still line glyphs for the states that need the person (`docs/plans/session-state-marks.md`). Keep them when an upstream update changes the row's status indicator.
