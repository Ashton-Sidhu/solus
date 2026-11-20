# MCP F2 handoff: resource watches

Phase F2 of `mcp-first-class.md` (§11.5; the as-built part is §11.6). Branch
`solus/dab54623`, from `main` at `5bb58455a`. Nothing was pushed. No pull
request was opened.

## Commits

- `a72f437eb` feat(mcp): watch MCP resources and start the agent again on a change.
- `c80056ddf` feat(conversation): show resource watches in the session's background work.
- `82a844f51` feat(mobile): show resource watches above the thread composer.
- The commit that adds this file and the docs.

## What the SDK gave, and what F2 wrote

SDK `@modelcontextprotocol/client` 2.4.0:

- `client.listen(filter, options)` opens a `subscriptions/listen` stream on a
  2026-07-28 connection. It resolves on the server's
  `notifications/subscriptions/acknowledged` with the `honoredFilter`. A
  change on the stream goes to the client's `setNotificationHandler`
  registrations. The handle has `close()` (it aborts the stream and sends
  `notifications/cancelled` for the listen id) and `closed` (`local`,
  `graceful`, or `remote`; a closed client settles it as `remote`).
- `client.subscribeResource()` and `unsubscribeResource()` send
  `resources/subscribe` and `resources/unsubscribe`.
- **There is no fallback between them.** `listen()` throws
  `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` on a 2025 connection, and
  `subscribeResource()` throws the same on a 2026-07-28 connection (the method
  is not in that revision's codec). On a legacy connection the server sends
  `notifications/resources/updated` unsolicited, on the standalone stream,
  and it reaches the same handler.
- The client drops its `resources/read` cache entry of a URI when that URI's
  update arrives, so the read after a change is fresh.

What F2 wrote:

- `integrations/resource-subscriptions.ts`: `openResourceSubscription`
  chooses by the era, refuses a watch whose URI the server did not honor, and
  gives one `ResourceSubscription` shape (`ended`, `close({ unsubscribe })`).
  The interfaces `ResourceWatchCalls`, `WatchRequest`, `UpstreamAddress`.
- `TaskAwareClient.connectionEnded` (in `mcp-task-requests.ts`): a legacy
  subscription has no stream, so it ends with the connection.

## Host

- **Gateway** (`gateway.ts`): `useResourceWatches`, `resourceWatches`, and
  `subscribeResource`. G's `withTaskSession` is now `withBackgroundSession`
  and takes an optional `starter`, so only the agent's own call can start a
  command. Each client gets one handler for `notifications/resources/updated`.
  `holdsUpstream` counts live watches too, so a watched session is not closed
  when idle and not evicted by the stdio limit. `UpstreamSession.client` is
  typed as `TaskAwareClient`.
- **Owner** `integrations/resource-watches.ts` (`ResourceWatches`): the open,
  the open again with a back-off, the gather of changes, the wait for a busy
  turn, the drop after Stop, the delivery, the limits, the stop, the deletion,
  the archive, and the restart. One delivery or reopen timer and one expiry
  timer for each live watch; none when there is none.
- **Store** `integrations/resource-watch-store.ts` over the host table
  `integration_resource_watch`.
- **Tool** `watch_integration_resource` (`server`, `uri`, `watching`) in
  `integrations/resource-tools.ts`. It joins a run when one of the run's
  servers that listed in time declares `resources` and `resources.subscribe`
  (`integrationToolbox`). Deferred, no approval, like the two read tools. It
  takes the listed name of the resource for the row when the list has it.
- **Delivery**: `promptSession(sessionId, text, 'queue', { via:
  'resource-watch', imageAttachmentRefs })`. The text: the header
  `A watched MCP resource changed: <server> · <name>`, one line that says why
  the agent starts and asks it not to change the resource itself unless the
  user asked, the limit line on the last start, then the frame sentence and
  the contents read now as the person and mapped by `agentResultOf` (A3, with
  its limits). Images go to the session's attachment store. A failed read
  gives the reason and names `read_integration_resource`.
- **Wiring** (`boot-server.ts`): the owner, `integration.resourceWatchChanged`,
  the handlers (`transport/handlers/resource-watch-handlers.ts`),
  `sessionRuntime.on('session-status')`, `onSessionRecordDeleted` (new, in
  `data/sessions/session-records.ts`; `deleteHostRowsOfSession` also deletes
  the session's watch rows), `onSessionViewChanged` (archive), `start()` at
  boot, `stop()` before the gateway closes.
- **Contracts** `contracts/src/integrations/resource-watch.ts`;
  `integrationResourceWatchList`, `integrationResourceWatchStop` in `rpc.ts`,
  `rpc-planes.ts` (`execution`), `host-api.ts`, `permissions.ts`
  (`read.transcript`; `drive.prompt`), `access-policy.ts` (the session field);
  the event in `host-events.ts` and `event-audience.ts` (readers of the session
  only); `PromptVia` gains `'resource-watch'`. The desktop preload passes every
  method through, so it needed no change.

Both providers get the tool and the later start: the tool is a Solus agent
tool (Claude through `createSdkMcpServer`, Codex through `dynamicTools`; the
test lists it through both adapters), and the start is a queued prompt, which
is the same for both.

**Tool schema size.** `agent-tool-schema-size` measures the Solus tool list,
which F2 does not change: 113,624 bytes on this branch (budget 107,583; it
fails on `main` too). The watch tool is per run, like the read tools: a run
with a server that sends changes gets 601 bytes more (the three resource tools
are 939 bytes without it, 1,540 with it, the same for both providers).

## Migration

`packages/server/drizzle/sqlite/0011_integration_resource_watches.sql` (journal
tag `0011_integration_resource_watches`, with `meta/0011_snapshot.json`; after
the merge of `main` at `09f769306`, which folded the migrations into one
baseline, it is `0001_integration_resource_watches` with the same SQL, see
`mcp-visual-pass-handoff.md`), made
with `drizzle-kit generate --config drizzle.sqlite.config.ts --name
integration_resource_watches`, as `0008` to `0010` were. SQLite only;
`drizzle-kit generate` for Postgres reports no change.

## Limits

| Limit | Value | Where |
|---|---|---|
| Live watches of one session | 10 | `MAX_LIVE_WATCHES_PER_SESSION` |
| Live watches of one person on a host | 20 | `MAX_LIVE_WATCHES_PER_PERSON` |
| Live watches on a host | 100 | `MAX_LIVE_WATCHES_ON_HOST` |
| Changes that become one start | those in 5 s after the first | `RESOURCE_WATCH_GATHER_MS` |
| Least time between two starts of one watch | 30 s | `RESOURCE_WATCH_MIN_WAKE_INTERVAL_MS` |
| Starts of one watch | 20; the last says so and ends the watch | `MAX_RESOURCE_WATCH_WAKES` |
| Lifetime | 24 h | `RESOURCE_WATCH_LIFETIME_MS` |
| Open again after a stream ends | 1 s, then 5 s doubling to 5 min | `RESOURCE_WATCH_REOPEN_*` |
| Opens after a restart | one each 500 ms, after 1 s | `RESOURCE_WATCH_BOOT_STAGGER_MS` |
| Ended rows in the list | 24 h, pruned at boot | `RESOURCE_WATCH_HISTORY_MS` |
| One subscription or read request | 30 s | `REQUEST_TIMEOUT_MS` |
| Row message | one line, 200 characters | `oneLine` |
| Contents | the A3 limits | `agentResultOf` |

The same resource twice in one session is one watch. Busy session (a turn
runs or waits for a person, `isSessionBusyStatus`): the change waits and starts
the agent once after the turn ends. Stopped turn (`interrupted`): a change that
waited is dropped, and the row says so; the watch stays. Deleted session: the
stream closes and tells the server, the timers go, nothing is sent. Archived
session: the watches of the person who archived it end. The person stops a
watch at every state from its row; the agent stops it with `watching: false`.

## The rule for a stdio server

The plan says a live watch keeps a command from the idle stop (§7.3), and the
B1 handoff has no other rule. F2 keeps that, bounded: the watch lives at most
24 hours, so it cannot keep a process for ever. A live watch also keeps the
process from the eviction of the 16-process limit. When the process stops
(Stop in Settings, an end by itself, `failed`, a change of the record, a host
stop), the watch ends with `server-stopped`; a watch never starts a command
again. Only the agent's own call starts a command for a watch.

## A restart

At boot the owner reads each live row. A watch of a server at a URL opens
again (one each 500 ms) and shows `starting` until it opens; nothing is sent
for the time the host was down, and a change after the open starts the agent
as before. A watch of a command server ends with `host-restarted` ("The host
restarted and the server stopped."). An expired row ends with `expired`; a row
of a removed server ends with `removed`.

## States

| State | Row | Glyph |
|---|---|---|
| Starting (also after a dropped stream or a restart) | "Starting the watch…" | spinner |
| Watching | "Watching for changes", then "· started the agent N times" | still eye |
| Changed, the agent starts | "Changed · the agent starts soon" | spinner |
| Changed during a turn | "The agent starts after the running turn." | spinner |
| A change during a stopped turn | "A change came while the turn was stopped, so the agent did not start." | still eye |
| Needs sign-in | "Sign in to <server> again"; the connect card shows once | alert |
| Server not reachable | "Could not reach <server>" | alert |
| Stopped by the person / by the agent | "Stopped" / "Stopped by the agent" | stopped |
| Ended by the limit / after its lifetime | "Ended: started the agent 20 times, its limit" / "Ended after 24 hours" | done |
| Host restarted / the command stopped / refused / removed | the reason | failed |
| Session archived | "Ended: the session was archived" | stopped |
| Session deleted | no row | — |

A second client reads `integrationResourceWatchList` and follows the same
event; after a reconnect each client reads the list again before a row shows.
A reconnect never starts the agent: only the host delivers, and a reopened
stream sends no change by itself (tested).

## Clients

- **Shared**: `client-core/resource-watch-row.ts` (`resourceWatchItem`,
  `shownResourceWatches`, `RESOURCE_WATCH_STOP`). `BackgroundItem` gains the
  state `waiting`. A watch row has no clock (`startedAt: null`): it can stay
  for a day, and a ticking clock would repaint for nothing.
- **Desktop and web**: `contexts/sessions/resource-watches.store.svelte.ts`
  (as `mcp-tasks.store`), `ResourceWatchRows.svelte` (it ensures the store and
  takes the session, the host, and the turn's start), mounted in
  `ConversationTurn.svelte` right after `McpTaskRows`; `BackgroundItemRow`
  draws `waiting` with the Lucide `Eye`. `ResourceWatchNoticeRow.svelte` for
  the change (plain text, never markdown); `host-notice.ts` knows it by `via`
  or by its first line. A live watch does not hold `background` and does not
  hide the generic background row.
- **Mobile**: `use-resource-watches.ts`, `ThreadResourceWatches.tsx` above the
  composer, right after `ThreadMcpTasks`. The row is the MCP task row itself:
  `McpTaskRow` in `ThreadMcpTasks.tsx` is now the exported
  `BackgroundItemRow`, with the SF Symbol `eye` for `waiting`. The notice is in
  `ThreadHostNotice.tsx` (`icon="eye"`, plain body), and `isHostNotice` knows
  it.

### Each new element and the existing one it follows

| New element | Follows |
|---|---|
| Watch row (desktop, web) | the MCP task row: the same `BackgroundItemRow`, unchanged markup |
| Stop and "Stopping…" | the MCP task's Cancel: the same ghost `xs` button |
| `waiting` glyph | the other `ActivityRow` glyphs: a Lucide icon at the activity size, no tone |
| Watch row (mobile) | the MCP task row: the same component |
| Notice (desktop, web) | `McpTaskNoticeRow.svelte` on `HostNoticeRow` |
| Notice (mobile) | the MCP task notice in `ThreadHostNotice.tsx` |

F2 adds no dialog, so no outline border to remove.

## Contradictions between the plan and the code (corrected in the plan)

In `mcp-first-class.md`: §1 items 38 and 39, and the new §11.6.

1. The plan named the person column `person_key`; it is `user_id` (the
   data-model rule). The table needs more columns than the plan listed
   (`name`, `status`, `end_reason`, `status_message`, `wakes`,
   `last_wake_at`, `updated_at`).
2. The plan's message says "Read it with read_integration_resource". The F2
   brief asked for the contents, mapped with the result limits. The message
   gives them; the read tool is named only when the read fails.
3. The plan says a legacy server uses `resources/subscribe` "through the SDK".
   The SDK has no fallback; Solus chooses by the era.
4. `integrationResourceWatchStop({ id })` takes `sessionId` too: the access
   policy locates the session from the arguments, as for `mcpTaskCancel`.
5. "Archived" is a person's own view state, not a state of the session. A
   watch ends when its own person archives the session.
6. "Four at one time" after a restart is one each 500 ms; a command's watch,
   which the plan did not cover, ends.
7. Data had no way to tell another owner that a session was deleted. G's
   owner finds a row gone at its next poll; a watch has no poll, so F2 adds
   `onSessionRecordDeleted` in `data/sessions/session-records.ts`. It imports
   nothing new; `server-module-boundaries` has no new failure.
8. G's `withTaskSession` was renamed `withBackgroundSession` (§12.6 notes it).
9. The plan had no limit for a person, the host, the starts of one watch, the
   gather, or the reopen; F2 adds them (table above).

## Screenshots

From a temporary Vite harness in the scratchpad (not committed, deleted after
the captures), as G made its own: it mounts the real `ToolGroupItem.svelte`,
`BackgroundItemRow.svelte` (fed by the real `mcpTaskItem` and
`resourceWatchItem`), and `ResourceWatchNoticeRow.svelte`, 760 px wide, at 2×,
in the Solus browser. The Vite server was stopped by its own PID. Files in
`/Users/sidhu/solus-screenshots/mcp/12-resource-watches/`:

- `01-states-light.png`, `02-states-dark.png`: an MCP task row, then the watch
  row in each state of the table above.
- `03-tool-card-light.png`, `04-tool-card-dark.png`: the agent's tool card with
  `watch_integration_resource` open, its reply, and the live watch row under
  the MCP task row.
- `05-stop-pressed-light.png`, `06-stop-pressed-dark.png`: Stop pressed; the
  button says "Stopping…" and is disabled until the host's event.
- `07-change-starts-agent-light.png`, `08-change-starts-agent-dark.png`: the
  "Resource watch" notice of a change, the agent's reply in the new turn, and
  the row "started the agent once".
- `09-change-starts-agent-open-light.png`,
  `10-change-starts-agent-open-dark.png`: the same notice open on the message,
  as plain text.

## Tests and checks

- `tests/unit/integrations/resource-watches.test.ts` (new, 15 tests, a fake
  clock, a fake 2026-07-28 server over HTTP with `subscriptions/listen`, and a
  legacy server of the v1 SDK; no wait for a time): a change starts the agent
  exactly once, with the contents as data; five fast changes make one start,
  and the next waits 30 s; a change during a turn starts it once after the
  turn, and a stopped turn does not; the limit of 20 starts ends the watch and
  the last message says so; the limits of a session and a person; the
  lifetime; the person's Stop and the agent's `watching: false` end the
  stream and send `notifications/cancelled`; a deleted session leaves no
  stream and no timer; an archive ends only its person's watches; a dropped
  stream opens again and the reconnect starts nothing; a restart opens a URL
  watch and ends a command watch, and sends nothing; a connection that needs
  sign-in moves the watch to `needs-sign-in`, asks once, and recovers; a
  server that does not honor the URI refuses the watch; a legacy server gets
  `resources/subscribe` and `resources/unsubscribe`; both providers list the
  tool, only for a server that sends changes. Ran four times: 15/0 each.
- `tests/unit/resource-watch-row.test.ts` (new, 4): the row in each state and
  the notice read back with no origin.
- `bun test tests/unit/integrations/` and the related files (rows, turn
  harness, data-model baseline, `rpc-planes`, the mobile feed, cards, and
  resource tests, the `@` menu): 437 pass, 0 fail.
- Failures that are also on `main`, the same assertions:
  `agent-tool-schema-size` (113,624 against 107,583; the Solus tool list is not
  changed here), `startup-import-graph` (web 4,872,424, desktop 4,987,850; the
  watch UI is not on the first screen, a dynamic import did not move the
  number), `access-policy` (`sessionRepositoryBundleChunk`),
  `native-mobile-integrations` (one label), `server-module-boundaries` (the
  three `host/` imports), `data-model-identity` (2).
- Type checks, `main` → this branch, compared by message: server 134 → 134,
  workspace-ui 40 → 40, client-core 2 → 2, contracts 0 → 0, mobile 0 → 0.
  `svelte-check`: 312 errors and 18 warnings, none in a changed file.
- `lint:surfaces` clean. `lint:layout` fails only on `RunOnPicker.svelte` and
  `EditorVoiceControl.svelte`, which F2 did not change. `lint:mobile-compiler`:
  no finding in F2's files after their three entries were recorded (the
  baseline is stale elsewhere, as G found).
- `oxlint` on the new files: clean. The two `no-unknown-parameters` errors in
  `mcp-task-requests.ts` are G's.
- `drizzle-kit generate`: SQLite gave `0011`; Postgres no change.

## Not done or not verified

- **Mobile was not run**: it needs a native build. Its changes pass `tsc`, the
  compiler coverage, and the unit tests only. No mobile screenshot.
- **Desktop (Electron) and the real web client were not run**; only the
  harness. The store, the event, and the reconnect path of the clients have
  no component test (the conversation-turn harness stubs the row).
- **No real provider turn ran**, and no real MCP server that sends changes:
  the fake servers follow the 2026-07-28 text and the v1 SDK. The start path
  (`promptSession` with `via: 'resource-watch'`) is wired and type-checks; no
  test drives a provider through it. The `session-status` and the archive
  wiring in `boot-server.ts` are not covered by a test; the owner's methods
  they call are.
- A stdio watch was not run against the fake stdio server. The restart rule
  is tested at the owner with a record of kind `stdio`; the end when a
  running process stops (`server-stopped`) and the hold against the idle stop
  are not tested.
- The session record view (`session/record/RecordTranscript.svelte`) shows the
  change as a person's bubble; it does the same for an MCP task. Not changed.
- A header that expires while a long HTTP stream stays open is not read again
  until the stream ends or another use of the session retires it.
- The `@` menu and the + menu have no way for the person to start a watch;
  only the agent starts one, as §11.5 says.
- Windows was not tried.
