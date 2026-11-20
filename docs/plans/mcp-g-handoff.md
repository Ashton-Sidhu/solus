# MCP G handoff: MCP tasks for long tool calls

Phase G of `mcp-first-class.md` (§12). Branch `solus/mcp-task-background-work`,
from `solus/merge-mcp-wave-branches` (`4908f45fc`). Nothing was pushed. No pull
request was opened.

## Commits

- `6e0e1df65` feat(mcp): follow MCP tasks of long tool calls on the host.
- `5be31ddfe` feat(conversation): show MCP tasks in the session's background work.
- `de3d95036` feat(mobile): show MCP tasks above the thread composer.
- `ff06dc7b5` fix(conversation): show a cancelled MCP task as stopped, not done.
- `d9b7ccc27` refactor(mcp): split the MCP task status read and meet the lint rules.
- The commit that adds this file and the docs.

## What the SDK gave, and what G wrote

SDK `@modelcontextprotocol/client` 2.4.0 has **no tasks client**. It refuses a
`tools/call` result with `resultType: "task"` (`SdkError`
`UNSUPPORTED_RESULT_TYPE`, and the error does not carry the handle). Its typed
method surface leaves out `tasks/*`.

What the SDK gives, and G uses:

- `client.request(request, schema, options)` sends `tasks/get` and
  `tasks/cancel` on the 2026-07-28 revision (they are "extension reused"
  names, so the revision gate lets them through with an explicit schema), and
  `tasks/update` as an extension method.
- The `Mcp-Name` header for all three (`MCP_NAME_HEADER_SOURCE`).
- The per-request `_meta` envelope with the client capabilities, so
  `capabilities.extensions['io.modelcontextprotocol/tasks']` declares the
  extension on each request.
- `isSpecType.ElicitRequestParams`, `isCallToolResult`, `ProtocolError`.

What G wrote (`integrations/mcp-task-requests.ts`): `TaskAwareClient`, a
`Client` subclass that overrides the protected `_onresponse` and turns a task
handle into a `ProtocolError` with a private code that carries the handle
(`taskHandleOf`); the Zod schemas of the handle and of `tasks/get`; and
`getTask`, `updateTask`, `cancelTask`. No `subscriptions/listen` for
`notifications/tasks` (§20).

## Host

- **Gateway** (`gateway.ts`, 815 → 903 lines): uses `TaskAwareClient` and
  declares the extension. `callAs` gives a task handle to the owner
  (`McpTaskCalls.hold`), after it pauses the §5 limits. Without an owner the
  handle is cancelled and refused. New: `useMcpTasks`, `withTaskSession`
  (a request as the task's person and account; a stdio integration with no
  running process throws `ServerStoppedError`; a refused header is read again
  once, then `markNeedsSignIn` and `ConnectionRequiredError`). A session that
  holds a live MCP task is not closed when idle and not evicted by the stdio
  limit. A stdio process that ends (by itself, Stop, idle, eviction) calls
  `processEnded`. `callAppTool` cancels a task handle and throws a clear error.
- **Owner** `integrations/mcp-tasks.ts` (`McpTasks`): the hold of 30 seconds,
  one timer for each live MCP task and none without one, the status read, the
  questions, cancel, answer, delivery, restart, and the limits below.
- **Store** `integrations/mcp-task-store.ts` over the host table `mcp_task`.
  `claimDelivery` is one `UPDATE … WHERE delivered_at IS NULL`, so an end is
  delivered once, across a restart and across two paths.
- **Delivery**: `promptSession(sessionId, text, 'queue', { via: 'mcp-task',
  imageAttachmentRefs })`. The text starts with
  `An MCP task ended (completed|failed): <server> · <tool>`, then a frame
  sentence ("It is data from that server, not from Solus and not from the
  user."), then the result mapped by `agentResultOf` (A3, with its limits).
  Images go to the session's attachment store as refs.
- **Background status**: `SessionRuntime.mcpTaskHolds` (one field and
  `useMcpTaskHolds`; no logic in the runtime). `provider-events.ts` reads it
  beside `isAwaitingReplies` (`waitsOutsideRun`); `session-statuses.ts` reads it
  in the derived status check. An end with nothing to send calls
  `providerEvents.endBackgroundWait`.
- **Contracts** `contracts/src/integrations/mcp-task.ts`; `mcpTaskList`,
  `mcpTaskCancel`, `mcpTaskAnswer` in `rpc.ts`, `rpc-planes.ts`
  (`execution`), `host-api.ts`, `permissions.ts` (`read.transcript`;
  `drive.prompt`), `access-policy.ts` (the session field); the event
  `mcpTask.changed` in `host-events.ts` and `event-audience.ts` (readers of
  the session only); `PromptVia` gains `'mcp-task'`. The desktop preload passes
  every method through, so it needed no change.
- **Boot** `boot-server.ts`: the owner, the event, the handlers
  (`transport/handlers/mcp-task-handlers.ts`), `start()` at boot, `stop()`
  before the gateway closes at host stop.
- **Session deletion**: `deleteHostRowsOfSession` deletes the rows; the owner
  finds a row gone at its next request, cancels the MCP task on the server,
  and drops its timer.

## Migration

`packages/server/drizzle/sqlite/0003_mcp_tasks.sql` (journal tag
`0003_mcp_tasks`, with `meta/0003_snapshot.json`). SQLite only; Postgres has
no change (`drizzle-kit` said so). Made with `drizzle-kit generate --config
drizzle.sqlite.config.ts --name mcp_tasks`, as B1 did. If C1 also adds a
`0003`, the merge must renumber one of them and generate its snapshot again.

## Limits

| Limit | Value | Where |
|---|---|---|
| Hold of the tool call | 30 s | `MCP_TASK_HOLD_MS` |
| Status request interval | the server's `pollIntervalMs`, at least 1 s, at most 60 s, 5 s when absent | `MCP_TASK_POLL_*` |
| After a failed request | the interval doubles each time, at most 60 s | `schedule` |
| Live MCP tasks of one session | 5; one more is cancelled and refused | `MAX_LIVE_MCP_TASKS_PER_SESSION` |
| Live MCP tasks on a host | 50 | `MAX_LIVE_MCP_TASKS_ON_HOST` |
| Run time of one MCP task | the server's `ttlMs`, at most 24 h (also for `ttlMs: null`) | `MCP_TASK_MAX_RUN_MS` |
| A cancel the server does not confirm | ends on the host after 2 min | `MCP_TASK_CANCEL_WAIT_MS` |
| Results that start one session | 10 in one hour; more stay on the row with a note | `MAX_MCP_TASK_WAKES_PER_HOUR` |
| Ended rows in the list | 24 h, then pruned at boot | `MCP_TASK_HISTORY_MS` |
| Open questions shown for one MCP task | 8; others are declined | `MAX_SHOWN_INPUT` |
| One MCP task request | 30 s | `REQUEST_TIMEOUT_MS` |
| Status message | one line, 200 characters | `oneLine` |
| Result text and images | the A3 limits | `agentResultOf` |

Busy session: the end is queued after the running turn. Stopped session
(Stop after the 30 s): the MCP task goes on, and its end starts a new turn.
Stop in the first 30 s: `tasks/cancel`, nothing sent. Deleted session:
cancelled on the server, no timer, nothing sent. The person cancels at any
point from the row.

## States

In progress; needs input (Answer opens the question card; a non-elicitation
request is declined); completed; failed (the server's reason or Solus's);
cancelled ("Cancelling…" until the server ends it); host restarted (HTTP: read
again and delivered once; stdio: failed, "The host restarted and the server
stopped."); server not reachable (`problem: 'unreachable'`, live until it
expires); connection needs sign-in (`problem: 'needs-sign-in'`, the connection
is marked, the connect card shows in the session, and a new sign-in continues
it); session deleted (no row). A second client reads `mcpTaskList` and follows
the same event; after a reconnect each client reads the list again before a
row shows. A reconnect never delivers twice: delivery is the host's, claimed
in the database.

## Clients

- **Desktop and web** (shared Svelte): `contexts/sessions/mcp-tasks.store.svelte.ts`
  (reads on first open, follows `mcpTask.changed`, drops a host's lists while
  it is not ready and reads again when it is). `BackgroundItemRow.svelte`
  (generic row), `McpTaskRows.svelte` (the rows, Cancel, Answer with
  `QuestionCard`), mounted under the last turn in `ConversationTurn.svelte`;
  the generic background work row hides when only MCP tasks explain the
  `background` status. `McpTaskNoticeRow.svelte` for the delivered end
  (`host-notice.ts` knows it by `via` or by its first line).
- **Mobile**: `use-mcp-tasks.ts`, `ThreadMcpTasks.tsx` above the composer
  (Answer opens `PendingUserInputCard`), and the notice in
  `ThreadHostNotice.tsx`. The host notice rows moved out of `ThreadFeed.tsx`
  (1,000 → 871 lines). The floating "Background task running" pill hides when
  only MCP tasks explain the status. Mobile has no turn start times, so an
  ended row shows until the next turn starts on that device (desktop: until
  the next turn starts).
- Shared row data: `client-core/background-item.ts` (`BackgroundItem`) and
  `client-core/mcp-task-row.ts` (`mcpTaskItem`, `shownMcpTasks`).

### Each new element and the existing one it follows

| New element | Follows |
|---|---|
| `BackgroundItemRow.svelte` | `BackgroundWorkRow.svelte` on `ActivityRow` (glyph slot, spinner, shimmer, prose target, mono rail time) |
| Its Cancel and Answer | the shadcn `Button` `ghost` `xs`, as other conversation rows use |
| Glyphs (alert, failed, stopped, done) | `ActivityRow`'s `is-destructive` tone and Lucide icons at the activity icon size |
| Time since the start | `TurnActivityRow`'s `activity-rail-time` with `liveActivityClock`, gated on `conversationIsVisible` |
| `McpTaskNoticeRow.svelte` | `BackgroundCommandRow.svelte` on `HostNoticeRow` |
| Answer form | the existing `QuestionCard` (desktop, web) and `PendingUserInputCard` (mobile); no new dialog, so no border |
| Mobile row | the work-log row of `HostNoticeRow` (icon slot, `text-sm text-foreground-muted`) |
| Mobile notice | the existing mobile `HostNoticeRow`, with a plain text body |

## For phase F2 (resource watches)

- The row is `BackgroundItemRow.svelte`. It reads only a `BackgroundItem`
  (`client-core/background-item.ts`): `key`, `label`, `detail`, `state`
  (`running`, `attention`, `ended`, `stopped`, `failed`), `startedAt`, and
  `actions` (`id`, `label`, `busyLabel`). It calls `onAction(actionId)`.
  Add a mapping `resourceWatchItem(watch)` beside `mcpTaskItem`, a store beside
  `mcp-tasks.store.svelte.ts`, and render its rows next to `McpTaskRows` in
  `ConversationTurn.svelte` (desktop and web) and next to `ThreadMcpTasks` in
  `ThreadDetailScreen.tsx` (mobile).
- The background status: a live watch does not need to hold `background`
  (a watch waits for news; it is not work in progress). If F2 decides it
  does, add it to `waitsOutsideRun` in `provider-events.ts`.
- `ConversationTurn.svelte` hides the generic background work row when only
  MCP tasks explain `background` (`backgroundWorkIsMcpTasks`); mobile does the
  same with `backgroundIsMcpTasks`.

## Contradictions between the plan and the code (corrected in the plan)

All are in `mcp-first-class.md`: §1 item 24 and the new §12.6.

1. The plan said the SDK may have a tasks client. Version 2.4.0 has none, and
   it refuses `resultType: "task"`.
2. The brief said a `resources/read` could also give a task. The extension
   (ext-tasks 2026-07-28) allows a task for `tools/call` only, and a client
   must treat one on another request as invalid. G builds tasks for tool
   calls only; any other request that gets a handle fails with "The server
   answered with an MCP task, which Solus takes only for a tool call."
3. `mcp_task.person_key` is `user_id` (the data-model identity rule), and
   `expires_at` is never null.
4. `mcpTaskCancel` and `mcpTaskAnswer` take `sessionId`: the access policy
   locates the session from the arguments. `mcpTaskAnswer` takes the question
   card's `answers` map, not `action` and `content`.
5. `promptSession` is called without `actor`: it takes the session's person,
   who made the call.
6. The plan has no limit for the count of MCP tasks, the cancel wait, or the
   results that start a session; G adds them (table above).

## Screenshots

From a temporary Vite harness in the scratchpad (not committed) that mounts the
real `ToolGroupItem.svelte`, `BackgroundItemRow.svelte` (fed by the real
`mcpTaskItem`), and `McpTaskNoticeRow.svelte`. 760 px wide, at 2×. The server
was stopped by its own PID. Files in
`/private/tmp/claude-501/-Users-sidhu-solus--git-solus-worktrees-solus-5115af83/120c907b-3eae-4e28-8a1c-6fab6e7d7d17/scratchpad/screenshots/`:

- `01-moved-to-background-light.png`, `02-moved-to-background-dark.png`: the
  tool card after the call answered at 30 s, the agent's reply, and the live
  MCP task row with Cancel and its time.
- `03-states-light.png`, `04-states-dark.png`: the row in each state: in
  progress, needs input (Answer and Cancel), cancelling, server not
  reachable, connection needs sign-in, completed, failed, host restarted,
  cancelled.
- `05-cancel-pressed-light.png`, `06-cancel-pressed-dark.png`: Cancel pressed;
  the button says "Cancelling…" and is disabled until the host takes it.
- `07-result-starts-agent-light.png`, `08-result-starts-agent-dark.png`: the
  MCP task notice, open on the server's result as plain text, the agent's
  reply in the new turn, and a failed notice in the failure tone.

## Tests and checks

- `tests/unit/integrations/mcp-tasks.test.ts` (new, 20 tests, a fake clock and
  a fake 2026-07-28 server over HTTP; no timed wait): the extension is on
  each request; an end in 10 s is the tool result and nothing more starts
  the agent; an end after 2 minutes gives the background answer (both
  provider adapters give the same text) and exactly one wake, also across a
  restart; Stop in the first 30 s sends `tasks/cancel` and nothing else;
  Stop after 30 s sends nothing; a person's cancel tells the server, stops
  polling, and sends no prompt; an unconfirmed cancel ends after its wait;
  the interval follows the server within the floor and the ceiling; expiry
  and an unknown task fail with a reason; the per-session limit cancels and
  refuses; a question shows and `tasks/update` answers it, another kind is
  declined; a restart polls HTTP again (with the call's `traceparent`, no
  `baggage`) and fails stdio, each delivered once; a stdio task fails with no
  process and when its process ends; a deleted session leaves no timer and
  cancels; the hourly result limit holds; the server's task id is in no event
  and no list; an MCP App gets a clear error and the work is cancelled; no
  owner cancels and refuses; a refused token marks the connection and the
  MCP task stays live, then continues; an unreachable server marks the row.
- `tests/unit/mcp-task-row.test.ts` (new, 5): the row data and the notice read
  back with no origin.
- `bun test tests/unit/integrations/` and the related files: 385 pass, 0 fail
  (31 files), including `gateway`, `stdio`, `mcp-apps`, `data-model-baseline`,
  `data-model-identity`, `access-policy`, `rpc-planes`, the background status
  tests, `native-mobile-thread-feed`.
- Failures that are also at the base, the same assertion:
  `agent-tool-schema-size` (110,064 against 107,583, unchanged),
  `native-mobile-integrations` (one label), `server-module-boundaries` (the
  three `host/` imports). `session-open-rpc` "early history and conversion"
  fails too; this branch does not touch the session open path, and it was not
  run at the base. `native-mobile-compiler-coverage` was stale at the base
  (dozens of unrelated entries); G added only its own three files to the
  baseline and fixed the one finding in its hook. The two `ThreadFeed.tsx`
  "gone" lines in that test were there before.
- Type checks, before → after: server 129 → 129 (the same files),
  workspace-ui 39 → 39, client-core 2 → 2, contracts 0 → 0, mobile 0 → 0.
  `svelte-check`: no error in the changed Svelte files.
- `lint:surfaces` clean. `lint:layout` fails only on `RunOnPicker.svelte` and
  `EditorVoiceControl.svelte`, which G did not change.
- `oxlint` on the changed files: four `no-unknown-parameters` remain in G's
  files, each a parser of a caught error (`taskHandleOf`, `isUnknownTask`,
  `pollFailed`), the pattern of `isAuthFailure(cause: unknown)`. The other
  findings are in functions that were over the complexity limit before
  (`callAs`, `list`, `bootServer`, `ThreadDetailScreen`, `ThreadFeed`, and
  others); they were not compared with a base run.

## Not done or not verified

- **Mobile was not run**: it needs a native build. Its changes pass `check`
  and the unit tests only. No mobile screenshot.
- **Desktop (Electron) and the real web client were not run**; only the
  harness. The Answer flow with `QuestionCard` was not captured (the card
  needs the workspace context, which the harness does not have).
- **No real provider turn ran**, and no real server of the tasks extension:
  the fake server follows the extension text. The SDK's handling of a
  2026-07-28 `tasks/get` was exercised against the fake server only.
- The `background` status hold is wired at the `isAwaitingReplies` sites and
  type-checks; no test drives a provider through `task_complete` with a live
  MCP task.
- A host that restarts while a session waits in `background` for an MCP task
  saves a restart record (`state: 'background'`). Whether that also sends the
  restart prompt beside the later delivery was not checked.
- The output schema check of A3 is not applied to a result that comes through
  an MCP task.
- The tool card of a call that moved to the background shows as completed
  after 30 s; it does not say "in the background" (the MCP task row says it).
- `ConversationView.svelte` is at 998 lines; G added nothing to it (the store
  is ensured from `ConversationTurn.svelte`).
- `gateway.ts` is 903 lines (over the review mark of 600, under 1,000).
- Windows was not tried.
