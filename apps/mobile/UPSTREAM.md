# Mobile source

This workspace contains the T3 mobile app, its workspace dependencies, native inputs and licenses. T3 Code is distributed under the MIT license in `LICENSE`. The source comes from `https://github.com/pingdotgg/t3code.git`. The initial Solus integration used upstream commit `194025ef11027c95b0d226a4d2bbdafb92279eab`.

`SOURCE_PATHS` lists paths in the upstream checkout. Files from upstream's `apps/mobile/` go directly in this folder. Other upstream paths stay relative to this folder. The workspace and app manifests share one `package.json`, and the app is the root importer in `pnpm-lock.yaml`. `SOLUS_FORK_REVISION` records the last imported Solus fork revision.

Make Solus mobile changes here. See `AGENTS.md` for the frontend and backend integration rules. Installation and tests use the source in this repository.

For an upstream update, compare the new T3 revision with the previous import over the paths in `SOURCE_PATHS`. Apply the relevant changes in an isolated Solus checkout. Keep the production app identity, the local `solus-core` import, the LAN module, and these workspace instructions. Review changes to the native package manifest, native inputs, patches and workspace dependencies. Install with the frozen lockfile, run the mobile checks and export both native bundles. Record the tested revision with the update.

The fork import through T3 Code revision `620cf4770d992d642f822a13dc2539c2605a3500` uses the saved Solus candidate `c64d1f0ab74698d6d03006cf255e995cb0159176`. Its changes were applied to the promoted app with a three-way merge. Composer file links with punctuation also include the separate T3 Code fix `0d2d6a0233ff8e84c2ee287d4a9533633d7acff3`.


The bundled Markdown library uses its native singular and plural image-copy labels when T3 supplies only the default plural form. Languages with additional plural forms still use the library’s count table. The source change and fork revision are recorded in [the dependency notes](deps/README.md).

Mobile extends T3's image paragraph rule to screenshots on a separate line beside a caption. The native image view draws a cached bitmap as soon as it is ready. The loading label sits behind the bitmap while the load event is in flight.

## Public T3 Code partial import through 2026-11-26

This candidate compares public main at `d8f315a81f5f8244742d98a8aacb02a7668bcd6e`
with the full import at `620cf4770d992d642f822a13dc2539c2605a3500` and applies selected
changes to Solus main at `d78f9dcce5e3e0a455e94cb8f29d1f3ba9ded86a`. The full
comparison base stays at `620cf4770d992d642f822a13dc2539c2605a3500`. The earlier
public partial import and later fixes on Solus main are included in this
comparison. The iOS screens and project picker changes also reconcile the
earlier Solus candidate at `2739607124c1205da68f2f86766a7d98ae38c0e7`.

- **Workspace and drafts.** The mounted phone and tablet workspace stacks use the
  updated T3 screens fork and the collapsed column fix (#42490, #42593, #43148).
  Compose opens `NewTaskProject` directly when there is no project. T3's
  `newTaskDestination` reads the same Solus project filter and eligible hosts.
  Project selection opens the Solus `Thread` draft, and the first prompt follows
  `submitThreadComposerMessage` and the scoped Solus outbox. Android tablets can
  open subagents, linked sessions and previews in the inspector (#43210).
  `useOpenThreadInspector` selects the presentation. It uses the existing
  session, provider history and browser routes on the selected host.
- **Composer and media.** The shared `ThreadComposer` command menu ranks an exact
  skill above description matches and recognizes triggers after full-width spaces
  and nonbreaking spaces (#42879, #43302). Android paste restores the context of
  copied images if the clipboard returns only text (#37409). The native
  editor returns the original fragment to the shared composer. The existing
  picker, upload registry, and Solus outbox still accept the attachments.
  Mandarin Android dictation and floating dictation controls use T3's native
  and shared controllers (#41993, #42132). The keyboard patch adds Android
  state recovery and iPad window overlap (#40380, #42777). It keeps the
  Solus transcript inset behavior. Expo SDK 58 patch updates take the
  Android photo picker fix and the new share cache path (#42514, #40825).
- **Files and read-only history.** The mounted `ThreadFileScreen` and attachment
  routes keep media, CSV headings and partial-file warnings below the iPad
  navigation bar (#43352, #42928, #43320). The checkout adapter keeps
  `readProjectFile` and `assetCreateUrl` under the chosen account and host.
  ZIP previews reuse the attachment body and platform progress label.
  The shared Markdown helpers keep more file and thread links readable, and
  position math after a byte-order mark (#43094, #43284, #43285, #43194,
  #43442, #43318, #43453). Linked sessions and provider subagents show an
  earlier-page error at **Load earlier** and keep the loaded rows (#40973).
  The Solus history adapter uses its existing cursor and scope with
  `hostsLinkedSessionPage`, `sessionLineageHistory`, the cloud mirror or
  `loadSessionSubagent`. The error does not move the reader to the end.
- **Git, pull requests and issues.** `GitCommitSheet` keeps file exclusions
  after a failed commit (#43425). Its Solus adapter checks account, connection,
  checkout and branch, and clears the exclusions when `gitRunAction` reports
  a new commit. `ReviewCommentComposerSheet` shows a count for mixed diff
  lines when a range would run backwards (#42863). The mounted PR routes use
  T3's ordered diff pages, guide outline, checks labels and activity text
  (#42233, #43486, #43452, #42663, #42598). `prGetOverview`, `prChecks` and
  `prGetDiff` still supply the scoped data. `IssuesScreen` uses T3's
  `holdIssuePages` and `continueIssuePage` over `tasksSearch` or
  `tasksSidebarSnapshot`. It stops paging when no cursor remains and reads
  a singular comment count correctly (#42992, #43367).
- **Dependency and error handling.** The lockfile drops the unvendored
  `infra/relay` import that retained obsolete Expo patch hashes. The crash
  preview keeps an emoji whole at the text limit (#43260). Solus keeps its
  production identity, entry point, native discovery module and Markdown fork.

Remaining route and adapter work:

- Workflows needs `workflows.subscribe`, `workflows.get`, and run actions for
  `WorkflowsScreen` and `WorkflowRunRouteScreen`. Solus's scheduled-task
  operations do not supply workflow runs, steps, and answers. `FeedbackRequestCard`
  needs the `feedback_request` turn item and `agentFeedback.answerRequest` with
  its permission and consent fields.
- The full T3 linked-thread subscription still needs a Solus translation for
  `peerLinks.subscribeThread`, `peerLinks.threadHistoryPage`, and
  `peerLinks.threadItem`. The current sheet can retry a Solus page. The
  upstream side-chat submit command has no Solus operation.
- `ThreadFileScreen` needs the T3 legacy text fallback at the typed file read.
  Solus `readProjectFile` returns a permitted `kind: "binary"` record.
  T3 expects `ProjectReadFileError.failure === "binary_file"` and a signed
  `AssetResource` for `attachmentTextAtom`. The existing Solus asset API
  requires its own scope and lease. The checkout preview still uses its
  existing read and page controls.
- The active `VoiceModelSettings` uses `voiceModelStatus` and
  `voiceModelRetry` for one host model. T3's `VoiceModelSection` needs a
  model catalog and model-specific download and cancel calls. Its progress
  change is not a Solus voice settings change.
- T3's issue detail refresh assumes the comments preview travels with the
  detail result (#43410). The Solus issue adapter still reads the detail and
  `tasksSearchComments` separately. T3's withheld-patch classification
  (#43497) needs the Solus `prGetDiff` response to distinguish a missing
  zero-count patch from an empty file diff.
- The share handoff to an open draft (#42597) starts in
  `IncomingShareProvider` and is consumed by T3's `NewTaskDraftScreen`.
  The mounted Solus draft uses the `Thread` route and its own admission
  controller. That route still needs to consume the shared handoff. The
  T3 Stop check (#42918) reads a `run_interrupt_request` projection item.
  The active Solus composer in `use-thread-screen-data.tsx` gets steer
  availability from the Solus session status and needs an equivalent
  pending-stop signal. Offline settle and snooze (#24917) need a
  scoped replay operation for the Solus list actions. The Archive screen
  continues to call the selected host through `setArchived`.
- The T3 Markdown tarball update and its link wrapping and checkbox indexing
  changes remain pending. The Solus fork has native image-copy labels that
  must carry forward. LegendList, Reanimated, Clerk, and the wider T3
  session-open changes also remain pending.

The frozen root and mobile installs passed. The focused mobile suites passed
439 tests with the default iOS configuration and 43 with the Android
configuration. The shared workspace suites passed 340 tests, and 13 host test
files passed on SQLite. The fixtures include saved and first reads, stale pages
after a scope change, signed media, a failed commit, and a failed or interrupted
history read. The native iOS composer checks passed. Production Expo exports
contained Hermes bundles for both platforms and configured `sh.solus.mobile`
for both. The mobile type check reports the same 63 errors as captured main.
The run used route and host fixtures for verification. It did not run Android
native tests or exercise native layouts on a device.

## Public T3 Code partial import through 2026-11-24

This import compares public T3 Code main at `a7a6126a7d9b364c0fbef3f7fe1a087c4b004393` with the last full import at `620cf4770d992d642f822a13dc2539c2605a3500`. The full comparison base stays at `620cf4770d992d642f822a13dc2539c2605a3500`. The fork revision records the earlier fork import. The composer path fixes and Live Activity fixes already listed here were reconciled with the public changes.

This import includes file-backed composer photos, the iOS paste preparation and original image formats, media actions on each image page, Android language refresh, the Favorites only model filter, session ordering with disconnected hosts, swipe label spacing, the larger Viewed control in PR diffs, and limits on which links can open in previews. The Solus adapters keep signed resources and the trusted host registry. A manual pairing code uses the shown address. The review sheet passes the revision the user reviewed to the Solus host. This import kept the Solus conversation cards, collapsed tool calls, and changed-files summaries.

Pending upstream work includes Workflows and the T3 agent feedback screens, the T3 linked-thread paging presentation, and model changes for queued messages. Those paths need the corresponding Solus host operations or adapter behavior. The import keeps the Solus thread route and live checkout confirmation. It takes the Unicode branch label change from the Git menu.

The frozen dependency install, focused mobile tests, native iOS composer tests, and production Expo exports for iOS and Android passed. Both app identifiers were `sh.solus.mobile`. The broad mobile suite, mobile type check, and two host test files still report failures that also occur on the clean Solus revision used for this import.

The model picker sheet, its catalog filter, and its iOS and Android rows match T3 Code revision `9b7f5eb4479c5287340a863407ad083e2fdbeb7a`. The Solus adapter gives the sheet the host's model groups. The default list hides legacy models unless they are selected or favorited. Search and the Show legacy models filter can include them. The picker reads the selected host’s reasoning and Fast Mode options and saves catalog preferences on the project’s provider instance. The scheduled-task picker uses the same host catalog.

The mobile New session project selection and draft headings follow T3 Code revision `dd19bce823d833b5612fd74851d50047e65347fa`. Project picker rows use the upstream icon component and thumbnail cache. The selected Solus host supplies the signed favicon URL.

Saved sessions expose their messages and visible turns to T3's thread detail selectors. The open screen and stream haptics read the same account-scoped conversation. The host signs checkout downloads and returns image dimensions when available. A Markdown image keeps its first frame while the URL loads. Quoting a reply in a saved thread focuses that thread’s editor. The quote action keeps the same identity when the native composer replaces its handle, so that change does not invalidate transcript rows. The Solus session adapter keeps the detail reference, display state, and queued-message edit action stable across unrelated updates. The list reuses its grouped rows while its feed and grouping inputs stay the same. The compact list reuses its measured viewport at the same window size. Inline HTML reserves its frame immediately and starts its WebView after the list reaches its initial scroll position. The full-text reader accepts downloads up to 8 MiB. For larger text files the host locates the cited line and returns the page that contains it.

The thread header reads the checkout summary. Opening Git loads the detailed status. Files and Git use the adaptive workspace inspector. The host reports provider switching and side-chat command support to the composer. The current Solus host has no side-chat command handler.

The Solus thread route shows a small activity indicator and muted text while a session opens. The back or close control remains available during the wait.

The home session rows and tablet sidebar use the T3 Code row styles and swipe controls checked at `dd19bce823d833b5612fd74851d50047e65347fa`. The row reads its project icon, provider, and read state from the Solus host. The Solus adapter reads execution status from the runner’s saved session record and applies newer revisions from host events.

The shared mobile search scorer and its tests include T3 Code pull request [#37700](https://github.com/pingdotgg/t3code/pull/37700). The home list, tablet sidebar, and command palette use this scorer for exact phrase matching and highlighting.

The conversation shows **Completed | Reopen** in T3 Code's floating control above the composer. Solus moves this state from the imported transcript row to match its mobile layout. The control reads the same session state as the home list and tablet sidebar. **Reopen** updates the session on its Solus host.

The Solus thread screen uses the T3 Code composer reset from `a09738fb435120d08707db0142ca55b3b7b5c7ec`. The iOS and Android transcripts use T3 Code's keyboard-aware list from revision `a7a6126a7d9b364c0fbef3f7fe1a087c4b004393`. On iOS the list registers its scroll view with the screen controller and receives the initial composer inset when it mounts. Follow-up sends use the upstream keyboard dismissal and end-follow behavior: on iOS the list keeps its lift while the keyboard closes, then scrolls to the end. The draft shows the first prompt when the controller accepts it, including while its attachments save. On iOS the first prompt takes its anchor before it appears and skips the glide. A sent screenshot keeps its composer image dimensions through delivery. If sent before its preview loads, it keeps a 4:3 frame. Reduced Motion makes the scroll immediate. The transcript appears as soon as the list can paint the first prompt. The draft heading uses the collapsed composer height for its position. Its scroll area ends at the measured top of the composer as the keyboard or attachments change its position.

The opening transcript uses the draft composer's live keyboard offset. The first prompt can appear while the keyboard closes.

Project drafts and sessions use the T3 thread header and Git menu. Files reads the active checkout through the selected Solus host. The Git menu uses host repository status, Git actions, and session diffs. Terminal has no mobile integration.

Uploaded documents open in the T3 attachment reader from both drafts and sent messages. The Git overview, branch form, and commit form use the selected checkout on the Solus host. The thread uses T3 approval and proposed-plan cards for Solus requests. Scheduled-task creation and editing share the T3 editor layout and host, project, model, date, time, and repeat controls. The host supplies the schedule types, permissions, and save commands.

Session loading was compared with T3 Code revision `0591d32888dbd2f2f25915c245e6f1fe93dc4755`. T3 screens consume session rows and per-thread updates from the Solus stores. Mobile can show an authorized first page before session details arrive, reuse confirmed history blocks, and resume a retained live turn from its last event. See [Session open performance](../../docs/plans/session-open-performance.md#native-session-loading-and-reconnect) for the measurements and their scope.

The home list and tablet sidebar use one `sessionDirectoryOpen` request per connected host on startup. It returns the first 32 sessions, extra pinned records, projects, codebases, attention state, and automation names. The host applies the caller's access rules to each read. The native directory keeps the opening metadata with the session rows in the scoped device cache. Later pages and recent history load separately. Older hosts use the individual reads.

Session list and open speed (approved by the maintainer). These changes are below T3's screens; T3's list, row, and thread components are unchanged except for one press handler.

- **First-frame list.** T3 shows its saved shell snapshot when its environment list is read. Solus reads its hosts and its account from the keychain first, so the saved list showed only after `solus.load()`. Each start now saves its account scope and its host ids in device storage (`solus.mobile.lastSessionList`). The next start restores the saved directory of those hosts at once, with that scope (`SolusApp.presumeLastSessionList`, `ThreadDirectory.restore` with a presumed host). When `load` finds another scope, every list read in the old scope is forgotten and its reads end, as at an account switch. A presumed host that the registry knows as another installation, or still does not list after the host list and the directory answered, loses its rows. The start also reads the key index of each host's device cache once (`PullRequestCache.readResponseKeys`), so the open knows if a saved page exists.
- **Device cache.** T3 keeps its shell and thread copies in `client_cache` of `src/persistence/mobile-database.ts`. Solus keeps the session directory and history pages in its bounded `PullRequestCache` table. A move to `client_cache` is not a small change: that database is an Effect service, it has no read of the keys without their payloads, and only its pull request kind is bounded.
- **Prefetch.** T3 reads a thread when it opens. When a host's list loads on a ready connection, Solus reads the first history page of each row of the list, top down, in batches of eight, and saves it (`HistoryPrefetch`). The next batch starts when every read of the batch has ended. The device cache keeps 256 records and 32 MB for each host and removes the oldest writes first, so a warm stops after 128 rows or 16 MB of pages: later pages never push out the pages at the top. It skips a row whose saved page was written after its last activity, a session of 16 MiB or more, and the background. A new warm, a scope change, or a new connection stops it, and a page read in an old scope or on an old connection is not kept. A press on a row (`onPressIn` of `ThreadListV2Row`, for the phone list and the tablet sidebar) starts the same read for that session. The read uses the request of an open with a saved page (ten turns, the same history options), and an open takes a read that is under way as its saved page.
- **Open timing.** A build made with `EXPO_PUBLIC_SOLUS_OPEN_TRACE=1` writes one `[session-open]` line for each open: the press to the first painted rows, with the disk read, the prefetch wait, the network wait, the model build, and the render.

Session shell (approved by the maintainer, [phase 3 of the mobile session shell plan](../../docs/plans/mobile-session-shell.md)). A host with the `sessionShell` capability gives the home list and the tablet sidebar one shell, as T3's `client-runtime/src/state/shell.ts` does. T3's screens and its release rule are unchanged.

- **Kept from T3.** The status model (`empty`, `cached`, `synchronizing`, `live`), the cursor protocol (a snapshot, the changes after a cursor, a refusal that asks for a snapshot), a new open on a gap or a new server session, a save only when the sequence moves forward, and T3's device table `client_cache` (kind `shell`) through `MobileDatabase`. `stepSteadyShells` gets the shell's own status, sequence, and generation (`navigation-threads.ts`).
- **Different from T3.** The driver is `SessionShells` in `solus-core/features/threads/session-shell.ts`, not T3's `EnvironmentShellState` and `applyShellStreamEvents`: those are typed to T3's row, which has no place for the Solus facts of a row (automation name, codebase, agent activity, attention). The driver keeps the Solus rows (`SessionShellRow`) and applies a keyed replace. It gives each change to `ThreadDirectory` (`receiveShell`), so cloud-only rows, one row for a session on two hosts, shared-with-you arrivals, search results, child sessions, and point reads keep their path, and to `ThreadListState` (`receiveShell`) for pins, attention, and agent activity. Row actions keep their quick local change through the host's events. `session-list.ts` projects the rows to T3 rows, and `hostAway` stays on the phone.
- **Storage.** `apps/mobile/src/solus/session-shell-store.ts` runs `MobileDatabase.loadCache` and `saveCache` on T3's mobile runtime (`src/lib/runtime.ts`). The key is `solus-session-shell:v1:<account scope>`, so it does not meet T3's own `snapshot` record, and a record of one account scope never fills another. The record also names its scope, and the driver drops a read or a save of a scope that changed. A forgotten host loses its `shell` records.
- **Start.** `ThreadDirectory.restore` reads the saved shell first, with the saved account scope, then the older directory copy. The launch splash counts that read (`shellCachesRead`). Rows that a start restores hold the splash until Home's list has laid them out, also when the read ends before Home mounts. The splash fades out in 250 ms instead of T3's cut; Reduce Motion keeps the cut.
- **Choice of path.** `runtime.ts` follows the shell when the host's capabilities name `sessionShell` (`readsSessionShell`); on a connection that has not read its capabilities, it waits for them once. Other hosts keep `sessionDirectoryOpen` and the record reads. Phase 4 removes those reads.

For saved transcripts, the host supplies HTML fence positions and dimensions. The phone uses T3's frame sizing and reserves the frame before the WebView loads. A reply without a measurement gets a scrollable 320-point preview. Solus still supplies the inline document and its full-screen reader. Uploaded transcript photos use T3's attachment image row and gallery. The selected host signs their URLs for the source session. A slow disk cache can supply an early preview while the first host page is in flight.

Saved artifacts (`render_artifact`, and `update_work` on an artifact work) use T3's `html-render` row. Each version has the attachment id `artifact:<workId>:<contentVersion>`. The host measures the version when it is saved and sends its frame on the live event and the history receipt. The selected host signs the page of that version in the caller's account scope and serves it in a sandbox. The conversation adapter gives each version to T3's feed builder as a finished `html_render` call, so the row, its size, and its reader are upstream. The phone has no artifact group card, folded earlier version, or works history record on open, because T3 has none. See [Mobile artifact pages](../../docs/plans/mobile-artifact-pages.md).

The Files routes for drafts and sessions open the same T3 tree and preview screens. The tablet file navigator uses the same file queries. The Solus adapter in `src/solus/checkout-files.ts` supplies directory entries, indexed search results, file contents, and signed preview URLs for the selected host and account.
Solus reads large checkout text files as read-only source pages through the same
file permission and account scope. The user can copy one page at a time. The
sidebar project menu opens the existing Add project screen. A new draft uses
the sidebar project filter and prefers the viewed host if it has a usable
checkout of that project.

Image and video file links in a session use the same Solus host and file access rules as the Files preview. The Solus adapter requests a fresh signed URL from that host when T3 opens the native preview.

The thread route owns the screen host, header, draft layout, and inspector. Saved sessions use T3's content presentation, delayed sync subtitle, and inspector fallback. A saved page stays readable during a reconnect. An access refusal hides its rows. A session from the phone cache opens through the same account-scoped watch as a session from the list. After the selected host's phone cache has been read, a direct link outside the list uses the scoped session record query. The fallback can retry that query or reconnect the host. `useThreadScreenData` supplies session state, supported actions, and Solus-specific conversation cards. The new-task and thread routes share the first-prompt transition after the local outbox saves the prompt.

The async question card follows T3 Code revision `6d4375aaf88c2dedbee7d056e9afe54396387440` for dismissal, the native attachment picker, and image paste. The answer field of every standard question, async or one that a Claude or Codex turn waits on, shows the picker as a paperclip beside the text. An MCP form takes no files. Solus uses the mounted session and its host for the answer. Each question keeps its own attachment draft on the device. On Submit, Solus uploads the files to the session host and adds their host paths to the matching answers. Dismiss without answering sends the host's empty answer. It can close the question after its turn ends.

The composer follows T3's Stop and follow-up dispatch rules. A draft has no Stop control. After submission, the Solus adapter enables Stop when the host reports an active turn or cancellable setup. T3 chooses between queue and steer at send time. The Solus outbox saves the prompt and the host admits it to the session. The local outbox can show a busy state while the host has yet to take the prompt.

The active thread route uses T3's pending-message feed for a plain-text first prompt or an idle follow-up. The composer and the host use the same message ID. T3 shows the pending row while the loaded transcript keeps its row order. Host events or the result of delivery move the row into the transcript. The route and the upstream composer share draft clearing and recovery after a failed local save. Mobile keeps one Solus outbox record for host delivery, including task context, retries and host refusals. New records carry the account and organization scope. A record from an earlier app version acquires that scope on its first replay.

The active phone and tablet chat routes share T3's composer input state and submit actions. Both composers select the current draft when an edit arrives, lock queued edits during save, check the draft again after an approval, and restore a follow-up when its local save fails. A first prompt opens the thread after local save. The Solus outbox adapter translates the T3 message ID, context, and dispatch mode for the conversation controller. The controller owns host uploads, durable delivery, and reconnect retries. A reply from an earlier account cannot clear or restore the current draft.

Session navigation now uses the T3 opening hold and queued-creation check. The selected Solus host supplies one account-scoped read and watch to that hold and the screen. Home uses T3's visibility subscription. Home, the tablet sidebar, and arrangement controls share the result of T3's multi-environment shell release rules. The only change to the upstream release algorithm is its TypeScript snapshot type parameter.

Chats restores the saved session list when the same host reconnects. If the list is empty, the Solus records adapter gives T3's list the newest 32 sessions as soon as the host returns its first activity-ordered page. The adapter reads the remaining pages in the background. For older hosts that cannot sort by activity, it reads and sorts the complete list before showing rows.

On a connected cache miss, the phone waits for the first history page before mounting the conversation screen and composer. T3's list mounts its visible cells in a native column at the bottom of the first viewport. The column follows the native scroll offset and reserves the composer inset. After measurement the same cells use their virtual list positions. Opening at a specific message keeps T3's normal scroll positioning. On the first open of a saved session, the phone sends one request (`openSession`): the Solus host returns the page and the session description together and joins a settled session's watch for this client. With a saved page, the phone paints the saved page at once and sends the block hashes of that page in the same request, so an unchanged page costs little. Older hosts use the separate description and watch operations.

Mobile asks the session host or cloud mirror for T3 message and tool bodies on the first page and each older page. The adapter supplies row identity, timestamps, attachments, and Solus actions. Live events and older hosts use the same tool conversion on the phone. Solus cards enter at their row position. T3's `buildThreadFeed` handles history and streamed row updates with the same restart cache. It resolves tool labels, work entries and disclosure details on first use, so grouping a saved page can skip that work for hidden rows. Media URLs, tool details, host permissions, and the host replay cursor remain Solus operations. Earlier pages use T3's history metadata and retry state. When the device knows its cache has no page for a saved session, it requests five turns on selection. When the first page fills the viewport, the list starts loading the rest of the ten-turn window on the first scroll. A short page fills after the list lands. On iOS, a session of at least 16 MiB starts with two turns when the phone knows whether it has a saved page. A wider page already on disk can open at its saved size, up to ten turns. The adapter can request the first older page while the host checks the saved page. It discards that read if the saved page changed. Once T3's list reaches its opening position, the adapter adds up to eight older turns in two-turn pages. It waits for a frame between pages and lets a drag or momentum scroll finish before inserting a page. “Load earlier activity” can request another twenty turns. On a reopen, the phone sends the block hashes of its saved page in the opening request. For an unchanged settled session, the host confirms the rows and joins the live watch in one response. The revision covers the projected rows in order, the older cursor, and turn diffs. Active sessions retain the separate replay and watch path. A retained session uses its existing watch.

Project and thread lookups use T3's entity selectors on a snapshot for each paired host. Single live turn-item and message updates use T3's projection reducer. An inherited row, a group of changes, or a page boundary gets a fresh projection from the ordered feed. Solus still owns the replay cursor and interactive cards.

Hosts can return composer file paths separately from prompt text on a saved history page. Live events and older pages use the same composer format. Hosts with the checkout status capability return T3's Git status fields in one read. File previews identify directories after the host checks the path scope. Older hosts retain the previous reads.

A jump from search or a citation sends T3's `throughEntryId` with the current history cursor. The session host or cloud mirror returns contiguous turns toward that message. If the target is farther back than the bounded response, T3 continues from its cursor. Ordinary scrolling still requests one page. Older hosts can serve the same interaction one page at a time.

Chat uses the provider startup behavior from T3 Code PR #41928. Solus supplies
the active provider and startup step through the session event stream. Claude
receives Solus MCP servers as query options and can report its first API request.
Codex reports thread resume and pre-turn MCP startup.

Mobile follows [T3 Code PR #41317](https://github.com/pingdotgg/t3code/pull/41317)
for turn diffs. Open **Review changes** from the thread's Git menu to see a
turn's diff. The mobile Chat settings can set the shared preferences for
changed-files summaries on desktop and web.

Solus background command notices mark the start of a turn in the T3 feed. Live notices use the host's origin tag. Saved history uses the same text parser as desktop and web. The compact row opens to show the command and the available output in the thread and in read-only history.

T3's background work line names each task from the kind and description that the Solus host sends. With the Chat setting "Hide background row for servers" on, the line stays out when the only work still running is servers that the thread's agent started. The Running servers sheet shows and stops them (`docs/background-work.md`).

Successful workspace image reads use T3's viewed-image row. The Solus adapter supplies the file path, and the Solus host signs the preview URL.

The archive, project picker, source control screens, settings queries, and preview selection were compared with revision `0591d32888dbd2f2f25915c245e6f1fe93dc4755`. The archive uses T3's multi-host snapshot aggregation. Folder browsing, pull requests, issues, and host settings reuse T3's query state, stale-on-mount refresh, and unchanged-result sharing. PR and issue edits use its per-environment command scheduler. Solus supplies the host operations and scopes each read by account, organization, and host connection.

The device and browser viewers share their selection and presentation helpers with the T3 features. Browser selection first considers pages used by the active Solus session. Solus owns device control leases, stream URLs, and host sign-in. Archive tag hiding and PR actions require corresponding host capabilities.

Loopback browser pages stream from the selected Solus host. Its Host settings screen shows **Preview tunnel** when the host supports that setting. This control governs desktop port forwarding and shows the selected host’s policy lock.

Streamed browser select menus use the choice sheet from [T3 Code #31561](https://github.com/pingdotgg/t3code/pull/31561). The Solus adapter receives the choices through the existing browser interaction RPC. The host withdraws the offer through the browser page feed. The browser screen and loopback preview use the same sheet. The floating preview is view-only.

The session header opens the Solus Running servers sheet. Its 55% sheet height,
native header action, and scroll insets follow the T3 linked pull requests sheet in the saved fork
revision `c64d1f0ab74698d6d03006cf255e995cb0159176`. The sheet uses the shared
Solus server controller for the run host and opens endpoints in Browser preview.
The empty state opens Server URLs for the selected session folder.
The sheet uses T3's provider icon for the launch provider reported by the host.

New-session and scheduled-task branch pickers use T3's branch paging hook. Their shared read uses Solus Git status and branch refs. Searching and paging reuse the checkout's answer. The host identifies a remote-only branch by its branch name and does not supply a remote tracking ref.

The active thread and draft routes share T3's project and host controls for short viewports. Solus supplies the project and host choices and adds its workspace controls. The draft, Git header, and branch sheets read the T3 branch and status types through one adapter in `src/solus/checkout-git-queries.ts`. The adapter reads the selected host's checkout and subscribes to its checkout changes. It scopes reads by account, host connection, and folder. The branch can appear before the worktree scan and pull request lookup finish. Git mutations still use Solus's session or session-folder context and checkout confirmation.

The active composer and the T3 draft attachment flow share the system media picker and native binary transfer. The Solus picker uses T3's MIME detection when the picker supplies generic metadata and uses T3's JPEG renderer for HEIC photos and camera library photos with no type or extension. Local image and video tiles use T3's thumbnail components during upload. The picker can download original media on iOS. The Solus composer uses T3's upload registry with three transfers per host, progress, and cancellation of a removed in-flight transfer. The controller keeps the order of a selection and lets a submitted prompt wait for its files. The Solus host returns a signed URL and a conversation file path. Hosts that accept image references receive uploaded photos by reference. Older hosts still receive inline images. The active composer keeps Solus media limits and prompt admission. Failed uploads stay in the composer and use T3's Retry control. With a host that supports pending streams, the composer verifies a lost upload response, keeps the file before it sends a prompt, and discards staged bytes when the person removes the attachment. The host expires abandoned stages and only a kept file enters the conversation. The inline path for older hosts and files without a streaming path retains the existing host storage behavior.

During image paste, the composer keeps T3’s preparation indicator in place. On iOS the native editor sends the reserved slot count with the prepared files so the row stays mounted until the local preview takes its place. A host upload can continue while the preview is visible.

The mobile file picker and native image paste use T3's JPEG renderer for HEIC
photos. If the transcript recorded a converted upload as a file, mobile,
desktop, and web can show the stored JPEG from the signed host URL.

The mobile PR review uses T3's Viewed controls and optimistic state. Solus supplies the viewer's file marks and checks that the selected repository and displayed PR head are current before a write. The PR list sends T3's filters to the Solus GitHub search and applies host lifecycle and edit replies to the loaded pages with T3's list patcher. The detail and actions keep Solus's repository and head checks. Mobile Issues uses T3's multi-host merge, list pager, and comment pager. The Solus adapter creates stable per-scope continuation cursors from one authorized `tasksSearch` or `tasksSidebarSnapshot` result. A continuation reuses that snapshot while it is current.

The mobile notification and Live Activity presentation follows T3 Code revision `84a0c0516f53bfa3d0a9d64985f21083d757d93d`, including the expired Dynamic Island count fix. Solus supplies account-scoped attention snapshots and uses its own ActivityKit relay for linked hosts. Android uses T3’s native ongoing notification with the Solus session feed while the phone is connected. The Solus sign-in and host list own the data path. See [mobile delivery](../../docs/notifications.md#mobile-delivery).

The T3 pull request and issue sheets use the selected host for edits, labels, reviewers, assignees, and review submission. A review names the head revision shown in the diff. Session review uses T3’s file list, line selection, and comment composer for working-tree, session, and turn diffs. The draft host and branch pickers use the Solus host list and checkout. A Solus session has one working directory, so a draft offers one project at a time. A session can work in more folders than its working directory: the session folders that its codebase and its attached folders give (see the last sections).

Mobile keeps T3's review draft file on the device. Solus scopes it by account and host. The PR Activity author rows already expose native headings for reviews, comments, and discussions, as in T3 Code PR #39648.

The native PR merge controls use Solus host RPCs for stack membership, immediate merge, and auto-merge. The selected host checks permissions and the heads that the confirmation showed. GitHub reports stack auto-merge on the layer where it was turned on. The T3 workflow approval control also uses Solus host calls. The host supplies the waiting runs, and the confirmation sends the head commit shown to the user. This follows T3 Code PR #26561 for same-repository and fork pull requests.

The session review picker follows T3's Changes and Uncommitted choices. The Solus host supplies both comparisons and uses its own target branch selection. The picker also offers Session for the session's accumulated changes.

The mobile Issues list can open a pasted issue URL in the T3 issue screen. The selected Solus host resolves the address and supplies the read-only issue details. The Issues list keeps its existing sources.

The mobile issue screen uses the T3 State menu for GitHub planning statuses.
The Solus host supplies the status names, checks the viewer's permission and
accepts the status ID through the task move operation. The Issues list can
filter loaded rows by planning status. Issue comment author rows already use
the T3 heading role on iOS and Android.

Solus uses GitHub Octicons for issue and pull request navigation and status icons. The native iOS PNGs and Android drawables match the shared SVG paths in `packages/client-core/src/github-octicons.ts`.

Mobile hides the Usage tab on phones and tablets. The Usage command still opens provider usage limits and uses a pulse icon to match desktop and web Insights. Scheduled tasks and messages from automations use a connected-step icon.

The home list and tablet sidebar use the row metadata layout checked at T3 Code revision `ddaba13471790c4bc0f8c0f9bb6aafb3e77b27be`. An active row shows the host or runtime error next to the PR and provider badges. The Solus host supplies outstanding questions and completions on connect. A session record supplies its Git links. A later host event updates the badge. A single badge opens the PR and a group opens the linked PR sheet.

Saved sessions use Archive and Unarchive in both the phone list and the tablet sidebar. Archiving changes only the current person’s list. The host keeps the session, its history, and other people’s access. The upstream Delete action is omitted for saved sessions.

Solus keeps pinned sessions at the top of the phone list and tablet sidebar after completion. Each pin uses one line with the title and pin mark. Active pins can also show status and linked PR badges on that line. Archive clears the pin.

Hosts advertise support for personal session order and the shared auto-settle setting. The list uses T3’s move planner and writes each rank to its owning host. Guest sharing uses a Solus viewer link with a 24-hour lifetime for newly created links. A linked session reads from its paired host or from the signed-in organization’s transcript mirror. The terminal has no Solus host operation.

The queue sheet and T3 pending feed rows read the same Solus queue snapshot and start edits through T3's queued-edit store. T3 handles attachment-only draft text and recovery when a run leaves the queue. Solus preserves host file references and submits the opened revision with an edit.

Standard tool approvals use T3's approval card and feedback action. Solus maps each decision back to the original host option ID. Provider-specific choices keep their original buttons. Typing during an approval can send denial feedback only when the provider accepts it. Secret and Add machine requests keep their own host operations.

The Agents sheet and its route match T3 Code revision `2fe7febc8d73dda7dcc912e8cca3cd65660a0c9d`. Solus uses live and saved provider results to show the final state and elapsed time when a completion time is available. The row preview skips the provider’s hand-back instructions. A provider-native agent opens T3’s read-only transcript list from the Agents sheet. The execution host resolves the provider call in its parent session and supplies each history page.

The mobile PR list, detail, activity, diff pages, change breakdown, and review guide use T3’s persisted query lifecycle. A saved query can show its answer while the host reconnects or refreshes it. Solus stores each answer in the phone’s bounded PR cache under the account, organization, host, and query input. Removing a host clears its saved answers. The live list still reads the host’s projects, PRs, and provider viewer.

Solus replaces the working and waiting icons of T3's session rows with state marks: animated dot marks for live work and still line glyphs for the states that need the person (`docs/plans/session-state-marks.md`). Keep them when an upstream update changes the row's status indicator.

Phone and tablet use T3 Code's **Fork from this response** button and its **Forked from conversation** row, checked at `9f24cac6d42f99e92569b7cbd97ec07932f232d8`. The Solus host supplies the completed Codex or Claude Code response, saves the new session, and reads its history through that response. The first prompt uses the source provider on that host.

The repositories section of the project overview (`ProjectRepositoriesSection`) matches T3 Code pull request 35925. In T3 Code, a project keeps a list of tracked folders, and it covers the repositories found inside them. In Solus, a project is one folder or one repository on one host. A folder that is not a repository and that holds two or more repositories is a container, and a container is a codebase, not a project. A codebase is a named set of folders on one or more hosts: two or more projects, or one container (`docs/plans/codebases.md`). The section shows the folders of one codebase. `src/solus/codebase-folders.ts` gives the section its folder list, its `.code-workspace` suggestions, and its add and remove command from the codebases model in `solus-core/features/codebases/`. The model owns each read. It keeps the copies by account and organization, and it reads a host again on each new connection. The app reads the codebases from its start (`startSolus`). These are the intended differences:

- The section takes `codebaseId`, and `member` names only the host. The section does not read `filesystemEnvironment.listFolders`, `filesystemEnvironment.scanFolders`, `projectEnvironment.update`, or the T3 session scopes. The permission to use the host stands in for both scopes.
- **One section for one codebase.** The project page shows one section for each codebase that holds a checkout of the project, with the name of the codebase as its title (`src/solus/ProjectCodebases.tsx`). The rows are the folders on the host of the checkout, then the folders on each other host. A row of a different host shows the name of that host where a row of this host shows the path. Each root has the upstream "Remove" button, also on a different host. A repository that a host found in a container has none.
- **Shorter rows.** A row has its name and one line below it. It does not show "Git repository" or "Folder". A folder that is not on the disk shows "Missing" at its end. A folder that a workspace file lists shows only its path below "Add {name}". The section has no text below it.
- **Menu of the codebase.** The heading of the section has a menu (T3's `Menu` with the `ControlPill` "ellipsis", as an account row has) with "Rename" and "Delete". "Delete" asks in an alert: "Delete {codebase}?", "Its folders and their files stay on the disk."
- The section has a slot for rows after the folders. Solus puts "Add folder" there. It opens T3's Local folder screen (`AddProjectLocal`) with a `codebaseId` parameter: the chosen folder then becomes a root of the codebase, and no project is added. When more than one host is connected, the row opens a menu of the hosts first.
- **Make a codebase.** A checkout that is in no codebase gets the section "Codebase" with the row "Make a codebase". It opens T3's Local folder screen with a `codebaseWith` parameter (the folder of the project). The screen has the title "Second folder" and the button "Make codebase". It then asks for the name in a prompt ("Codebase name"), with the plain name of the two folders as the first value (`plainCodebaseName`: `solus` for `solus` and `solus-cloud`), and makes the codebase (`makeCodebase` in `src/solus/project-host.ts`).
- **A container.** The host makes the codebase of a container when a person adds the folder with T3's Add project flow (`addLocalProject`). The draft then opens in the container folder, and its heading shows the name of the codebase. `ThreadDirectory.projects()` leaves out each container root of a codebase (`isContainerRoot` of `@solus/client-core/codebases`), so T3's project pickers, the project filter, and the Projects page do not show it. T3 Code has no list of codebases, so the phone has none: a person starts a session of a container from a project inside it, or with Add project and the container folder.
- **Badge of a codebase session.** A session row of a session in a codebase (`codebaseId` on its record) shows the badge of that codebase, not the mark of one of its projects: the colour and the letters or emoji of the codebase record (`codebaseMark`), drawn with T3's monogram and emoji glyphs (`ProjectIconGlyphView`) and stacked on a second card of the same colour. A session whose codebase was deleted, or that the phone has not read, shows its project. The session list projection (`src/solus/session-list.ts`) sets `codebase` on the row and projects every row again when the codebases change; `ThreadListV2Row` passes it to `ProjectFavicon`. The menu of a codebase on the project page adds **Icon** (a prompt: one or two letters, or one emoji) and **Colour** (Automatic and T3's 18 project icon colours). T3 Code has no codebase, so it has no such menu items (`docs/plans/codebases.md` §11d).
- "Remove" on a folder that the codebase cannot be without is refused by the model, with the text of the shared rule ("A codebase has at least 2 folders, or one folder that holds repositories. To remove this folder, delete the codebase."). The section shows it in its failure alert. A folder that is inside a folder of the codebase, or that holds one, is refused the same way.
- The text of the section says "codebase" where T3 Code says "project".
- The route `SettingsProjectOverview` opens the Solus project page (`ProjectSettings` in `src/solus/HostSettingsControls.tsx`). That page and the unmounted `SettingsProjectOverviewRouteScreen` both show the sections through `ProjectCodebases`.
- **Codebase naming.** The Worktrees settings page has the section "Codebase naming" below the branch naming: "Generated name" or "From the folder names" (the personal setting `codebaseNaming`).

The repository screens of a thread also match T3 Code pull request 35925. In T3 Code, a thread reaches the tracked folders of its project. In Solus, a session has one working directory and a list of session folders (`docs/plans/codebases.md` §6): the members of its codebase on its host, the folders that a person or the agent attached, and, in a task folder, the session's own worktree of each repository. The host owns that list. `src/solus/session-repositories.ts` has the rules that translate it, and `ConversationController` has the commands. These are the intended differences:

- **Draft.** The mounted Solus draft is the `Thread` route with a `draft` parameter, not `NewTaskDraftScreen`. `src/solus/DraftWorkspaceControls.tsx` shows T3's workspace controls there (current checkout or new worktree, repositories, branch), and each control writes the start of the run in `ConversationController`. `NewTaskWorkspaceIcon` is exported for it. Before this, a Solus draft had no control for a new worktree.
- **Codebase of a draft.** The draft heading opens T3's project picker. Solus adds a searchable Codebases section from its scoped codebases store. A row uses the current host when it has a folder, or opens a menu of folders on other hosts. A container row opens the root folder. A saved draft keeps an explicit choice in its project stamp. A folder in one codebase gives the draft that codebase by default. A folder in more than one also shows a Codebase control. "No codebase" goes to the host with each prompt (`noCodebase`, `docs/plans/codebases.md` decision 13).
- **A codebase that forms by itself.** The host gives a session with no codebase the one codebase that holds its project folder, or makes one when a second project is attached to the session. `ConversationController` gives the run the codebase of the `session_codebase` event, so the next prompt names it. The thread feed of the phone shows no divider for a `codebase_formed` activity: T3's feed has no line for a move into a worktree, so there is no pattern to follow, and `TranscriptModel` does not keep the activity. "Delete" in the menu of the codebase on the project page is the way back.
- **Repositories of a new worktree.** `useWorktreeRepositoryChoices` reads the members of the draft's codebase (`codebaseFolders.members`), not `project.trackedFolders` and `filesystemEnvironment.listFolders`. A draft with no codebase is in one project: it has one checkout and no repositories control. `resolveWorktreeRepositories` replaces `resolveWorktreeRepositorySelection`: the default limit counts the working repository, as the host's `planTaskFolder` does. The checklist shows a submodule and a repository with no commit as rows that cannot be chosen, with "Submodule" or "No commit" below the name. The `NewTaskRepositories` route takes `environmentId` and `threadId` for a Solus draft, as `NewTaskBranch` does, and both flows share one list component.
- **Base branch of a plain folder.** T3 Code has no base branch field for a project folder that is not a repository. The run sends the base `HEAD`: no repository has a branch with that name, so each one starts from its default branch. The control shows "Default branches".
- **`ThreadRepositoryRows`.** Its props are `threadRef`, `controller`, and `onOpen`. A row is one session folder at its own path. It does not read `filesystemEnvironment`, the T3 session scopes, or the checkpoint scopes of the thread, and it has no `taskFolder`, `projectId`, `reachesTracked`, or `explainsEmpty` props. The rows still go through T3's `threadRepositorySections`, with its fold after four rows. A row reads the branch and the changed files of its folder with no line totals, and its description then has no `+` and `−` counts. The detail of a row shows the mark of the folder (Worktree, Attached, Created, Not attached) when it has no pull request number.
- **Other repositories.** In a task folder, the list is the host's `sessionWorktreeCandidates`, and a pick calls `sessionAddRepositoryWorktree`. In each other session with a codebase, the list is the `git` members that are not rows, and a pick is T3's pin, kept in memory only (`thread-repository-pins.ts`, unchanged). A session with no codebase has no such row. The line below "Other repositories…" is "Add a worktree" or "Show in this thread".
- **Git sheets.** `GitOverviewSheet`, `GitCommitSheet`, and `GitConfirmSheet` read `repositoryCwd` and `repositoryName` through `useCheckoutGitTarget`. The overview of the thread shows `ThreadRepositoryRows`, and a row opens the same sheet for that repository. The Git calls of a repository sheet use the context of the folder (`sessionFolderContext`): the working directory is the folder, and the session id stays the thread's. The sheet of a repository has no "Review changes", "Choose branch", or "Branches & worktrees" row, and it adds "Track with Git" for a folder with no repository, "Attach" for a folder that the agent was not given, and "Detach" for an attached folder. A pinned repository that is not a session folder shows "Not a folder of this thread" and has no Git action.
- **Linked folder.** The overview of a thread whose working directory stands in for a plain folder in a task folder (`taskFolderOf`, `primaryIsWorktree` false) shows the section "Linked folder" with one line: "An edit here changes the original file."
- **Review.** `useCheckoutReviewSections` reads the patch of each repository with `repositoryPath` and joins them with T3's `reviewTurnDiffText`, so `ReviewSheet`, `reviewModel`, `useReviewDiffData`, and `reviewFileVisibility` need no change. The repository groups are the repositories that have changes in the section. The change summary of the session (`sessionTree`) orders and names them. Each repository counts its own turn snapshots, so the turns join by `traceId`, and the number of a turn over several repositories is its place in the joined list.
- **Unchanged T3 files with no Solus use.** `use-selected-thread-git-state.ts` and `use-selected-thread-git-actions.ts` serve only the unmounted `GitBranchesSheet` export. `projectThreadStartTurn.ts` and `threadOutboxDelivery.ts` build the T3 start command, which a Solus session does not send: the first prompt of the run carries `codebaseId` and `worktreeRepositories`.
- **Question card.** The attach card of the host is a normal question, so T3's pending input card shows it. `src/solus/pending-question.ts` has the translation. In T3 Code, typed words take the place of a chosen option. A Solus answer is the chosen option, then ` — `, then the typed words (`formatAnswer`): the attach card reads the words as the name of the codebase that the attach makes. So `pending-question.ts` has the draft rules of a Solus question (`toggleQuestionOption`, `typeQuestionRemark`), and `PendingUserInputCard` reads `isQuestionOptionSelected`: a chosen option stays chosen while the answer field has words, and a second tap on it takes the choice back. The card has no other change.
- **Model picker.** For a session in a task folder, the picker gets the project folder of the session record, because the path of a task folder names no project.

`vite.config.ts` sets `server.fs.deny` without Vite's default `**/.git/**` entry. A Solus worktree is in `<repository>/.git/solus/worktrees`, and with the default each test of the `react` project fails before it starts.

The Sessions settings page (`SolusSessionSettings` in `src/solus/Settings.tsx`) shows **Default worker model** and **Fallback model** as lists of choice rows, in the same form as its Default agent and Default permissions sections. T3 Code keeps a fallback model (`fallbackModelSelection`) for each project in its server settings, and the T3 mobile app has no control for it. In Solus the two models are personal settings that follow the person to each host, so they are on the personal Sessions page and not on a project page. A tap saves the model at its default reasoning level; desktop and web also choose the level. The rows come from `solus-core/features/settings/worker-model-choices.ts`.

The started-session card follows the model row in T3 Code revision `58b7878eb750d3e1f80b9a0a42b8802efba2adda`. It shows the provider icon, model display name, and reported reasoning effort. Solus supplies the child session's settings from live dispatch and saved tool history.

A tap anywhere on a started-session card opens the child thread. It uses the thread inspector when available. A linked host without a direct connection opens through the parent host in read-only mode.

The Add machine card (`add_host`, question kind `host-link`; `docs/plans/add-machine-card.md`) keeps T3 Code's link request card in `src/features/threads/LinkRequestCard.tsx`: the card with its reason and Decline, the machine sheet with the ranked rows and "Another address…", and the step rail for a code. These are the intended differences:

- The card shows above the composer with the other request cards (`RequestPanels`), as the secret card does, not at a `link_request` row in the feed. A Solus session has no `link_request` item, so `ThreadFeed` has no branch for it. The composer is hidden while the card is open.
- The rows come from `rankAddMachineCandidates`: the hosts this phone knows (not the session host), the SSH targets of the session host (`hostsListSshConfigHosts`), and the servers that the last nearby scan found. Each row names its way. The sheet has no access picker: the session host pairs as its owner.
- Add calls the session host's own RPCs: `hostsAddOverSsh` (with a password field when SSH refuses the key, and `host.sshProgress` on the card), `hostsPair` with a check code that the card shows with a countdown, or `hostsPair` with a code that this phone makes on the target (`connectionsGeneratePairToken`) or that the person types. A typed code is checked with `classifyPairSecret` before it is sent. A refusal shows its message and keeps the card open. On success the card answers with `respondQuestion` and the outcome only. The logic is in `solus-core/features/conversation/lib/add-machine-card.ts`.
- T3's Connect device approval (`ConnectDeviceApprovalCoordinator`, `connectDeviceApproval.ts`) shows Solus approval requests: `solus.pairApprovals` (`solus-core/features/settings/pair-approvals.ts`) watches each connected host where this phone holds `host.local.reach`. The alert adds **Review**, which opens the host's page. The host's page (`SolusHostDetail`) shows the pairing code and the open requests (`src/solus/HostAccessSection.tsx`). Its `pairCode: "new"` parameter makes a code when the page opens; the card's "Show a code on <name>" link uses it.
- The host's page also has **Use Solus in other apps** and **Connected apps** (`src/solus/OutsideAppsSection.tsx`, plans/035 §10). T3 Code's mobile app has no such flow; its web and desktop app has one (`apps/web/src/components/mcp/UseInAnotherAppDialog.tsx`, `mcpGate.ts`, `mcpApps.ts`), and the phone follows its steps in a `Sheet` (`src/solus/OutsideAppConnectSheet.tsx`). The section shows to each person who uses the host (its owner, or a member of its organization; `showsOutsideApps` in `solus-core/features/settings/outside-app-setup.ts`): the app that their pairing code approves acts as them. **Connect an app** opens the sheet. Before the steps, a gate (`outsideAppGate` in `solus-core/features/settings/outside-app-gate.ts`) reads the public MCP address (`connectionsAppEndpoint`), the registration and tunnel (`uplinkStatus`, which `HostCloudLink` now reads for each person who uses the host), and the host's test of its own connection (`hostSelfTest`). It shows checking, not registered, tunnel off, or offline with the reason and **Check again**. The phone is never the host machine and `uplinkLink` needs `host.local.reach`, so for a tunnel that is off it says where to turn it on (Settings → Account on that computer) and has no Turn on button. When the gate is open, the steps are App, Access, and Connect. **App** lists each guide of `OUTSIDE_APP_GUIDES` with `needsPublicUrl`, so a new cloud app shows by itself, and **Something else…**. Apps that run on a computer (Cursor, Claude Code, Codex, and the others) are set up from Solus on that computer. **Access** is Read, Read and write (the default), or Full, with the effects from `docs/outside-apps.md`. **Connect** has the one action (open the app's add page with the address filled in; or copy the address or a message and then open the app, with the app's own link first and its web page when that link does not open; a toast says what was copied and keeps the web page within reach), the address with Copy, the guide's note, and the code block: "Code to approve {level}", **Get code** (`connectionsCreateAppPairingCode` with the chosen access, only on tap), the code with "Expires m:ss · one use", then "The code expired." and **New code**. **Set up another way** shows the address, the message, the steps, the note, and the app's help link; for **Something else…** it says "Add a remote MCP server with OAuth." and "Apps that require their own client ID cannot connect." Connected apps show to the owner only: they are the paired devices with `app`; each shows the app's name from `OUTSIDE_APP_NAMES` beside its label, its access, "Last connected {time} ago" from `lastSeenAt` (or "Not connected yet" while it is still the time of the approval), and **Revoke** (`connectionsRevokeDevice`). **Revoke all apps** asks for a confirmation, then revokes each app with the same operation. An app's in-app approval request uses the approval flow above.
- Settings has **Sharing & access** in its Connections group (`SettingsSharingAccess`, `src/solus/SharingAccessSettings.tsx`). T3 Code's mobile app has no such page; its desktop and web Settings has one, where Authorized clients has the header button "Use in another app (MCP)" and lists the connected apps with the devices and the pairing links. The phone page has a host list with the connected hosts (`sharingAccessHosts` in `solus-core/features/settings/sharing-access.ts`). It opens on the host whose page links to it, else the one host that Settings is scoped to, else the first host. A host that is no longer connected is skipped (`sharingAccessHost`). For the chosen host it shows the same components as the host's page: `HostAccessSection` (the pairing code and the approval requests; it also loads the host's access answer) and `OutsideAppsSection` (Use Solus in other apps and Connected apps), so an organization member sees what the host page shows them. The phone shows no list of paired devices, because the host page has none. The host's page keeps its sections and links to Sharing & access for that host. Settings search finds the page by MCP, other apps, connected apps, connector, approve a sign-in, and pairing code.
- An outside app's sign-in is also approved on the phone (plans/035 §0.5). T3 Code's mobile app has no such flow. When the person chooses Approve in Solus on the app's sign-in page, the page shows a check code and a QR code of `solus://approve-app?host=<installation id>&request=<request id>`. The phone camera opens the link in the app. React Navigation does not route it (the `filter` and `getInitialURL` of `appLinking` in `src/App.tsx` skip it, so a cold start restores the workspace). `AppSignInCoordinator` (`src/solus/AppSignInSheet.tsx`, mounted beside `ConnectDeviceApprovalCoordinator`) reads the link and shows one `Sheet` over the current screen. `solus.appSignIns` (`solus-core/features/settings/app-sign-in.ts`) finds the host whose installation id the link names (the host's own answer, else the saved entry, else the registry id). It waits while the host list and the directory are still loading, and then says "This sign-in is for a host this phone is not connected to." It reads the sign-in with `connectionsReadAppSignIn({ requestId })`. The sheet shows the app's name, "Access goes to {place}", a note when the app is on the computer that opened the page, the access with its effect, the time left, "Only approve a sign-in you just started.", **Deny**, and **Approve** (`connectionsDecideAppSignIn`). Approve is off once the sign-in expired. A refused decision keeps the sign-in open with the reason. After a decision the sheet says "Approved. Go back to {app}." **Approve a sign-in** on Use Solus in other apps opens the same sheet with a field for the check code (`normalizeCheckCode`, then `connectionsReadAppSignIn({ checkCode })`). A newer sign-in replaces the one on screen, and a late reply for the earlier one is dropped. The sign-in page names the `solus` scheme only, so the camera opens only the production build. A development or preview build also accepts the link in its own scheme (`solus-dev://approve-app?…`, `solus-preview://approve-app?…`) when it is opened by hand, and the check code works in every build. The in-app QR scanner of Add Environment does not read this link.
- The SSH step takes a key. On an SSH config alias, a line shows "Key: from ~/.ssh/config" with **Use another key…**, which shows the Identity file field. The row **Another machine over SSH…** has a **Target** field and an **Identity file (optional)** field. The agent's `sshTarget` selects the alias with that name, else this row with the target filled in; its `identityFile` fills the field. **Browse** lists the files of the session host from `~/.ssh/` with T3's folder browsing (`IdentityFileField` in `src/solus/`). When SSH refuses a key that other users can read (`key-permissions`), the card shows **Fix permissions**: the card sends the same add again with `fixIdentityFilePermissions`, and the session host fixes the key (chmod 600) before it adds. A missing key ("No file at …") shows below the Identity file field.

The machine card of a cloud machine tool (question kind `cloud-machine`, plans/035-cloud-machine-tools.md §6) uses the same parts as the Add machine card: the card in `RequestPanels` with its reason, Decline, and "Waiting for an editor", and a `Sheet` with Settings choice rows (`src/features/threads/CloudMachineCard.tsx`). It has three modes: create (organization, name, size, packages, setup script), edit (packages and setup script, with a restart warning for a machine that runs), and join (organization). The ask holds every value that the card shows, so the phone makes no account call. The card only answers with `respondQuestion`; the host tool makes the change. The logic is in `solus-core/features/conversation/lib/cloud-machine-card.ts`.

T3 Code has no way to add a machine over SSH. The Add environment screen (`ConnectionsNewRouteScreen`) adds the row **Add over SSH** below the "Or enter it" group (`src/solus/AddOverSsh.tsx`, `use-add-over-ssh.ts`). The row shows only when a connected host gives this phone `host.local.reach`. It opens a `Sheet` with **Run from** (those hosts, the last connected first), **Target**, **Identity file (optional)** with **Browse**, and **Link to my Solus account** while the phone is signed in (the account issues the link ticket). Add calls `hostsAddOverSsh` on the Run from host and shows its `host.sshProgress` steps. A refused key asks for a password or passphrase, which goes only into the next add. `key-permissions` shows **Fix permissions**. A linked machine makes the phone read the account's directory again; a forwarded machine makes it read the forwards of the Run from host. A new route for a saved host shows no row.

Sync settings (`docs/plans/settings-sync-hosts.md`) adds rows that T3 Code does not have, with T3's `ListToggleRow` (`src/solus/SyncSettingsRows.tsx`). T3 copies nothing at pairing; it writes a change of a shared server setting to each selected environment. These are the intended differences:

- The pairing screen (`ConnectionsNewRouteScreen`) has a **Sync settings** row above T3 Connect, and the Add machine sheet has one above **Add**. Both are on by default and hidden while signed in. A new route for a saved host shows none.
- The environment page (`SettingsEnvironmentDetailRouteScreen`) has a **Settings** section with the host's **Sync settings** switch, below **Connection**.
- T3's Settings environment picker is unchanged. When it shows one environment, the personal settings on screen are that host's copy (`settings-environment-filter.tsx`); otherwise they are the home host's.

The native voice recorder stays with the draft that started it when the user opens another session. Solus cancels its draft operation if that draft is discarded or its session is archived. A chat table’s native context menu copies the table as HTML and tab-separated text. Dragging a file pill to Finder or File Explorer is a desktop shell action. Mobile uses its existing file actions.

Queued message edits use T3's queue sheet, composer, and model picker. Solus
loads the queued message's saved options and submits explicit picks with the
message's revision. A text-only edit keeps the host's saved choice. Runtime mode
stays with the session.

T3's Linked environments section and batch link sheet are not used. A person's
machines reach each other with no step (`docs/plans/host-reach.md`): the phone
introduces the hosts it owns, and it follows each machine a host pairs. The
linked session sheet uses the Solus Cloud copy when available and the source
host's read-only transcript pages for paired machines or remote child sessions.
Connect uses a separate device pairing through a known machine where possible
and the existing add-environment form when a code is needed.

An organization policy can turn off "Save sessions to Solus Cloud"
(`sessions.limits.sessionCloudSync: false`). The account directory gives that
answer to the phone (`AccountSession.savesSessionsToCloud`). The machines are
then the one source of the organization's sessions: the session list has no
row from the organization's Solus API (`CloudSessions`), and the linked session
sheet does not read a cloud copy. With no machine to read from, the sheet shows
"Solus Cloud has no copy of this session. It is stored only on the machine that
ran it." in T3's failure card. No T3 file is changed for this. T3 Code has no
such policy.

The environment page of a host that this phone owns (`canReadPairings`) adds the
read-only section "Machines it reaches" below the pairing code. It lists each
machine once: the host's pairings with their health, then its introductions
(`reachedMachines` of `@solus/client-core/reached-machines`). `HostReach`
(`solus-core/features/hosts/host-reach.ts`) reads the introductions again on
`host.listChanged` and on each accepted connection, and does not show a read from
an earlier server session. T3 Code has no such section.

T3's Nearby hosts list on Add environment keeps its tap to connect one host. A
"Select" control in its header changes the rows to checkboxes, in the style of the
removed T3 batch link sheet, with "Select all" and "Add N hosts". Add sends one
approval request to each selected host, all with one check code that the list
shows with a "Stop" button (`AddSeveral` in `src/solus/add-several.ts`,
`SolusApp.pairByApproval`). An added host leaves the selection; a host that
fails stays selected with its error. Leaving the screen stops the requests.

The Solus account page (Settings → "Solus account & sync") adds a "Solus Cloud
address" control below the sign-in row (`src/solus/CloudAddressSetting.tsx`). While
signed out, the row "Use a different Solus Cloud address" opens a field for the
address of a control plane that an organization hosts itself, with "Save" and "Use
app.solus.sh". While signed in, the page shows the address and says to sign out to
change it. The address is kept in device storage, and a sign-in kept for one address
is not used at another (`plans/034-one-cloud-machine-kind.md` §7,
`docs/solus-cloud-address.md`). T3 Code has no account and no such control.

The conversation feed uses T3's subagent rows and groups from revision `a7a6126a7d9b364c0fbef3f7fe1a087c4b004393` for provider agents and sessions started from the conversation. The Solus adapter supplies agent status, reports, and local or linked child thread targets. Provider-managed transcripts are available from the Agents sheet.

The conversation adapter passes the recorded sender of each delivered prompt to the T3 feed. Agent follow-ups and scheduled runs use the upstream folded rows. Text-only pull request and resource watch notices use the upstream monitor activity in live and saved conversations. Notices with attachments keep their message row so the attachments can be opened.

Claude follow-up calls use the collapsed T3 work log checked at `c6df984916017c3e0bc4423b23be57f91433f299`. The host uses the provider task ID to associate resumed work with the original agent. A call with an unlinked text report or child transcript keeps that output in its disclosure. Calls with interactive host resources keep their resource card.

A provider agent with a native tool call ID opens its transcript from the conversation row, using the same screen as the Agents sheet. The row shows the provider name when the host omits the model and includes the model when supplied.
