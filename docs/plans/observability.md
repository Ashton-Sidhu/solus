# Observability

**Goal:** record what agents and Solus itself actually do — turn time, tool time, wait
time, prompts, tokens, and cost — as queryable spans in a local metrics database, and
optionally export the same data live to a user-owned OpenTelemetry collector. Users make
data-driven workflow decisions from their real session history; maintainers investigate
Solus's own internals through the same pipe.

**Status: WP1-WP4 implemented; WP5 planned.** The foundation
(`src/main/observability/`), the session emitter, the query engine (field
registry, per-kind views, QuerySpec compiler, guarded SQL executor, NL→SQL
compile, saved queries, `metrics*` RPC methods), and the Insights UI
(`src/renderer/components/insights/`) are landed; the OTel exporter is not. GPT Sol (Codex, `gpt-5.6-sol`) audited
this plan read-only twice on 2026-08-09: first the Codex-provider assumptions (eight
corrections, folded into WP2 as **[codex-audit]**), then the full document including
the call stack flow (31 findings — corrected anchors, the `setup` child span, the
dimension-snapshot rule, permission/queue/dispatch threading gaps, and the
both-providers exit-ordering hazard — folded throughout).

## Vocabulary (locked — do not invent synonyms)

- **Span** — one timed unit of work: `spanId`, `parentSpanId`, `traceId`, `kind`,
  `name`, `service`, `startedAt`, `endedAt`, `durationMs`, `status`
  (`ok | error | interrupted | unknown`), `attrs` (flat JSON of strings, numbers,
  booleans). The only fact the module stores. Matches the OTel span deliberately.
- **Kind** — the span's type: `turn`, `setup`, `tool_call`,
  `permission_wait`, `queue_wait`, `rate_limit_wait`, `background_task`, `agent_run`, and the
  `internal.*` namespace (`internal.rpc`, `internal.indexer_sweep`,
  `internal.worktree_op`, …). Registered constants, never free strings.
- **Service** — which subsystem owns the span: `solus.sessions`,
  `solus.text-generation`, `solus.review-guide`, `solus.subagents`,
  `solus.automations`, `solus.indexer`, `solus.rpc`, `solus.git`,
  `solus.insights` (the NL→SQL compile agent). Registered constants. Every span has
  exactly one.
- **Trace** — one turn (or one internal operation) and all its child spans, sharing a
  `traceId`. Each turn is bounded and carries `sessionId`; session views group root
  turns by `sessionId` and order them by `(startedAt, spanId)`. Child spans record
  only observed intervals. Children may overlap, so rollups use interval unions.
- **Facade** — the single write API (`src/main/observability/`). Everything records
  through it; it dual-writes to the metrics store and, when configured, OTLP. Nothing
  outside the facade knows about tables or exporters.
- **Emitter** — code that calls the facade for one domain. The *session emitter* (turn
  traces) is the first; app emitters (RPC, indexer, git, automations) follow.
- **QuerySpec** — the serializable query contract: table-less (always `spans`),
  `timeRange`, `filters` (columns or `attrs` JSON paths), `groupBy` (columns or time
  buckets), `aggregates` (`count | avg | min | max | sum | p50 | p95`), `orderBy`,
  `limit`. What the builder edits and the engine compiles to SQL.
- **Field registry** — the registered catalog of queryable fields per kind: name, type
  (`string | number | boolean | duration`), a one-line description, and the storage
  mapping (promoted column or `attrs` JSON path). Single source of truth for the
  per-kind views, the NL agent's schema prompt, and editor completion and hover docs.
- **View** — a read-only SQL view over `spans`, generated from the field registry.
  Exactly three exist — the **two-table query model** plus the internal slice:
  `turns` (one row per turn, carrying its per-kind child-time sums), `events` (one
  row per non-internal, non-turn span; `kind` says what it was), and
  `internal_events` (`internal.*` kinds). Views lift
  registry attrs into typed columns via `json_extract`, so SQL authors and the NL
  agent never write JSON paths for cataloged fields. The stable SQL contract: an attr
  can be promoted to a real column later without breaking a saved query. Do not
  reintroduce per-kind views (`tool_calls`, `thinking_spans`, …); a kind is a filter,
  not a table.
- **Preset** — a QuerySpec shipped in code, shown as a one-click card. Not a DB row.
- **Saved query** — a user-authored query persisted in `solus.db`, storing either a
  QuerySpec (builder-editable) or SQL text (editor-editable). Each row records which
  form owns it; SQL does not round-trip into the builder.
- **Insights** — the renderer surface (`src/renderer/components/insights/`). Peer of
  Git/Run/Tasks/Works/Automations in the project panel.
- **Declared grain** — the registry view one query read, stated by the server on the
  result (`MetricsQueryResult.sourceView`) when exactly one view is identifiable.
  An ambiguous query (a join of two views, or raw `spans`) declares none. The
  client picks a result shape from the declared grain; it never overrides it.
- **Result shape** — how the console renders one result. Exactly four:
  **turn listing** (turn-grained rows: histogram brush, rich list, detail
  panel, waterfall), **event listing** (span-grained rows from one non-turn view: a
  time/duration scatter, a stat strip, a formatted table whose rows link into
  their turn's waterfall), **trend** (a time column plus one numeric series,
  drawn as a line above the grid), and **rollup** (the plain grid). Do not coin
  "chart view", "detail table", or "drill-down mode" for these.
- **Lane** — one row of the trace waterfall standing for a **run**: consecutive
  sibling spans of one kind under one parent. A lane draws all its members and
  opens to list them; it is never a summary that hides a span from the plot, and
  it never pools two runs the turn ran at different times. Do not coin "bucket",
  "band", or "collapsed group" for it.
- **Internals toggle** — the Insights setting that reveals `internal.*` kinds and the
  Solus-health presets. Affects authoring surfaces only, never query execution.
- **Rollover** — retention pruning of `metrics.db`, default 30 days
  (`metricsRetentionDays` server setting).

Do **not** coin "metric event", "telemetry record", "measurement", or "log-metric" for
spans. Do not call the Insights surface "analytics", "dashboard", or "stats".

**Verify after every work package:** `bun run build` and the WP's focused
`bun run test:unit` targets. Do not start a dev server; read `dev.log` if one runs.

---

## Requirements (from the task)

1. Turn time per session and per model; tool-call duration.
2. Fully slice-and-diceable queries over time, tool, and arguments — e.g. "how long
   does Bash take with `bun run build` over time".
3. Saved queries and shipped common queries.
4. Works for dispatched sessions.
5. Cost and token capture.
6. Full-span turns: not just tool calls — setup, permission waits, queue waits,
   rate-limit waits, and background tasks. Uninstrumented time is derived from the
   root turn minus the union of its observed child intervals.
7. The prompt between turns, plus inter-turn idle time.
8. Solus's own metrics and logs through the same pipeline, with named services for
   internal agent-powered subsystems (text generation, review guides, subagents).
9. Separate SQLite database with configurable (default 30-day) rollover.
10. Live-only OTel export (traces, metrics, logs) to a user-configured collector.
    No backfill on enable.
11. Insights hides internals by default; one toggle reveals them.

## Architecture

```text
emitters (session, rpc, indexer, git, automations, ephemeral agent runs)
  → facade (src/main/observability/) — spans + active-span context for log correlation
      ├─→ metrics store  (metrics.db, spans table, rollover)      — always
      └─→ OTel exporter  (OTLP traces/metrics/logs, per-service resources) — when configured
query: builder/presets → QuerySpec → compiler → parameterized SQL ┐
       SQL editor / NL agent → guarded SQL text                   ┴→ read-only executor
  → spans + per-kind views → RPC handlers (observability-handlers.ts)
  → Insights UI (desktop/web; mobile read-only)
```

### Call stack flow

Where each hook sits in the real call chain. Anchors verified by the second Codex
audit (2026-08-09); they drift — re-verify at WP start.

**A — Prompt dispatch → turn span opens.** Origins reach the ControlPlane two ways —
over RPC, or in-process via installed callbacks. Only the interactive prompt passes
through `SolusServer.handle`:

```text
RPC:        renderer → workspace.apiFor(tabId) → transport
            → SolusServer.handle                server/server.ts:24
            → session-handlers.ts:209
            → ControlPlane.submitPrompt         control-plane.ts:1325
in-process: create_session tool → callback      server/index.ts:222 → createSession :1555
            prompt_session tool → session-tools.ts:575
                              → callback        server/index.ts:236 → promptSession :1436
            automations → dispatchers installed server/index.ts:215-218
                              → startAutomationSession :1611 / dispatchAutomationRun :1372
→ ControlPlane.runTurn                          control-plane.ts:1216
    also reached by retry (:2415 → :2450); accepted steering returns from
    _steerActiveTurn (:1241) and stays inside the active turn — no new span;
    queue drain BYPASSES runTurn and calls _startRunLifecycle directly (:2842)
→ _startRunLifecycle                            control-plane.ts:1691
    ← turn span STARTS (runStartedAt, :1692)
→ _launchRun                                    control-plane.ts:1984
    ← setup child span: git state, worktree create, task prep (:2007-2055,
      :2166-2204). activeRunRequests is not set until :2219 and options.taskId
      can be assigned during task prep (:2173-2192) — snapshot dimensions from
      the run RETURNED by _launchRun, never at lifecycle entry
→ ControlPlane.runAgent                         control-plane.ts:701  (every run, incl. ephemeral)
→ AgentRunner.run                               agent-runner.ts:64
→ ClaudeBackend.startRun                        claude-backend.ts:148 (ClaudeAgent.run :190,
                                                _runLoop :238)
  CodexBackend.startRun                         codex-backend.ts:232  (run :281, turn/start :365)
```

**B — Provider events → child spans.** Most provider activity flows through a
normalizer, but several normalized events are emitted directly by the backends — the
hook must not assume a single producer path:

```text
Claude: CLI stream-json → ClaudeAgent._runLoop  claude-backend.ts:238 (emit :245-252)
        permissions: PermissionManager          claude-permissions.ts:183-235
          → backend emit                        claude-backend.ts:129-135
Codex:  JSON-RPC notifications → onNotification codex-backend.ts:713 → CodexTurnNormalizer
        approvals are server REQUESTS, not notifications:
          onServerRequest                       codex-backend.ts:851
          → permission events emitted           codex-backend.ts:901-914, :945-956
        session_init / changed-files emitted directly  codex-backend.ts:384-389, :749-753
        dynamic tool events via dispatcher emitter     codex-backend.ts:236-243
→ backend.emit('normalized', agentSessionId, event)
→ ControlPlane._wireBackend listener            control-plane.ts:299
    drops: no agentSessionId (:303); ephemeral handles (:305)
    agentSessionId → sessionId translation      control-plane.ts:425
    ← session emitter hook: after translation. Consume rate limits from the
      ControlPlane's accepted transition (dedup/suppression at :506-526),
      not raw rate_limit events, or the emitter counts events the
      ControlPlane discards
→ ControlPlane._emit                            control-plane.ts:3127
→ server session-event consumer                 server/index.ts:325-330
```

**C — Settlement → turn span closes.**

```text
claude: resolve runPromise :261 → emit('exit') :262   (error: reject :267 → emit :268)
codex:  _resolveRun :1035 → emit('exit') :1038        (error: reject :373 → emit :374)
→ backend.on('exit')                            control-plane.ts:578 ┐ run SYNCHRONOUSLY
  backend.on('error')                           control-plane.ts:655 ┘ BEFORE the promise
    continuation, on BOTH providers. The emitter records terminal status and
    keeps buffered turn state here; it must never drop state the settlement
    write still needs.
→ handle.runPromise settles (awaited at :1736)
→ _startRunLifecycle continuation → captureSettledRun  control-plane.ts:1722
    (called :1739, :1748 — today it only records PostHog analytics)
    ← turn span closes; still-open children finalized
```

The continuation cannot see the provider exit code: `AgentRunner` keeps it in locals
surfaced only through `AgentRunResult` (agent-runner.ts:99-103, :145-152), and the
lifecycle awaits `handle.runPromise`, not `AgentRun.done`. WP2 therefore records
terminal status from the exit/error listeners (or extends `RunHandle`) — this is also
how the Codex failed-turn correction ([codex-audit] 5) gets implemented.

**D — Ephemeral run → `agent_run` span.** Ephemeral events do reach the
`_wireBackend` listener but stop at the `:305` guard and never reach session
delivery; the coarse span lives at the AgentRunner seam:

```text
TextGenerator / review agent / subagent tools
  (ControlPlane itself is the FIFTH AgentRunRequest call site, for persistent
   session runs — control-plane.ts:2236-2259 — and passes solus.sessions)
→ ControlPlane.runAgent                         control-plane.ts:701
→ AgentRunner.run                               agent-runner.ts:64  ← agent_run span opens
    run-local normalized listener :89 → request.onEvent :97; backend start :108
→ AgentRunResult (:145-165)                     ← span closes — and must ALSO close on
    synchronous startRun throw (:107-113), provider rejection, and timeout (:120-144)
```

**E — Facade → sinks.**

```text
emitter → facade span API → batched write to metrics.db (spans table)
                          → OTLP exporter queue (when configured)
logger → span context → traceId attached → dev.log + OTLP logs
```

Span context uses `AsyncLocalStorage` — concurrent sessions and ephemeral runs
preclude a global current-span variable. Logger enrichment happens before the
`dev.log` entry is built (`logger.ts:249-252`); enriching only inside `emitOtelLog`
would leave `dev.log` without `traceId`.

**F — Query read path.**

```text
Insights store (insights.store.svelte.ts) → workspace.apiFor / serverConnections.apiFor
→ metricsQuery RPC → SolusServer.handle → observability-handlers.ts
→ QuerySpec compiler → metrics.db → grouped rows → store cache → components
```

Runtime method binding from `RPC_INVOKE_METHODS` is automatic
(`ws-transport.ts:149-161`), but the typed `SolusAPI` surface in
`src/preload/index.ts:23+` is maintained by hand — WP3 adds the four methods there
too.

### Storage: `metrics.db`

A second SQLite file beside `solus.db` in `solusDir()` (`src/main/platform/paths.ts:27`),
own connection singleton and own append-only migration ladder (same pattern as
`src/main/db/index.ts` / `migrations.ts`, separate `PRAGMA user_version`,
`auto_vacuum = INCREMENTAL`). Why separate: rollover deletes never touch core data, and
the highest-volume tables stay out of `solus.db`.

One fact table — promoted columns for hot dimensions, `attrs` JSON for the long tail:

```sql
CREATE TABLE spans (
  span_id TEXT PRIMARY KEY,
  parent_span_id TEXT,
  trace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  session_id TEXT, provider TEXT, model TEXT, project_root TEXT, origin TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  status TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX spans_kind_time ON spans(kind, started_at);
CREATE INDEX spans_kind_name_time ON spans(kind, name, started_at);
CREATE INDEX spans_service_time ON spans(service, started_at);
CREATE INDEX spans_trace ON spans(trace_id);
CREATE INDEX spans_session ON spans(session_id, started_at) WHERE session_id IS NOT NULL;
```

No foreign keys to `sessions` — the indexer conditionally deletes session rows
(`src/main/db/session-indexer.ts:79-90,:393-401`), which is why `task_session_links`
has no FK from `session_id` to `sessions` either (`migrations.ts:286-296`). Model,
provider, and project are denormalized onto every span; queries never join `solus.db`.
`saved_queries` lives in **`solus.db`** (durable user config, exempt from rollover).

Rollover: prune job at boot and daily — `DELETE FROM spans WHERE started_at < cutoff`
— governed by `metricsRetentionDays` (server setting, default 30). Long-horizon history
is the user's collector's job.

### The turn trace (session emitter contract)

```text
turn (trace root; service solus.sessions)
├─ queue_wait          prompt_queued.enqueuedAt → runStartedAt (see threading note below)
├─ setup               inside _launchRun: git state, worktree create, task prep
├─ thinking            provider-reported extended-thinking boundary
├─ response_stream     first visible text chunk → last visible text chunk
├─ tool_call           name: tool name; children nested via parentToolUseId
├─ permission_wait     name: tool name; attrs.decision: granted | denied
├─ question_wait       user question shown → answer accepted
├─ context_compaction  provider-reported compaction boundaries or duration
├─ rate_limit_wait
├─ turn_settlement     provider completion → authoritative Solus settlement
└─ background_task     attrs.blocking: false — excluded from critical-path rollups
```

Turn attrs: `prompt` (capped ~4 KB, `promptTruncated` flag), `promptChars`,
`promptSource` (`typed | queued | automation | agent | dispatch`), `interTurnIdleMs`
 (previous settlement → this dispatch, same session), `reasoningEffort`, `isResume`, `taskId`,
`automationId`, `costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`toolCallCount`, `permissionDenialCount`, `hasThinking`,
`timeToFirstActivityMs`, `timeToFirstTextMs`, `timeToFirstProviderEventMs`,
`timeToLastProviderEventMs`, and `timeToProviderCompleteMs`.

Unattributed turn time is not stored as a synthetic span. Query surfaces
derive it from the turn interval minus the union of observed blocking child intervals.
The trace splits that complement at the first provider event, first activity, last
activity, provider completion, last provider event, and Solus settlement boundaries.
These segments locate missing trace coverage; they do not claim model work, idle time,
or any other cause. The waterfall renders these derived segments as neutral,
selectable rows so uncovered time does not look like chart padding. This keeps capture
factual and avoids manufacturing attributed spans from provider events.

Tool-call attrs: size-capped input fields (~8 KB, truncation-flagged),
`parentToolUseId`, `isSubagent`, provider outcome (exit code / error) where available.
For Claude, `content_block_stop` only completes the tool input; the later `tool_result`
closes the execution span. For Codex, item completion carries the execution boundary.

### Capture points (established by exploration)

- All session-persistent runs — interactive, automations, `create_session` /
  `prompt_session`, dispatched — flow through `ControlPlane._wireBackend`'s
  `normalized` listener (`control-plane.ts:299`) and settle through
  `_startRunLifecycle` / `captureSettledRun` (`control-plane.ts:1691,:1722`). The
  session emitter hooks there, plus the `exit`/`error` handlers (`:578,:655`).
- Dimensions: snapshot from the run **returned by `_launchRun`** — never at lifecycle
  entry, where `activeRunRequests` is not yet set (`:2219`) and `options.taskId` can
  still change during task prep (`:2173-2192`). The request is deleted on
  `task_complete` (`control-plane.ts:494`), so nothing may be read lazily at close.
- Provider activity events carry no common timestamp field (a few lifecycle events
  do: `turn_settled.settledAt`, `prompt_queued.enqueuedAt`, `task_complete.durationMs`
  — `shared/types.ts:1288-1313`); the emitter stamps arrival time, except where the
  provider supplies better (see [codex-audit] below).
- **`queue_wait` needs threading.** `enqueuedAt` is created at `control-plane.ts:1933`
  and stored in `QueuedRequest` (`:1970`), but queue drain passes only
  `servedQueueId` to `_startRunLifecycle` (`:2842-2848`). WP2 carries `enqueuedAt`
  beside `servedQueueId` (or keeps a queue-span map keyed by `queueId`).
- **Permission waits.** Starts already ride `normalized` (Claude
  `claude-backend.ts:129-135`; Codex `codex-backend.ts:901-914,:945-956`), but
  resolutions do not: Claude resolves locally with no `permission_resolved` event
  (`claude-permissions.ts:300-344`) and Codex deletes its pending request before
  responding (`codex-permissions.ts:33-56`). The reliable close hook is
  `ControlPlane.respondToPermission` (`control-plane.ts:2469-2492`) plus terminal
  cleanup. `RunHandle.sawPermissionRequest` alone cannot give duration or decision.
- **Dispatched sessions** record on the execution host by construction — its own
  ControlPlane runs the turn. The dispatch fact (`serverId !== taskServerId`,
  `shared/types.ts:532,:540-545`) never reaches the execution host today, and
  `SessionRunInput` alone is not enough: `runInputFromContext`
  (`run-input.ts:14-36`) builds it from a `SessionCtx` that has no dispatch field
  (`shared/types.ts:1394-1420`). WP2 threads an explicit origin through `SessionCtx`
  / `PromptOptions` end to end rather than inferring from a shipped `taskSnapshot`
  (`control-plane.ts:2277-2279`). Cross-host aggregation is the collector's job (or
  a later client-side fan-out); v1 queries the connected host.
- **`promptSource` needs a real field.** `PromptVia` supports only
  `automation | session-report` (`shared/types.ts:1334-1336`); agent-initiated
  `prompt_session` / `createSession` pass no origin marker. WP2 adds an explicit
  prompt-source field (or a derivation rule at every `runTurn` caller) — the locked
  values are not all derivable today.
- **Ephemeral runs** (`persistence: 'ephemeral'`) reach the `_wireBackend` listener
  but stop at the `:305` guard. They are captured as one coarse `agent_run` span
  each at the `AgentRunner` seam (`agent-runner.ts:89`), attributed by a new
  `AgentRunRequest.service` field. Callers: `text-generator.ts:39-54`,
  `review/review-agent.ts:59-75`, `claude/claude-subagent-tool.ts:67-94`,
  `codex/codex-subagent-tool.ts:52-78` — plus the ControlPlane itself for
  persistent runs (`control-plane.ts:2236-2259`, passes `solus.sessions`). No child
  tree. The span must close on every terminal path: result, synchronous `startRun`
  throw, provider rejection, timeout (`agent-runner.ts:107-144`).

### Codex corrections **[codex-audit]** — all owned by WP2

1. **Tool input is often absent on `tool_call`.** `codexStartedToolInput`
   (`codex-event-normalizer.ts:668`) extracts input only for command, dynamic, and
   collab items; MCP `arguments`, web-search queries, etc. are dropped despite being
   in the protocol (`generated/v2/ThreadItem.ts:68`). Pass them through.
2. **Not every `tool_call` gets `tool_call_complete`.** `subAgentActivity` completes
   through other paths; `normalizer.interrupt()` (`codex-backend.ts:392`) suppresses
   all later events. Finalizing open spans at every terminal path (settlement, exit,
   error, interrupt) is load-bearing, not defensive. Key open-tool maps by
   `session + toolId`, never bare `toolId`.
3. **Codex has per-tool outcomes** (`status`, `exitCode`, `error`, `declined` —
   `generated/v2/ThreadItem.ts:50-117`) that the normalizer flattens to text. Extend
   `tool_call_complete` in the shared contract with an outcome field and populate it
   at the agent boundary. Do not plan for `is_error = NULL` on Codex.
4. **Codex token usage exists** via normalized `usage` events
   (`codex-event-normalizer.ts:294-376`) but is **cumulative per thread** — compute
   per-turn deltas at turn boundaries, guarding missing baselines on resume and
   counter resets. `task_complete` usage stays empty (`:763`); cost is unknown for
   Codex — record null, never 0.
5. **Failed Codex turns look completed.** `finishCompletedTurn` resolves the run
   promise even on `turn.status === 'failed'` (`codex-backend.ts:1035`), and
   `captureSettledRun` trusts fulfillment (`control-plane.ts:1721`). Derive turn
   status from exit code / turn status, not promise settlement. (Also a latent
   analytics bug worth fixing in `captureSettledRun` itself.)
6. **Prefer provider timestamps.** Codex ships `startedAtMs` / `completedAtMs` /
   per-item `durationMs` (`generated/v2/ItemStartedNotification.ts:6`); the
   normalizer drops them. Pass through; Claude keeps arrival-time stamping.
7. **Record `model/rerouted`** (`generated/v2/ModelReroutedNotification.ts:6`,
   currently ignored) so the executed model is attributed, not just the requested
   one. Latch the initial model from `session_init.model`, not `runInput.model`.
8. **Ordering hazard — generalized by the second audit to BOTH providers.** Claude
   and Codex each settle the run promise and emit `exit`/`error` in the same
   synchronous stack (`claude-backend.ts:261-268`; `codex-backend.ts:1035-1038,
   :373-374`), so the exit/error listeners always run before the settlement
   continuation. Do not drop buffered turn state in those handlers before the turn
   row is written; record terminal status there (see call stack flow C).

### Query engine and RPC

One executor, two front doors. The builder and presets produce a QuerySpec, which
compiles server-side to parameterized SQL. The SQL editor and the NL agent produce
SQL text directly. Both paths run through the same guarded read-only executor over
`spans` and the per-kind views. Attribute filters/groups on uncataloged fields use
`json_extract(attrs, ?)`; percentiles use an ordered-window pass (SQLite has no
native percentile).

**Generated views — the two-table query model.** The registry generates `turns`,
`events`, and `internal_events` in `metrics.db` at boot (DROP + CREATE after
migrations, so a registry change regenerates them; legacy per-kind view names are
dropped). `turns` answers whole-turn questions without joins because each per-kind
child-time sum is already a column, computed as a correlated sum over the trace:

```sql
CREATE VIEW turns AS
SELECT span_id, trace_id, session_id, …,
       (SELECT SUM(child.duration_ms) FROM spans AS child
        WHERE child.trace_id = spans.trace_id AND child.kind = 'tool_call') AS tool_time_ms,
       … -- thinking_time_ms, streaming_time_ms, setup_time_ms,
         -- permission_wait_ms, queue_wait_ms, rate_limit_wait_ms
FROM spans WHERE kind = 'turn';

CREATE VIEW events AS
SELECT kind, name,
       CASE WHEN kind IN ('tool_call', 'permission_wait') THEN name END AS tool,
       span_id, trace_id, …, command, file_path, exit_code, …, attrs
FROM spans WHERE kind IN ('setup', 'thinking', 'response_stream', 'tool_call', …);
```

**Guarded SQL executor.** User- and agent-authored SQL runs on a dedicated
`DatabaseSync` opened read-only on `metrics.db` with `PRAGMA query_only` set. The
handler additionally enforces: exactly one statement; it must begin with `SELECT` or
`WITH`; `ATTACH` and `PRAGMA` are rejected; a hard row `LIMIT` cap is injected; a
busy timeout bounds lock waits. Because `metrics.db` is a separate file from
`solus.db` by design, the blast radius of arbitrary read-only SQL is telemetry data
only — that separation is what makes this exposure safe.

**NL → SQL.** The natural-language option compiles a user question to SQLite SQL —
an existing, deeply-trained language — never to a bespoke grammar. An ephemeral
agent run (`AgentRunner` seam, service `solus.insights`) receives the view DDL and
field-registry descriptions plus a few example queries, and returns SQL only. The
handler runs an execute-and-retry loop: generate → run against the guarded executor
→ on SQLite error, retry with the error text (bounded retries). The result lands in
the SQL editor visible, editable, runnable, and savable — not behind a curtain.

Methods (add to `RPC_INVOKE_METHODS` in `src/shared/rpc.ts`; handler module
`src/main/server/handlers/observability-handlers.ts`, wired in `server/index.ts`;
clients bind automatically via `ws-transport.ts` / the preload):

- `metricsQuery(spec)` — grouped rows from a QuerySpec.
- `metricsRunSql(sql)` — rows from guarded SQL (editor and NL paths).
- `metricsValidateSql(sql)` — `prepare()`-only on the read-only connection; returns
  the SQLite error (with `sqlite3_error_offset` position when the binding exposes
  it), guard violations, and on success the result column names. Never executes.
- `metricsCompileNl(question)` — the NL→SQL agent flow; returns the generated SQL.
- `metricsSchema()` — the field registry: views, columns, types, descriptions.
- `metricsDistinctValues(column)` — distinct values for a registered
  low-cardinality column (tool, model, provider, status, service).
- `metricsListSavedQueries()` / `metricsSaveQuery(q)` / `metricsDeleteQuery(id)`.
- `metricsSessionSummary(sessionId)` — rollup for session surfaces.
- `metricsTurnTrace(traceId)` — one turn's full span tree (waterfall).

Session summaries order root turns by `(started_at, span_id)`. A displayed turn number
is a query-time `ROW_NUMBER()` over that order; it is not persisted because retention,
restarts, and concurrent dispatches make a stored ordinal unreliable.

**Agent activity timing.** Turn traces persist provider-reported extended-thinking
boundaries as `thinking` spans. They also persist `response_stream` spans from the
first to the last top-level text chunk in each response segment. A tool transition
ends the current response segment; a new text chunk after the tool starts another.
These are observed client-side boundaries, not provider claims about internal model
compute. Both providers use the normalized question lifecycle to persist
`question_wait`. Claude's compact boundary supplies a provider duration; Codex's
compaction items can supply start and stop timestamps. Solus records
`context_compaction` only from those reported facts. Time inside the root turn that no
blocking child span covers remains derived
as **unattributed turn time**. Insights presents its complement as trace coverage and
groups the uncovered segments by their position between lifecycle boundaries. It can
include inference without an explicit thinking event, provider queueing, transport
delay, and settlement overhead, so neither the total nor a segment is presented as a
cause. Existing traces are not backfilled because they did not persist the event
boundaries.

**First-response timing.** An agentic turn can think or call tools before it emits
visible prose. Therefore, visible text is not a valid proxy for the provider's first
generated token. `time_to_first_activity_ms` measures from the turn start to the first
observed top-level thinking-start, text-chunk, tool-call, or assembled assistant-message
event. It is the responsiveness metric used by Insights. `time_to_first_text_ms`
separately measures the first visible top-level text chunk and may legitimately be near
the end of a tool-first turn. Solus does not claim provider model-TTFT because it does
not observe the provider's actual first generated token. For traces recorded before the
activity field existed, the turn detail
derives a best available first-activity value from the earliest persisted thinking,
response-stream, or tool-call span.

### Insights UI

Feature folder `src/renderer/components/insights/` with logic in `lib/` and an
`insights.store.svelte.ts` owning query state, results cache, and saved queries.
Components never call `window.solus.*` directly.

- **Default view: session namespace only.** Preset packs: turn time by model, "where
  does my time go" (duration share by child kind), cost by project, slowest tools,
  tool failure rate, build latency, automation health, and **agent spend by service**
  — the one default-view surface that names internal services, because it is the
  user's money.
- **Query builder:** kind picker, filter chips (columns + `attrs` paths), group-by /
  time-bucket, aggregates; chart + table; save. Row drill-through opens the session;
  turn rows open the waterfall (`metricsTurnTrace`).
- **SQL editor** (desktop + web): CodeMirror 6 with `@codemirror/lang-sql` (SQLite
  dialect — the only new package; `@codemirror/view/state/language/commands` are
  already dependencies). No language server process; the LSP-like experience is
  assembled from extensions:
  - *Schema completion* — the dialect's `schema` config fed from `metricsSchema()`,
    cached in the insights store. Views after `FROM`, columns after `view.` and in
    `WHERE`. Completion reads the cache synchronously — never an RPC per keystroke.
  - *Value completion* — a custom source: when the cursor is in a string literal
    compared against a registered low-cardinality column, suggest
    `metricsDistinctValues(column)` results (debounced, TTL-cached in the store).
    The same mechanism suggests observed `attrs` JSON paths per kind for the
    long tail.
  - *Diagnostics* — debounced `metricsValidateSql` mapped onto `@codemirror/lint`:
    SQLite-authoritative errors (anchored by error offset when available, else the
    statement), guard violations shown before the run button is pressed, and a
    result-column preview from the successful prepare.
  - *Hover docs* — a `hoverTooltip` extension resolving identifiers against the
    field registry (description, type, units), reusing the same one-liners the NL
    agent's prompt uses. Snippet completions cover `strftime` time buckets and the
    p95 window pattern.
  - Extension setup is pure logic in `src/renderer/components/insights/lib/`;
    schema and value caches live in `insights.store.svelte.ts`.
- **NL option:** a prompt input beside the editor; `metricsCompileNl` fills the SQL
  editor with the generated query for inspection, tweaks, execution, and saving.
- **Result shapes: the rendered grain matches the question's grain, and every
  rendered row carries a drill path back to its context.** The server declares
  the grain (`sourceView` on the result — from the single view a guarded SQL
  statement reads, or from the pinned `kind` of a compiled QuerySpec); the
  client maps it to one of the four result shapes. A turn-grained result gets
  the turn listing; a span-grained result gets the event listing whose rows
  deep-link to the turn detail panel with that span pre-selected; a time-bucketed
  aggregate gets a trend line; everything else stays the honest plain grid.
  When no grain is declared (older host, ambiguous SQL), the client falls back
  to the turn-column sniff only — a span listing without a declared grain
  renders as a grid rather than masquerading as turns. "What do these rows
  have in common" is deliberately **not** a view: the histogram's stat line
  (count, p50/p95, failure rate) covers the cheap 80% for whichever grain is on
  screen, and the NL tab answers the rest with a computed rollup. A comparison
  canvas is out of scope.
- **Solus timings require no visibility mode.** The schema and Solus-health presets
  are always available. Turn-bound Solus work appears directly in the trace:
  setup, queue and permission waits, rate-limit waits, and the measured
  `turn_settlement` interval after provider completion.
- **Surfaces:** desktop and web share the full builder. **Mobile is read-only
  presets + saved-query results in v1** — an approved platform exception; composing
  queries on a phone is not a workflow worth its cost.

### OTel export

Rework `src/main/otel.ts` from env-only into a settings-driven exporter. Settings UI
(Settings → Connections, desktop and web): enable toggle, OTLP endpoint, protocol
(http/protobuf | grpc), custom headers, signal checkboxes (traces / metrics / logs),
minimum log level, and the prompt-text opt-in. Server-side settings — works
identically for headless hosts; each host exports its own runs, so the collector is
the natural cross-host aggregation point for dispatch.

- **Live-only.** Export starts at enable time; no SQLite backfill.
- **Traces:** spans map ~1:1. Batches group by service into per-service
  `ResourceSpans` (`service.name` = e.g. `solus.text-generation`), so collectors
  show real service maps.
- **Metrics:** histograms (`solus.turn.duration`, `solus.tool_call.duration`),
  counters (cost, tokens). Attribute names follow OTel GenAI semantic conventions
  where they exist (`gen_ai.request.model`, `gen_ai.usage.input_tokens`).
  **Cardinality rule:** metric attributes are low-cardinality only (model, provider,
  tool name, origin, status) — never session ids or command strings. Argument-level
  slicing lives in spans and SQLite.
- **Logs:** every structured logger entry ships over OTLP logs (min-level filtered).
  The facade keeps an active-span context; logs written inside a span carry
  `trace_id`/`span_id`, and `dev.log` entries gain a `traceId` field
  (`jq 'select(.traceId == …)'` pulls one turn's internal timeline). The existing
  `log.metric()` bridge (`logger.ts:283` → `otel.ts:110`) folds into the facade.
- **Privacy:** exfil is off unless configured. Prompt text and tool input bodies are
  stripped from export unless the explicit "include prompt text" toggle is on. The
  existing analytics privacy rule (`shared/analytics-events.ts:1`) stays intact —
  PostHog analytics and this module remain separate concerns.

## Decisions log

- Cost: Claude measured (`task_complete.costUsd`); Codex null in span attrs —
  **mapped inside the session emitter**, since the normalized contract keeps
  `costUsd` as a required number that Codex hard-codes to 0
  (`shared/types.ts:1288`; `codex-event-normalizer.ts:763-770`). The session UI's
  result contract is untouched; "shows n/a" applies to Insights. Estimated Codex
  cost from a price table is a later, clearly-labeled option.
- Turn duration includes setup: the turn span starts at `runStartedAt`
  (`control-plane.ts:1692`) and a `setup` child owns worktree/git/task-prep time
  inside `_launchRun` — user-visible latency is never excluded from the turn.
- Child intervals may overlap (parallel or nested tools). Rollups use interval unions,
  and derive unattributed turn time from the root rather than synthetic child spans.
- Ephemeral services get one coarse `agent_run` span, not a child tree.
- Automation runs sit in the **user** namespace (users care how long their nightly
  automation takes); only scheduler plumbing is `internal.*`.
- No transcript backfill in v1; metrics start at ship time. (Phase-2 option: indexer
  extension approximating historical durations from Claude transcript timestamps.)
- **Amended 2026-08-13 — guarded read-only SQL replaces "no raw-SQL RPC escape
  hatch".** Both original premises are resolved: the executor opens a dedicated
  read-only connection (`query_only`, single `SELECT`/`WITH` statement, no
  `ATTACH`/`PRAGMA`, injected row cap, busy timeout), and SQL text is serializable
  for saved queries. Exposure is scoped to `metrics.db` only. Motivation: NL→query
  must target an existing language the model compiles reliably — SQLite SQL over
  per-kind views — not a bespoke grammar with zero training data.
- SQL does not round-trip into the chip builder; a saved query is owned by either
  the builder (QuerySpec) or the editor (SQL) and the UI shows which. Decompiling
  arbitrary SQL to QuerySpec is not worth building.
- No LSP server for the SQL editor. Completion, diagnostics, and hover are
  CodeMirror extensions over the field registry, and SQLite `prepare()` is the
  validator. Rename/go-to-definition-class features are meaningless for
  single-statement queries over half a dozen views.
- `metricsRetentionDays` default 30; prune at boot + daily.
- Mobile v1 read-only (approved exception, documented here).
- **Amended 2026-08-15 — the Insights design's tables are the field registry's,
  not its own.** The "Observability v5" design composition names `latency_ms`,
  `user_id`, a `sessions` table, and a `messages` table. Solus has none of
  those: duration is `duration_ms`, there are no users, a session rollup is
  `metricsSessionSummary` rather than a view, and metrics never store assistant
  replies. The surface was built against the real registry — session grouping is
  a client-side grouping of turn rows, and the design's "Messages" panel is a
  **Prompt** panel over the turn's `prompt` attr with a link into the
  conversation. Showing a fabricated reply beside measured spans would make the
  whole surface untrustworthy.
- **A result that is not a turn listing renders as a plain table.** The console
  runs arbitrary SQL, so most answers are rollups. The page reads a result as
  turns only when it carries `trace_id` and `started_at`; anything else gets a
  generic grid rather than being forced into a shape with no waterfall behind
  it. **Amended 2026-08-16 — superseded by the result-shape model.** Column
  sniffing alone misread a tool-call listing that happened to select `trace_id`
  as a turn listing, and it rendered span-grained questions ("how long has
  `bun run test` taken over time") as an unformatted grid of epoch numbers. The
  grain is now **declared by the server** (`sourceView`), and the client maps it
  to one of four locked result shapes (see Vocabulary and the Insights UI
  section). The old column sniff survives only as the compatibility fallback for
  results from hosts that predate `sourceView` — where a declared grain is
  present it is authoritative, including declaring that a result is *not* turns.
- **Event rows link to the span, not just the turn.** The `insights` route's
  params carry an optional `traceId`/`spanId` pair; the waterfall opens with
  that span's detail expanded. The
  drill target for "characteristics of one tool call" is the existing waterfall
  detail — input, exit code, siblings, permission wait beside it — not a new
  inspector surface. Identity columns (`span_id`, `trace_id`, `parent_span_id`)
  are link data in the event listing, carried by the query but not rendered as
  cells.
- **No comparison canvas.** Cross-turn/cross-session commonality is a computed
  claim, not a picture: the event listing's stat strip covers the cheap case,
  and the NL tab compiles the diagnostic GROUP BY for the rest. Side-by-side
  waterfall diffing is explicitly not planned.
- **The histogram is not the question.** Turn volume runs its own QuerySpec over
  the window and stays fixed while the query changes; brushing it narrows the
  list client-side. A histogram that re-ran with every question would flatten
  the shape the answer is meant to be read against. It is fixed against the
  *question*, not against *time*: a refresh — entering the page, or `opt+R` —
  re-reads the histogram and re-asks the question on screen together, because a
  chart that advanced alone shows a failed turn as a bar with no row under it.
- **One time range, two forms, and it owns only the statements Solus wrote.**
  The range (`lib/time-range.ts`) is either **relative** (`last 24 hours` — it
  keeps describing now while the page sits open) or **absolute** (two pinned
  instants — an investigation's window must not slide away from the incident).
  It resolves to one pair of epoch milliseconds that the histogram, every
  generated statement, and the NL compile instruction all read, and it persists
  in client storage.
  A relative range compiles to SQLite's own clock (`strftime('%s','now') * 1000
  - ms`) so re-running the statement later still answers "the last 24 hours"; an
  absolute range compiles to its two literals.
  Moving the range **rewrites Solus's own statements** — the explore query, the
  "query this session" query, and the preset chips, which no longer carry baked
  24-hour and 7-day windows — because a preset that kept its own window would
  answer a different question from the histogram directly above it. Those
  statements are therefore remembered by description (`GeneratedQuery`), not by
  text. It **never rewrites SQL the user typed, saved, or compiled from a
  question**: that text is theirs, and a filter that edits someone's query
  behind their back is worse than one that admits it cannot. When the range
  moves under such an answer the console says so (`answerWindowStale` — "asked
  over the previous range — run again") rather than leaving a result under a
  chart that contradicts it. An NL question is not silently re-compiled on a
  range change, because that would charge the user for an agent call they did
  not ask for.
- **The turn panel's rail is three cards — session, attributes, time — on the
  app's card surface, at the rail's own type scale.** The card, its ring, the
  uppercase group label, and the hover wash come from the task page rather than
  from a second set of sizes invented here; the scale inside them is one step
  down from a full-width page (11px labels and metadata, 12px values), because
  a 308px rail carrying page-width type reads as three oversized widgets. The
  "longest tool calls" bar is the row's own background instead of a column of
  its own: at that width a separate track leaves the tool name too narrow to
  read, and the name is the one thing the list exists to say.
- **A turn's prompt titles the page on one line, truncated.** The prompt is a
  message, not a title; the full text is the Prompt section below it. A hero
  that grows to three wrapped lines pushes the facts and the waterfall — the
  measured content — under the fold.
- **Solus timing is part of the trace, not a visibility preference.** The
  schema and health presets are always visible. Turn-bound Solus intervals use
  the same trace and waterfall axis as provider and tool spans; no checkbox can
  hide latency that contributed to the turn.
- **The relationship model is served from the registry, not written per
  surface.** A list of view names and columns cannot express the facts a
  cross-grain question needs: the views are slices of a single `spans` table,
  joined on `trace_id`. So `metricsSchema()` carries the `spans` fact table
  (`base`) and `SCHEMA_RELATIONSHIPS` alongside the views, and the console's
  schema panel, the editor's completion and hover docs, and the NL agent's
  prompt all state the same model from that one source. Documenting `spans`
  deliberately did **not** add it to `registeredViewNames()`: a raw-`spans` or
  joined query must keep declaring no grain, so the fail-safe to a plain grid
  is unchanged.
- **The schema is a sheet, not a drawer, and it writes the query it
  documents.** As a 19rem drawer under the console, a 42-column table was a
  thing to memorise rather than read, and the reader had to know which table
  held a fact before the layout could help them. The reference is now a modal
  **schema sheet** (`SchemaSheet.svelte`, `⌥S` or the console's Schema button,
  Esc to leave — `insights.close` closes it before it closes anything else).
  Two consequences follow from "reading the model and writing the query are
  one act": search spans both tables at once and each hit names its own table
  (`searchColumns`, name-before-description ranking), and a column is a control
  that writes itself into the SQL editor at the cursor
  (`SqlEditor.insertAtCursor`, switching to the SQL tab on the way). Mobile
  keeps the sheet as reference and drops the insert affordance rather than
  showing it inert: it composes nothing.
- **The sheet opens on the choice, not on a diagram or a column list.** Four
  relationship sentences over a flat 42-column list did not read as a data
  model; neither did a rail of prose cards, nor a crow's-foot ER diagram drawn
  at type sizes below the app's scale. The reader arrives with one question —
  *which table answers this* — so the sheet opens on that: the two query tables
  (`queryTables`) as cards carrying their served description and column count,
  with the `trace_id` one-to-many relationship stated once beneath them.
  Picking a table lists its columns under a sticky header repeating what the
  table is, so "should I be querying this one at all" stays answerable from
  inside the list. Columns group by the query role the registry declares per
  field (`MetricsFieldDescriptor.group`: dimensions → measures → child time →
  tool facts → timing → ids → details), so a table reads in query-building
  order; a host that serves no groups degrades to one plain list.
- **The sheet states each fact once, in the app's own type.** The served
  `relationships` prose is *not* rendered here: it repeats the two card
  descriptions, the join line, and `FACT_TABLE_NOTE`, and four paragraphs of it
  turned the opening screen into a wall. It stays served for the NL prompt,
  editor hover docs, and older clients. Everything the sheet draws uses the
  app's UI face and font scale
  (`text-[length:calc(.8125rem*var(--solus-font-scale,1))]` and the 12px step,
  `font-medium` at most, no local tracking, no monospace, no accent side
  rails): selection is a wash, and a column name earns its emphasis from weight
  rather than from a second typeface. The previous drawing bought its density
  from sizes down to 9.5px, which is what made it a diagram nobody read.
- **A view description is one clause, not a paragraph.** `turns` and `events`
  each carried a second sentence (the per-kind child-time sums; "filter by kind
  instead of looking for another table") that the sheet then printed twice —
  on the overview card and again above the column list — for a label whose job
  is to say what a row *is*. Both facts were already stated verbatim in
  `SCHEMA_RELATIONSHIPS`, which the NL prompt and every client also receive, so
  the descriptions keep the clause that identifies the grain and drop the rest.
  Where each consequence matters, the sheet already says it in place: the
  child-time group hint reads "summed per turn — no join needed", and `kind`
  lists its filter values as chips.
- **A column that enumerates its values is drawn as those values.** `kind`
  documents ten span kinds with a gloss each, which as one paragraph was the
  tallest cell in the sheet and the one nobody read — while the values are the
  whole point of the column, since a kind is a `WHERE` filter rather than a
  table. `enumeratedValues` splits a description into its lead clause and its
  values; the sheet renders the values as chips carrying the registry's gloss
  on hover. Only the registry's colon form splits (`"What happened:"`,
  `"Prompt source:"`); an `e.g.` list stays prose, because chips read as *these
  are the values* and the registry only claimed examples. `turns.cost_usd`
  ("Turn cost in USD: provider-reported for Claude, …") is the case the guard
  exists for: a colon not introducing a quoted list.
- **The advanced sources are browsable and searchable, but not part of the
  choice.** `internal_events` and `spans` sit under their own heading in the
  sheet's nav (`advancedSources`) rather than in the choice of two, and `spans`
  states its cost (`FACT_TABLE_NOTE`) in its own header. Search spans **every**
  listed source, not only the two: a search that omits half the queryable model
  sends the reader who typed the right word away with nothing.
- **Two tables, not thirteen: the user never picks a table per kind, and the
  common correlations are pre-joined.** The per-kind views (`tool_calls`,
  `thinking_spans`, `permission_waits`, …) made every question start with a
  schema lookup and every cross-kind question a hand-written join — a table
  catalog as UX. Collapsed to `turns` and `events` (plus `internal_events`
  and `spans` as the advanced fact table): a kind is a
  `WHERE kind = …` filter on `events`, not a table to discover, and `turns`
  carries its per-kind child-time sums (`tool_time_ms`, `thinking_time_ms`,
  `streaming_time_ms`, `setup_time_ms`, `permission_wait_ms`, `queue_wait_ms`,
  `rate_limit_wait_ms`, `settlement_time_ms`) as correlated-sum columns, so "tool time by model" is a
  plain `GROUP BY` on one table. The former join preset is rewritten to exactly
  that; no shipped preset joins anymore, and the NL tab remains the path for
  the rare genuinely cross-grain question. The sums are duration totals —
  overlapping children (parallel tools) sum past wall-clock by design; the
  waterfall's interval-union coverage remains the wall-clock truth. The
  deferred question "should a two-view join declare the left grain" dissolves:
  the join it existed for no longer needs writing.
- **Ids drill, names query.** A user thinks in "Nightly triage", not
  `01AUTO…`, so every id a turn carries gets its display name as a sibling
  dimension: `automation` (automation name), `task` (task title), `project`
  (folder name, matching the projects manifest's own convention), and `branch`
  (the checkout's branch). Names are **snapshotted at dispatch** — telemetry
  records what a thing was called when the turn ran, and metrics.db cannot join
  solus.db at query time anyway (separate file, ATTACH forbidden). Events
  inherit the same names from their trace root via correlated lookup, so
  slicing events by automation, task, or branch needs no join either. Ids stay
  in Links & ids as the drill path; the automation-health preset groups by
  `coalesce(automation, automation_id)` so pre-name rows still aggregate. The
  two tables stay two: merging them would make every naive aggregate
  (`count(*)`, `avg(duration_ms)`, `sum(cost_usd)`) silently mix a turn with
  its own children — the grain split is what keeps default aggregates honest.
- **Execution host is a turn dimension.** Every new turn snapshots `hostname`
  and `host_os` (`macos`, `windows`, or `linux`) from the machine that executes
  it. `turns` exposes both directly and `events` inherits both from the trace
  root, so host comparisons need no join. Existing turns are not backfilled:
  the facts were not recorded, and guessing them from the database location
  would be incorrect after metrics are exported or collected elsewhere.
- **Insights separates its panels with lift, never with page colour.** Insights
  stacks three objects — console, chart, listing — and in light mode `--card`
  *is* `--background`, so a half-pixel ring was the only thing holding them
  apart and it could not be seen. The separation comes from the card side
  alone: `--insights-card-shadow` is a ring plus a short lift, mode-specific
  because a dark page has nothing for a shadow to darken. **The page keeps
  `--background`** — recessing it to a canvas tone was tried and rejected; the
  Insights page is not allowed its own paper colour. The turn detail panel
  shares the card token, so one system covers the whole feature.
- **A dense grid earns hierarchy from its columns, not from rules.** Fifty rows
  each carrying a 7%-alpha underline is noise that does not help a reader track
  across a wide row; fifty rows in one weight and one colour is a wall of
  characters. Row rules are gone from both result grids in favour of hover, and
  emphasis comes from what a column is *for* (`columnEmphasis` in
  `lib/table-grid.ts`, sharing the existing `WIDE_COLUMNS` set): the prose or
  path a row is about reads at full weight, measures stay in the text colour,
  and the instants and ids by which a row is found again recede to muted. The
  same rule drives `ResultTable` and `EventList`, so one answer cannot be
  ranked differently from another.
- **Natural column widths are half a layout; the leftover is the other half.**
  Every result track is sized from what its column holds, which is what keeps
  header and rows aligned — but five columns whose natural sum is 54rem, in a
  120rem card, clump against the left edge and leave half the surface blank.
  `columnGrows` names which columns may take the slack: the prose and path
  columns that were truncating where the answer has any, otherwise its ids;
  never a count, an instant, a duration, or a status, which are as wide as
  their widest value and would only gain padding. Each table gives the width
  away in its own markup — a grower carries `width:100%;max-width:0`, which
  claims the remainder and stops that column's own longest value from sizing
  the table instead, and every other column is pinned to its track. Left to the
  browser the slack pools between the ids and the measures, which is how a
  truncated prompt ends up beside four columns of blank.
- **Every mark answers a question or it is decoration.** The event scatter was
  a dot cloud with no hit detection at all: the eye could find the outlier and
  then had nowhere to go with it. Hit detection is `quadtree` — nearest point
  to the cursor, not nearest x — because two observations can share a minute,
  and a point that stands for one span carries that span's drill path, so a
  click opens the same waterfall its table row does. A bucketed aggregate
  stands for many rows, so it gets the tooltip and no click.
- **A bar with no scale beside it is a shape, not a quantity.** The volume
  histogram carried no y axis at all, so a tall bar said only "taller". It now
  draws two left ticks, whose zero gridline doubles as the baseline the bars
  stand on, and the stat strip reads value-first — a strip of same-weight
  label/value pairs makes the eye read the words instead of the numbers.
- **Identical cards make a reader do the classification.** A turn's prompt,
  answer and instructions are three roles in one exchange, and printing each in
  its own card with its own heading, its own copy control and its own "Show
  more" said only that there were three of something. One card with named,
  colour-marked panes says what the reader is actually looking at, and the
  colours are not new — they are the ones the waterfall already assigns those
  kinds, so the two surfaces describe the same turn in the same language.
- **A dot is a key the reader has to learn before they can read the list.** The
  session card marked every turn with a coloured dot — accent for here, red for
  failed, grey otherwise — over a list whose rows already carried an ordinal, a
  prompt and a duration. The dot added a legend, not a fact. State now lives in
  the ink of the value it describes and in words on the hover card, and the only
  colour keys left are the ones that key a picture: the coverage bar's slices,
  cut to the shape of the bar itself rather than rounded into dots. The waterfall
  label column follows the same rule: its rows dropped their dots, because the
  bar drawn on that same line already wears the kind's hue, and the dot was
  spending the left margin the span name needs to stay whole. The disclosure
  caret moved into the gutter for the same reason — a row is pulled left by the
  caret slot and its gap, so the root name starts on the column's own edge,
  level with the expand control above it, instead of every name in the trace
  being indented past a triangle most rows do not have.
- **Coverage is the remainder, said once.** The strip printed both
  "Unattributed turn time 49%" and "51% attributed" — one measurement stated
  twice, in two directions, on one line. The attributed figure is gone. The
  remainder stays, and because it is the only entry in the key that is a
  left-over rather than a measurement, it is the only one that explains itself:
  hovering it opens a card saying it names missing trace coverage, not model
  thinking and not idle time, and listing what such an interval can hold.
- **The width a surface gets should match the question it answers.** A section
  about the whole session, in a 19rem rail, has to spend a thread and two lines
  per row to say what one wide row says plainly — and a ranked list of short
  tool names, stretched across the page, is padding. Full width for the session
  and the window strip; the rail for the attributes list, which is long and
  narrow by nature.
- **Two pictures of one interval must share an edge.** The coverage bar and the
  waterfall both draw the turn's whole duration. While the bar lived in the rail
  and the plot in the main column, at different widths, nothing linked a slice
  to the spans that made it; against the plot's own edge at the plot's own width
  the bar becomes the plot's summary line. The corollary is what did *not* move:
  the ranked tool list is a column of short labels, and a rail is the one place
  a ranked list does not have to be stretched to fill its width.
- **A dispatch step is a destination, so it is named the way the reader will
  search.** The waterfall used to prettify a step id into a phrase
  (`worktree_create` → "worktree create") and to head a folded run with its kind
  label, "Dispatch steps". Dispatch nests, so that label appeared at every level
  and told a reader nothing about which level they were on, while the phrase
  greps for nothing. A step row now reads `worktree_create · createWorktree` —
  the id verbatim, then the function it times — and a step lane names its
  members. Each step passes `fn` and `file` in its attributes, written by hand:
  the main process ships bundled, so a captured stack frame would name the
  bundle, confidently and wrongly. Line numbers are omitted because they would
  be wrong within a week. Older traces have no `fn` and keep the bare id.

## Work packages

Each WP lands green (`bun run build`, focused unit tests) before the next starts.

- **WP1 — Foundation.** `src/main/observability/`: facade, kind + service registries,
  `metrics.db` connection + migration ladder + `spans` schema, rollover job,
  `metricsRetentionDays` setting. Tests: span write/finalize, rollover boundary,
  registry rejection of unregistered kinds/services.
- **WP2 — Session emitter + provider passthrough.** ControlPlane hooks; one bounded
  trace per turn grouped by `sessionId`; natural-duration children finalized on every
  terminal path; dimension snapshot from `_launchRun`'s returned run; terminal
  status recorded in the exit/error listeners (the settlement continuation cannot
  see exit codes); `enqueuedAt` threaded through queue drain for `queue_wait`;
  permission close hook in `ControlPlane.respondToPermission` + terminal cleanup;
  prompt + inter-turn attrs with an explicit prompt-source field; dispatch origin
  threaded through `SessionCtx` / `PromptOptions` (not just `SessionRunInput`);
  `AgentRunRequest.service` on all five call sites + the `AgentRunner` hook for
  ephemeral `agent_run` spans closing on throw/reject/timeout too; the optional
  outcome field on `tool_call_complete` (optional because Claude lacks a provider
  outcome at `content_block_stop`); all eight [codex-audit] corrections. Tests:
  synthetic event streams for both providers asserting complete span trees —
  including interrupt, failure, parallel tools, queue drain, and Codex
  usage-delta cases.
- **WP3 — Query engine + RPC + saved queries.** QuerySpec compiler (with percentile
  pass, interval-union rollups, and derived unattributed time); the field
  registry and generated per-kind views; the guarded read-only SQL executor;
  the NL→SQL compile flow (`metricsCompileNl` → ephemeral agent, service
  `solus.insights`, execute-and-retry); `observability-handlers.ts`, RPC
  registration **plus the hand-maintained typed `SolusAPI` surface in
  `src/preload/index.ts`**, `saved_queries` in `solus.db` (QuerySpec or SQL, with
  owner form). Tests: compiler golden cases incl. attrs paths and time buckets;
  guard rejection cases (multi-statement, write attempts, `ATTACH`/`PRAGMA`, row-cap
  injection); view columns match the field registry; `metricsValidateSql` error and
  result-column cases.
- **WP4 — Insights UI (landed).** `src/renderer/components/insights/`:
  `insights.store.svelte.ts` (registry, distinct-value and trace caches, run
  history, saved queries, host scoping), the query console with both front
  doors, the SQL editor (CodeMirror extensions: schema/value completion, lint
  diagnostics, hover docs, snippets — adds `@codemirror/lang-sql`), the NL
  prompt input with the compiled SQL always visible and openable, the turn
  volume histogram with a time brush, the turn list with session grouping, and
  the turn detail panel with the waterfall. One route, `insights`, whose
  optional `traceId`/`spanId` params name the open turn; entry points are the
  session sidebar row and `opt+shift+I`. Every graph is LayerChart — the histogram is `Bars` +
  `BrushContext` over a band scale, and the waterfall is a ranged-bar chart
  (band scale over span rows, one linear time scale across the trace,
  `Axis placement="top"` for the ruler and its gridlines). Colour comes from the
  brand art ramp, one bar layer per span kind. Tests:
  `tests/unit/insights-turn-rows.test.ts` (result-shape detection, row mapping,
  sorting/grouping, bucketing, half-open brush selection) and
  `tests/unit/insights-waterfall.test.ts` (interval unions, tree assembly,
  orphan re-parenting, bar placement, denied permissions, value completion).
- **WP4.1 — Result shapes (landed).** The declared-grain contract and the two
  missing renderings. Server: `scanSql` additionally collects the table names
  referenced after `FROM`/`JOIN`; `runGuardedSql` declares `sourceView` when
  exactly one registered view is read, and `compileQuerySpec` declares it from
  the pinned `kind`. Client: `lib/result-shape.ts` (shape detection from the
  declared grain, event-row mapping, trend-series extraction, event stats),
  `EventList.svelte` (stat strip + scatter + formatted table, rows deep-linking
  to the waterfall), `ResultTrendChart.svelte` (LayerChart `Points`/`Spline`
  over one linear time scale, kind-coloured, failures in the status colour),
  the `insights` route's optional `spanId`, and the waterfall's
  pre-selected span. The NL prompt now tells the agent to include `span_id`,
  `trace_id`, and `started_at` on span listings so rows stay linkable. Tests:
  `tests/unit/insights-result-shape.test.ts` plus sql-guard and compiler cases
  for the declared grain.
- **WP4.2 — Time range (landed).** `lib/time-range.ts` (the range value, its
  resolution, labels, the `where` fragment, the NL instruction, and persistence
  parsing) and `TimeRangePicker.svelte` in the Insights header: the relative
  choices as a list, the custom range as two `ui/DateTimePicker` edges applied
  together, with an inverted pair refused rather than answered with an empty
  result. `insights-queries.ts` presets and generated statements became
  functions of the range; the store owns it (`range`, `windowFrom`/`windowTo`,
  `setRange`, `runGenerated`, `setUserSql`, `answerWindowStale`). The histogram
  heading names the window and its axis switches to day+clock past 24 hours.
  Mobile gets the picker too — filtering is not composing. Tests:
  `tests/unit/insights-time-range.test.ts` and the range cases in
  `tests/unit/insights-store-refresh.test.ts`.
- **WP4.3 — Turn detail panel (landed).** A turn now opens the way a pull
  request does: `TurnDetailPanel.svelte` comes out beside the list while the
  listing compresses to a 380px rail (`InsightsRail.svelte`, rows shaped by
  `lib/rail.ts`), and below 1040px — including mobile — the panel covers the
  list instead. This **replaced two surfaces with one**: the intermediate
  `TurnDrawer` overlay and the separate `insightsTurn` full-page route are
  deleted, and the `insights` route's optional `traceId`/`spanId` params name
  the open turn, so row clicks, span drills, and deep links all land in the
  same place. The rail matches the answer's grain — turn rows, or span rows
  whose items keep their `spanId` so the header's `n of N` stepper moves span
  by span. The console and histogram hide (mounted, `display:none` — the
  CodeMirror draft survives) while the panel is open; the panel header carries
  the stepper, a full-screen toggle, copy-id, and close, and Esc walks full
  screen → split → list → closed, the PRs Esc chain. Tests:
  `tests/unit/insights-rail.test.ts` and the `insights` param round-trips in
  `tests/unit/routing-codec.test.ts`.
- **WP4.3a — Breadcrumb chrome (landed).** Both Insights chrome rows now read as
  the task page's breadcrumb (`TaskChromeBar` grammar: `workspace-titlebar` so
  the band drags on mac, `h-7` crumbs at `0.8125rem`, `/` separators at
  opacity-30). The path is `Insights / <list> / <trace head>`: the page header
  owns the first two crumbs, and the turn panel continues it — repeating
  `Insights` only when full screen, where it covers the page's own band. Every
  crumb returns to the listing, so full screen has a way back that is not an
  icon. `<list>` is the answer's own word (**Turns**, **Events**, or
  **Results**), the same string the rail heads its rows with. The raw trace id
  no longer fills the band: the header prints its leading group (`shortId`) with
  the full value on the title attribute and the copy control, and status moved
  to the right of the band and shows only when it is not `ok`.
- **WP4.4 — The histogram counts the answer (landed).** The bars were turn
  volume over the range, fixed, whatever the question asked; a tool-call
  listing sat under a chart counting something else. They now count **whatever
  the answer lists** — turns for a turn listing, spans for an event listing —
  and the heading names it (`Tool calls over the last 24 hours`). Both shapes
  reduce to one `VolumePoint` (an instant, a failure flag, and the measures the
  stat line summarises), so the chart, the brush, and the stat line never learn
  which shape produced them; `TurnVolumeChart` became `VolumeChart`. The window
  stays the selected range while it contains every counted row, and falls back
  to the answer's own extent when the answer's SQL reached outside it, saying
  `in this result` rather than naming a range it does not describe. An answer
  that places nothing in time — a rollup, a failure, no rows — leaves the chart
  on turn volume as the context that answer is missing from. Consequences: the
  event listing's stat strip is **deleted**, because the histogram above now
  measures the same rows; and `Spend` is shown only when something counted
  carries a cost, since a span records none. Tests: the window and extent rules
  in `tests/unit/insights-turn-rows.test.ts`, the span mapping in
  `insights-result-shape.test.ts`.
- **WP4.5 — Column widths (landed).** A `1fr` track gives every column an equal
  share of a width nobody chose, so `select *` rendered twenty identical
  columns — a status squatting in empty space beside a truncated shell command.
  `lib/table-grid.ts` sizes a track from what the column holds (time, duration,
  status, numeric, identifier, prose, plain), fixed, shared by the event listing
  and the plain grid. Both empty states moved **outside** the horizontal
  scroller, which would otherwise centre the message on the scroll width of a
  wide result instead of on the room the reader can see. Tests:
  `tests/unit/insights-table-grid.test.ts`.
- **WP4.6 — Trace coverage (landed).** The residual formerly labelled
  "unobserved agent time" is now **unattributed turn time** and the turn fact
  reports trace coverage. `metricsTurnTrace` returns the uncovered intervals split
  into lifecycle locations: before the first provider event, before first activity,
  between activities, provider completion, turn settlement, after the last provider
  event, or unclassified on an old trace. The turn emitter stores first/last provider
  event, provider completion, and Solus settlement durations in the `turns` view.
  Claude tool spans now close on `tool_result`, not `content_block_stop`, so actual
  tool execution is no longer misreported as missing coverage. Insights groups gap
  locations with counts and durations and explicitly says that locations are not
  causes. No prescriptive recommendation system is part of this work. Tests:
  `tests/unit/metrics-rollups.test.ts`, `tests/unit/session-emitter.test.ts`,
  `tests/unit/metrics-views.test.ts`, and `tests/unit/insights-waterfall.test.ts`.
- **WP4.7 — The two-table query model (landed).** The registry stops generating
  one view per kind and generates three: `turns` (per-kind child-time sum
  columns added), `events` (all non-internal child kinds, with `kind`, `tool`,
  the promoted tool facts nullable across kinds, and `attrs`), and
  `internal_events`. `viewNameForKind` maps kinds onto those views, so the
  declared grain and the QuerySpec compiler follow without changes to the guard;
  `MetricsViewDescriptor.kind` became `kinds`. The event listing derives its
  kind label from the result itself (sole distinct `kind` value) before falling
  back to the view. Presets lost their joins; the NL prompt and editor
  completion shrank to the model a person can hold. Boot drops the legacy
  per-kind view names. Tests: `tests/unit/metrics-views.test.ts` (rollup-column
  sums, events slicing), schema-docs, sql-guard, compiler, and result-shape
  updates.
- **WP4.8 — Solus latency in the trace (landed).** Removed the inert internals
  visibility checkbox. Internal schema sources and health presets are always
  available. Provider completion to authoritative turn settlement is now a
  real `turn_settlement` child span, so it is positioned on the same waterfall
  axis as setup, agent activity, tools, and waits; it also surfaces as the
  pre-summed `turns.settlement_time_ms` field. The previous root attr was removed
  rather than keeping two representations of the same interval. Older traces
  retain their gap classification and cannot be backfilled.
- **WP4.9 — The trend reads the group-by (landed).** Two defects of the same
  root: the chart did not read the question. (1) A grouped result
  (`select day, model, sum(cost_usd) … group by day, model`) drew **one** line
  through interleaved rows, so one model's Monday joined another model's
  Tuesday — a change nobody measured. `trendChart` (was `trendSeries`) now finds
  the categorical columns the `GROUP BY` left beside the time bucket and draws
  one line per value, all breakdown columns composing one series key (splitting
  by one of two dimensions would draw through the other). `status` is never a
  dimension: failures already wear the reserved colour. One distinct value is no
  breakdown, and a legend of one entry is furniture. Series past the ramp's six
  hues are the smallest by total and are **counted on the chart**, never dropped
  in silence; the categorical order is the arrangement of the brand art ramp
  whose every adjacent pair clears the CVD and normal-vision separation floors in
  both themes (dataviz `validate_palette.js`), not a hand-picked one. A line
  needs two points in one series, so isolated dots stay a grid. (2) The
  histogram is now **absent** under a rollup or a trend rather than restating
  turn volume beside a question that never asked about turns — its brush would
  narrow nothing, and a selection made before the answer changed is cleared with
  it. An answer that lists rows but has none still keeps turn volume as the
  context it is missing from. Two edge cases found while auditing the same
  code: a bucket label is **wall-clock text, not an instant**, and `Date.parse`
  reads a date-only string as UTC and a date-time string as local — so `day`
  buckets sat under the previous evening's tick while `hour` buckets sat where
  their label said; both now read as local, and a `%Y-%W` week number
  (`2026-33`) is rejected rather than rolled forward two years by `new Date`.
  And the hue cap applies to a **line** only: a scatter connects nothing, so it
  keeps every observation unsplit rather than losing its tail. Tests:
  `tests/unit/insights-result-shape.test.ts`, which passes in five time zones.

- **WP4.10 — The reader picks the measure (landed).** A result carries several
  measures and a chart draws one; the rule was "first duration-like, else first
  numeric", which silently outranked the `count(*)` a question was often about.
  `trendChart`/`rankingChart` take an optional measure column and report every
  candidate as `measures`; the section heading **is** the control that changes
  it (a `DropdownMenu` on the `h2`), so the answer names its own choice instead
  of hiding it in a toolbar. The pick is by column name and lives on the page,
  not in a store: re-running the same question keeps it, and a different answer
  falls back to its own preference rather than charting a column it lacks.
- **WP4.11 — A line breaks where a bucket is missing (landed).** A `GROUP BY`
  returns no row for a bucket nothing happened in, and the stroke across the
  hole stated a continuity nobody measured. `TrendLine.segments` splits a line
  into runs of consecutive buckets and the chart draws one stroke per run, with
  every point still dotted so an isolated bucket shows. The step comes from the
  column name where the compiler wrote it (`day`, `hour`, …) and is applied by
  the **calendar**, not by arithmetic — a month is 28 to 31 days and a DST day
  is 23 or 25 hours, all of which a fixed constant would break the line on. A
  query that aliased its bucket leaves only the data, so the step is the modal
  gap between consecutive points, compared with slack because that is a
  measurement rather than a promise. Zero-filling was rejected: it is right for
  a `count` and wrong for an average or a percentile, and the client cannot
  tell which it is holding.
- **WP4.12 — A rollup with no time column is a ranking (landed).** Six of the
  eight shipped presets return one categorical dimension, several measures, and
  an `ORDER BY` — and the surface rendered a grid of numbers, making the reader
  do the comparing a bar length does for free. A fifth result shape, detected
  after the trend so anything with a time column stays one. **The measure is
  inferred from the order the rows arrived in**: the result carries no
  `ORDER BY`, but `order by total_ms desc` hands back rows monotonic in
  `total_ms`, which beats "first numeric column"; where several columns are
  monotonic the last wins, because a query lists the measure it ranks by last.
  Bars are horizontal (the labels are tool names and project roots, which are
  text to read), one hue rather than the categorical ramp (magnitude is not
  identity), and each carries its value as a direct label. The query's own
  order is kept — re-sorting would answer a question nobody asked. Both charts
  moved to `lib/chart-shape.ts` with the column primitives they share in
  `lib/result-columns.ts`, leaving `result-shape.ts` to decide *which* form an
  answer is rather than how it is drawn. Tests:
  `tests/unit/insights-chart-shape.test.ts`.

  Known and not addressed: a raw scatter may hold up to `MAX_QUERY_LIMIT` (10k)
  SVG circles; `yDomain [0, null]` would clip a negative measure, which no
  schema column is today.
- **WP4.10 — Codex token cost (landed).** Codex app-server reports cumulative
  token usage but no turn-level USD total. `model-pricing.ts` therefore owns one
  static price catalog for every Codex model in `model-profiles.json`, checked
  against OpenAI's published prices on 2026-08-17. The calculation separates
  uncached input, cached input, cache writes, and output; applies the published
  long-context threshold and rates; and returns no value for an unknown model
  rather than a false zero. The Codex normalizer now preserves
  `cacheWriteInputTokens` as `cacheCreationTokens`, and the turn emitter prices
  the per-turn delta after model rerouting. Existing turns are not backfilled;
  static pricing applies only when a new turn is captured. Claude remains
  provider-priced. Tests: `tests/unit/model-pricing.test.ts`,
  `tests/unit/context-usage.test.ts`, and `tests/unit/session-emitter.test.ts`.
- **WP4.13 — Insights tables use the shadcn data-table model (landed).** The
  shadcn-svelte Data Table is a guide for composing TanStack Table with its
  `Table` primitive, not a one-size-fits-all component. Insights now follows
  that model for all three result grains: turns, events, and arbitrary SQL
  results share one feature registration and toolbar for text search, sortable
  columns, column visibility, page size, and client-side pagination. Each grain
  still owns its honest cells and drill path: turn rows open the turn, event
  rows open the selected span, and a plain result has no invented link. Event
  search also narrows its scatter, so the plot and the table never show
  different answers. Session grouping stays above pagination and disables page
  controls while grouped; splitting one session across pages would make the
  group label false. Row selection is not registered because Insights has no
  bulk action for selected telemetry, and a checkbox with no consequence is
  not functionality. The shared semantic `ui/table` primitive is the current
  shadcn-svelte registry source. Tests:
  `tests/unit/insights-data-table.test.ts` and
  `tests/unit/insights-table-grid.test.ts`.
- **WP4.14 — Insights tables use one premium interaction hierarchy (landed).**
  The table header now names the result and its size, the toolbar holds only
  controls that change the question (search and visible columns), and the
  footer holds controls that move through the answer (page size and page
  navigation). Sticky column headers use a quiet depth shadow instead of a
  heavy border. Sort affordances stay in place and use a short opacity, scale,
  and blur transition, so sorting does not shift a label. Rows use hairline
  separation, tabular numbers, a restrained hover wash, and a thin brand rail
  only when the row drills into a turn or span. Empty and filtered-empty states
  explain what happened inside the table card. Every new control has a 40px
  pointer target, keyboard focus remains visible, and no continuous animation
  or expensive backdrop blur was added. The same shared renderer components
  serve desktop, web, and the mobile read-only Insights surface.
- **WP4.15 — One band asks the question; the type scale is the app's (landed).**
  A table was reading as three unrelated toolbars stacked above the rows: a
  title band, a search band with its own gradient, and the column header. They
  are one band now — the result's name and size on the left, the controls that
  change the question on the right, and only the column header between it and
  the first row. The status filters became a segmented control whose dot is the
  same colour as the row tint and the duration warning, so the reader learns
  that mapping once; the page-size control became the shared `Select` primitive
  rather than a browser-drawn `<select>`; and the clock column names its day
  once a listing straddles one, since a bare `HH:MM` there names two instants.
  Sort carets sit inside the label on a right-aligned column, so a measure's
  header stays flush with its numbers. Search leads the band beside the
  result's name, because it is the control a reader reaches for first; the
  grain's own filters and the shared column menu close the band at its trailing
  edge. Widths are pixel defaults that include the cell's own padding — the
  earlier rem tracks were a content width the padding then ate, which is what
  cut a session id and a model name short — and **every column is resizable**:
  drag its trailing edge, nudge it with the arrow keys, or double-click to hand
  it back. A prompt the reader has dragged stops absorbing the row's leftover
  width, because a width they set is theirs. The tables also moved onto the app's
  type scale and weights — no more 9.5px labels, no per-file tracking, medium
  as the heaviest weight — which is what made the chrome louder than the data
  it framed.
- **WP4.16 — the charts read as one system.** Every plot now names its own x
  positions with a real axis instead of a row of HTML labels spread across the
  card. That row was the source of the misalignment: five instants spaced by
  width sit under whatever bar happens to be beneath them, and on a band scale
  they can never sit under the right one, because a band scale places only the
  categories in its own domain. `bucketAxisTicks` therefore returns **bucket
  starts**, spaced by index, both ends included — the axis draws them exactly
  where the bars are. The linear trend axis keeps explicit instants for the
  opposite reason: d3 rounds a linear domain to neat numbers, and a neat number
  of epoch milliseconds is an arbitrary time of day.
  Both time axes anchor their **end labels inward** (`textAnchor` start/end via
  the `tickLabel` snippet), because a label centred on the first or last bar
  hangs half a timestamp off the plot and the card crops it.
  **A time label is sized by the span it names**, not by "is this more than a
  day": under a day the clock alone, up to three days the day beside it, past
  that the day alone. `Aug 11 00:19` is twice the width of `Aug 11`, and on a
  week-long window that extra width on every tick is both noise and the thing
  that pushes the end labels under the card's edge.
  **Bucket count follows the plot's measured width**, at roughly one 21px slot
  per bar, clamped to 16–112. A fixed 48 made bar width a function of the
  window: the same 48 bars are hairlines in a drawer and 33px slabs across a
  wide desktop, which is what made the histogram read as a bar chart of nothing.
  Deriving the count pins the bar to one size everywhere, and the extra buckets
  a wide plot earns are extra resolution rather than extra ink. The floor keeps
  a bar hoverable and brushable; the ceiling stops the histogram out-resolving
  the cursor, where one tooltip would answer for several bars.
  **The histogram counts what the listing shows.** `withStatus` is shared by
  both, so the status chips directly under the bars narrow them too — a filter
  the reader can see and a chart that ignores it misstates what is counted. The
  brush is deliberately *not* folded back in: the bars are the control it acts
  on, and applying the selection to them would collapse the plot into whatever
  was just dragged.
  Sizes: the volume histogram went 70px → 208px of plot, the trend 144px → 176px,
  the session strip 52px → 80px. A 70px histogram is a sparkline wearing a stat
  strip — it had no room to show a shape, which is the only reason it exists.
  **Colour: chart marks wear the art ramp, softened against the surface.** Fills
  are mixed toward `--card` (70% for the volume hue, 78% for the negative) —
  the ramp at full strength is a print colour, and the surface is what pulls it
  into the app's own register; mixing against `--card` rather than white keeps
  that true in dark mode. Failed marks use `--solus-art-negative`, not
  `--failure`: the latter is a cold `#ef4444` that belongs to buttons and status
  pills, and set on a parchment card beside a dusty blue it is the loudest thing
  in the panel and reads as an alert rather than a measurement. Ink is *not*
  softened — a pastel is unreadable as text, so the stat strip and tooltips take
  the ramp hue at full strength.
  **No gradients.** Both the bar fall-off and the area fade were tried and
  removed: a fade to nothing reads as a rendering effect rather than a quantity,
  and it is the first thing that makes a chart look generic. The area under a
  single line is a flat 10% wash instead.
  The rest follows the dataviz specs: 3px rounded caps, a 2px surface ring on
  every trend dot so it survives crossing its own line, the wash left off once
  the answer splits (overlapping washes read as a stacked quantity nobody
  computed), and a full-length track behind each ranking bar so bars are read
  against one scale instead of against their neighbours. Stat-strip labels moved
  onto the app's type scale — the 9.5px uppercase tracking was the last of that
  family in Insights.
- **WP4.16 — A table you can read from, not only click through (landed).**
  Three things a reader expects of a table were missing. Selecting text was
  impossible: the mouse-up that ends a drag-select is also a click, so the row
  opened and took the selection with it — activation now defers to a selection
  the reader is holding (`hasTextSelection`). Right-click did nothing: every
  row now opens a menu that copies the cell or the whole row as tab-separated
  text, hides the column under the pointer, resets column widths, and offers
  the row's own destinations (a turn, its session, a span's waterfall). The
  menu reads its subject from the rendered row rather than from the model,
  because a duration must copy as `26m54`, not as the epoch difference behind
  it — which also lets one menu serve all three grains. And a column header
  sorted once and then stopped: the turn listing's sort lives in the parent as
  one key and one direction, so TanStack's third "unsorted" state was an empty
  array this component dropped on the floor. `enableSortingRemoval: false`
  makes the header toggle ascending and descending forever. One more thing the
  root stylesheet owns: `user-select: none` on `#root` gives the app its native
  feel and made every table cell unselectable, so the rows opt back in. And a
  drag now starts from the width the column has *on screen* rather than the
  width the table holds for it — the two differ for the column absorbing the
  leftover space, which is why grabbing that edge snapped it to its default
  before it began following the pointer.
- **WP4.16 — A table you can read out of (landed).** Solus disables text
  selection at the root (`html, body, #root { user-select: none }`), which every
  table row inherited, so a reader could not drag a session id or a prompt out
  of the answer they had just queried for. The rows opt back in with
  `select-text`, and — because the mouse-up that ends a drag-select is also a
  click — a row that would open a turn or a span now defers to a selection the
  reader is holding. Right-clicking any row opens one shared menu: where the
  row leads (its turn, its session, its span), copy this cell, copy the row as
  tab-separated text, hide the column the pointer was over, reset column
  widths. What it copies is what the row *shows* — `26m54`, not the epoch
  difference behind it — which is also what lets one menu serve all three
  grains: it reads the rendered row rather than the model.
- **WP4.17 — SQL completion follows the two-table model (landed).** The editor
  now treats `turns` and `events` as the primary authoring surface rather than
  giving every schema source equal weight. They lead table completion after
  `FROM` and `JOIN` under a **Tables** heading and carry the app's Phosphor table
  icon; raw `spans` and `internal_events` remain available but are ranked as
  advanced sources. One explicit completion pipeline ranks Columns, Tables,
  Patterns, and SQL in that order, so CodeMirror's ungrouped keywords cannot
  push a relevant table to the bottom. Columns use a column icon, primary row
  keys use a key, and cross-table trace/parent ids use a link. Table positions
  use CodeMirror's schema source alone, so a table is never duplicated by the
  contextual source. Before a table is named,
  unqualified completion
  offers the deduplicated union of `turns` and `events` columns. After a table
  is named, it narrows to the columns of the tables in that statement. Shared
  columns appear once and name both tables in their detail. Qualified
  `table.column` and `alias.column` completion remains owned by CodeMirror's
  SQL parser so aliases keep parser-accurate behavior.
- **WP4.18 — The turn detail is attributes and texts (landed).** Three faults,
  one shape. **A strip of four stat cards held values that were also facts of
  the turn**, so a reader looking for the duration found it in one place and
  every other fact in another; duration, cost, tokens, tool calls and denials
  are now rows in Attributes like everything else, and the strip is gone rather
  than restated — one value has one home, and a glance line under the title
  would have been a second one.
  **Nothing could be selected or copied** — the same root `user-select: none`
  the tables opted out of in WP4.16 — so the detail body is `select-text`, its
  controls are `select-none` so a drag over a row still activates it, values
  wrap instead of truncating (a value clipped by CSS cannot be dragged over),
  every row carries its own copy control, and the header copies the whole list
  as tab-separated text. **A row copies the stored value, not the printed
  one**: `2000`, not `2.0s` — a rounded duration pasted into a query is
  useless. Around forty rows do not fit a rail, so the list shows Outcome and
  Identity and puts Context and Timing behind one control, into a bounded
  scroller rather than a rail that grows past the trace it explains. A missing
  measure keeps its row and states why (Codex reports no per-turn cost);
  dropping it would read as a bug and printing `$0` would be a lie.
  **And the turn now records what it said and what it was told.** The emitter
  captures the composed system prompt at dispatch (`systemPrompt`, capped at
  16 KB) and the answer (`response`, capped at 8 KB — the provider's own
  `task_complete.result`, falling back to the last top-level assistant message
  so a stopped turn still shows what it had streamed). Both are registered
  `turns` columns, so the schema panel, editor completion and NL→SQL get them
  for free. Per turn, not per session: the system prompt is rebuilt on every
  dispatch and the task context inside it moves as the task does. Prompt,
  Response and System prompt render as three collapsible sections, each bounded
  with a fade naming the cut, each copyable; the system prompt starts closed,
  being the largest text a turn carries and the one a reader opens
  deliberately. No backfill — turns captured before this have neither, and the
  empty state says so rather than showing a blank card.
- **WP4.19 — The session card is a lineage (landed).** The card led with the
  session id and gave every row four measures on two lines, which made the one
  question it exists to answer — where am I in this session — the hardest thing
  on it to find. It now leads with place (`Turn 4 of 12`) over one muted line of
  session totals, then the turns as a thread: a hairline running dot to dot,
  starting and ending at a dot rather than off both edges of the scroller. A row
  is two things, what was asked and how long it took, and nothing else; prompts
  come from the window's own rows (`promptsByTrace`), and a turn the answer never
  listed keeps its model. The measures a row dropped — model, status, tokens —
  moved to its title attribute rather than being deleted. The reader's own turn
  is the only strong mark on the card: an accent dot with a soft halo, a faint
  accent wash, and the only row in full-strength ink. The card scrolls that row
  into view on arrival, so a deep link and the header stepper land the same.
  `lib/session-rail.ts` owns the row model.
  **The strip stays a picture.** Making its bars open turns was tried and
  removed: a bar names a half hour, not a turn, so opening one opens whichever
  turn happened to fall in it, and the strip acquired hover readouts, a roving
  tab stop and arrow-key traversal to place a click the reader could not aim.
  The card names its turns and owns the navigation; the strip answers where the
  session sits in the window and nothing else. `lib/session-context.ts` owns the
  one bucketing its three bar layers read.
- **WP4.20 — The turn summary is one card, and coverage sits on the plot
  (landed).** The three texts WP4.18 shipped were three identical cards at the
  bottom of the column, below the waterfall, so the exchange a turn recorded was
  the last thing on the page and read as three unrelated blobs. They are now one
  **Summary** card of three named panes — Prompt, Response, System prompt — at
  the head of the column, each wearing its role's colour from the ramp the
  waterfall already spends (the ask in the brand accent, the answer in the hue
  `response_stream` has there, the instructions muted), each with its own copy
  control beside a card-level control that copies the whole exchange with the
  roles named. Order is not chronological on purpose: the ask and the answer are
  the pair a reader compares, so they stay adjacent, and the instructions sit
  last and closed. Body text moved from a chrome size to `text-caption` — this is
  reading matter and it follows the reader's text-size preference — with an
  80-character measure cap so a full-width panel does not set 200-character
  lines. `lib/turn-transcript.ts` owns the pane model.
  **The cut is measured, not assumed.** The bounded height painted its fade and
  offered "Show more" on every pane, including a two-line prompt that was
  entirely on screen — a stated cut that never happened. A `ResizeObserver` on
  the scroller and its content decides; an expanded pane is not re-measured,
  since the tall bound would clear the flag and take "Show less" away from the
  reader using it.
  **Coverage is full width, against the plot's own edge.** The share bar was in
  the 19rem rail while the waterfall it explains was in the main column, so the
  two pictures of one interval never shared an edge. `TraceCoverage` now sits
  inside the Trace card between its header and the plot: the bar, a wrapping
  legend of kind/share/duration, and the unattributed gaps behind a disclosure
  rather than always printed. The ranked lists that were beside it — longest
  tool calls, denied permissions — stay in the rail as `TraceHotspots`, which
  the panel renders only when there is something ranked to show. The session
  strip moved below the trace: it is context, not the answer.
- **WP4.21 — The session summary is a full-width section, and no mark is a dot
  (landed).** WP4.19's session card was a 19rem rail item, which is why it had
  to spend a thread of dots and two-line rows to say what a wide row says in
  one. It is now a full-width `SessionSummary` section, second on the page after
  the window strip, which also went full width directly under the title — both
  are statements about the whole page, so both take the whole width before the
  page splits into a column and a rail.
  - **Titled by name, not by id.** The header leads with the session's own name,
    read from the host through `insightsStore.loadSessionName` and cached beside
    the rollup: `metrics.db` records ids because a name is editable and a
    recorded span is not. The short id stays beside it with its copy control.
    The same name replaces the model as a row's title fallback — a column of
    repeated model ids names nothing a reader was looking for, and the model is
    a fact about a turn rather than its identity.
  - **No dots anywhere.** The thread of status dots is gone, and so are the
    transcript's role dots. A row is marked by its ordinal and, when it is the
    reader's own, by an accent ordinal over a faint accent wash. A turn that
    ended badly says so in the ink of its duration and in words on the hover
    card. The coverage legend's swatches became short rules cut to the shape of
    the bar they key, which is the one place a colour key is load-bearing.
  - **A row answers its second question on hover.** `SessionTurnTooltip` is the
    move the session sidebar already makes on a session row: the row prints the
    three things that identify a turn, and everything else the rollup recorded —
    clock, origin, model, tokens, cost, tool calls, status — is one hover away,
    asked one row at a time instead of crowded onto all of them.
  - **The longest tool calls are baked in.** They were a rail card, which put
    the session's longest turn and this turn's longest tool call at opposite
    corners of the page; they are the same question at two depths, so they share
    the section, labelled "in this turn" so the scope cannot be misread. Denied
    permissions moved into the coverage band, being time the turn spent waiting
    on a person. The rail is now the attributes list alone, which is what a rail
    is for.
- **WP4.22 — A turn row is named by its own ask, and the exchange reads as
  prose (landed).** Three defects with one cause: the surfaces printed what was
  cheap to reach rather than what the reader was looking for.
  - **A row is named by what it asked.** The rollup carried no prompt, so every
    row outside the current answer fell back to the session's name — one name
    repeated down a column, usually the task the session was opened from, which
    identifies none of its rows. `MetricsTurnSummary.prompt` now carries the
    turn's own ask, single-lined and capped at 200 characters on the wire: a row
    shows one truncated line, and a 200-turn session must not ship 200 whole
    prompts to say so. Precedence is the answer's own full text, then the
    rollup's capped line, then the session name, and only then a stated absence.
  - **The bounded lists take the app's standard treatment.** The turn list and
    the tool ranking are context beside the turn being read, not the listing:
    five rows where the panel has room and three where it does not (a container
    query — the panel is 380px beside a rail and full width in full screen),
    scrolling under `scrollbar-on-hover` with `overscroll-contain`, the same
    pattern the task page's session list and the project panel's task list use.
  - **The answer is markdown, so it is rendered as markdown.** Response and
    system prompt were printed as one pre-wrapped string at the chrome's size,
    so headings, fences, tables and list markers arrived as literal characters —
    the hardest-to-read form of the text a turn exists to show. Both now render
    through the conversation's own prose stack
    (`prose-cloud prose-reading prose-transcript`) with the shared `CodeBlock`
    for fences, so a recorded answer reads the way the reply did. The ask stays
    plain pre-wrapped text at the reading size: it is what a person typed, and
    rendering their `#` as a heading would edit it. Each pane's text hangs off a
    hairline rail in its role's hue, which is where the role colour lives now —
    these surfaces carry no dots (WP4.21), and the rail labels nothing on its
    own. The clipped state is a mask rather than a painted gradient, because the
    panes sit on the card, the rail and the reader's theme, and a gradient would
    have to guess which.
- **WP4.23 — Execution host dimensions (landed).** New turn roots capture the
  execution machine's hostname and normalized operating system once per Solus
  process. The generated `turns` view promotes them as `hostname` and
  `host_os`; `events` reads the same facts from its turn root. The schema panel,
  SQL completion, hover documentation, and NL-to-SQL prompt receive the fields
  from the registry automatically. No historical backfill is attempted.
- **WP4.24 — Main volume is split by provider (landed).** The main histogram no
  longer overlays failed rows against completed volume. Its bars stack Claude
  Code, Codex, and an explicit unknown segment for older or partial results.
  Provider is the comparison the page exists to make across agent backends;
  completion status remains available in the listing and its filters. The
  legend and band tooltip use the same fixed colours as the bars, and the shared
  renderer applies the split to desktop, web, and mobile. (WP4.26 later moved
  those colours from the art ramp onto the backends' own brands.)
- **WP4.25 — The Summary card reads as the conversation it records (landed).**
  WP4.20's three named panes were drawn as interchangeable disclosure rows —
  same height, same ink, same caret, two of them open onto long text — so a
  reader met a stack of prose with nothing marking where the ask ended and the
  answer began. Nothing was missing; the shape carried no meaning. The card now
  replays the exchange in the transcript's own grammar: the ask is a bubble on
  the same 2% foreground fill a user message uses, held right and to a message's
  width; the answer is prose on the card's ground, left, at the reply's reading
  size. Those two shapes already mean "a person said this" and "an agent said
  this" everywhere else in Solus, so the roles need no rail and no status mark —
  this card holds to WP4.21's rule that these surfaces do not ask a reader to
  learn a colour key — and the speakers are named above each side as muted
  captions rather than headings: **User**, then the backend that answered —
  **Claude Code** or **Codex**, beside its own logo in its own brand ink
  (WP4.26). A turn whose provider was never captured is answered by
  **Agent** with no logo, because a missing field must not be drawn as
  somebody's brand. Naming the backend here is the same comparison WP4.24 made
  the main histogram carry. Neither side is behind a control, because the
  exchange is why the card is open. The instructions move under the card's own
  hairline as a footer disclosure, closed until asked for: they are the largest
  text a turn carries and the one a reader opens deliberately, and they get no
  speaker because a document is not a party to the conversation. The two token
  counts move to the card header as the exchange's size, so neither caption
  carries chrome; the attribute names survive where an analyst wants them, on
  each copy control. Bounded height, measured cut, fade, and the capture-cap
  note are unchanged from WP4.20.
- **WP4.26 — Backends are named and marked the same way page-wide (landed).**
  Three surfaces showed a provider and each spelled the mapping out again: the
  histogram legend and its band tooltip, the turn's identity line, and WP4.25's
  Summary captions. `lib/provider.ts` now owns it — `claude` and `claude-code`
  are one backend, `codex` is its own, and anything else has no name and no
  mark. `ProviderMark.svelte` draws the same two marks the input bar's model
  picker draws — `ClaudeIcon` and `OpenAIBlossom` — so a backend looks the same
  wherever Solus names it, each in its own brand ink, the way the
  session picker and the onboarding cards already do: Claude in the terracotta
  now held once as `--brand-claude`, and Codex in the surrounding text's colour,
  because OpenAI's mark is monochrome by design and pinning it to a hue would
  break it in one of the two themes. The names beside the marks stay muted, so
  the logo is what carries the colour. The histogram takes the colours but not
  the logos: its Codex bar leaves WP4.24's dusty blue for the same text ink the
  Codex mark uses, and its legend and band tooltip carry the swatch alone —
  once a swatch is the backend's own colour, a logo beside it says the same
  thing twice. The identity line
  reads "Claude Code" rather than the raw `claude`, and the legend keeps its
  colour swatch — the swatch is the key to the bar and the logo names what the
  swatch stands for, so neither replaces the other. Each surface still words the
  unrecognised case for itself: "Unknown" on the chart, "unknown provider" on
  the identity line, "Agent" in the Summary card. The attributes rail and the
  SQL result grid are deliberately unmarked: both print stored values, and a
  logo beside `provider = claude` would dress up the record.
- **WP4.28 — Insights is reachable from the work it records (landed).** The page
  answered only from its own console: the one way to ask about a session was to
  open a turn first, and there was no way at all to ask about a task. Insights
  now opens **scoped to the thing the user right-clicked**. Two seams on the
  workspace context, beside `openInsightsTurn`: `openInsightsForSession` and
  `openInsightsForTask`, each running one of Solus's own generated statements
  (`GeneratedQuery` gains a `task` kind, `taskTurnsSql`) and then showing the
  page. **The scope is the question, not the route** — the route's params keep
  naming the open turn and nothing else, because the page already renders
  whatever the store last asked, and a preset and a drill-in should not be two
  different kinds of thing. `runGenerated` only runs when the store has resolved
  a host; asked from off the page it sets the statement and lets the page's
  opening load run it, so entering does not ask the same question twice.
  Entry points: `SessionContextMenu` (its five call sites — sidebar rows, pinned
  rows, the breadcrumb, the tab strip, and the new-tab home), `TaskContextMenu`
  (sidebar task rows and the tasks page), and an **Insights button in the action
  row**, beside Fork. A session is scoped by Solus's own session id — the id
  `spans.session_id` records, not the provider thread's — and a task by its id,
  so every attempt at one task counts as that task's work.
  - **A task's turns had to exist first.** Only a first dispatch carries a task
    in its run options; every later turn resumes a provider conversation and
    arrived with none, so roughly five in six recorded turns had no `task_id` at
    all and the question could not be asked. `_turnTask` now falls back to the
    session's own binding (`Task.forSession`), and records the id even when the
    title cannot be read — a task shipped from another host without a snapshot
    is still the id every span should carry. The dispatch step is renamed
    `task_title` → `task_dimension`, since it now resolves both.
    Test: the resumed-turn case in `tests/unit/control-plane-observability.test.ts`.
  - **Known limits, deliberate.** `metrics.db` is host-local and the page follows
    the active host, so a session recorded on another host answers empty — the
    same constraint every Insights answer already has. Mobile has no context
    menus and no action row, so it keeps the read-only page it already had.
    The demo client answers a task drill-in from its own task↔session bindings
    and lists nothing for a task it does not know, rather than answering with
    every turn.
- **WP4.20 — Dispatch has an interior (landed).** The `setup` bar covered
  everything Solus does before a turn reaches the provider — git context,
  worktree creation, task preparation, instruction composition, agent launch —
  and named none of it. On a cold dispatch it was the largest thing in the turn
  and the only one a reader could not question. Dispatch now records
  `internal.dispatch_step` spans **inside the turn's own trace, parented to the
  setup span**, so they are on the same axis as thinking, tools and waits
  instead of forming an orphan trace with no turn to belong to.
  **Steps nest through an ambient async context**, not a passed parent.
  `SessionEmitter.runDispatch` opens the scope (an `AsyncLocalStorage` holding
  the running step) and the free `dispatchStep(name, attrs, run)` finds its
  parent there, at any depth and across any module boundary. So
  `createWorktree` — which already hand-timed four git commands for `dev.log` —
  records them under the caller's span while taking **no telemetry parameter at
  all**, which is the point: the signature of a function being measured should
  not change because it is measured. That is what makes the waterfall indent
  `launch_run → worktree_create → git_worktree_add` instead of listing nine
  peers. Outside a dispatch, `dispatchStep` is a straight pass-through, so a
  worktree created from a surface with no turn behind it is an ordinary call. A
  context that outlives its scope — a callback registered during dispatch and
  invoked after it — finds its parent already closed and goes untraced rather
  than dating a step against a finished span. This is also the context manager
  WP5 specifies for span context, so it lands here rather than being retrofitted
  later. The steps: `launch_run`, `git_state`, `worktree_create` (with
  `default_branch`, `start_point`, `git_worktree_add`, `copy_included_files`),
  `handoff_build`, `task_lookup`, `task_prepare`, `task_context`, `session_log`,
  `agent_launch`, `task_title`. Each carries its arguments — paths, argv, branch,
  base branch, task id, model, cwd, permission mode, character counts — capped
  at 1 KB per value, because a step that took four seconds is only actionable
  once you can see what it was called with. A step that does not run on a given
  dispatch emits nothing; a step that throws is still recorded, with its error,
  and rethrows untouched. `agent_launch` is timed **without an `await`**: the
  call is synchronous and suspending there would move handle registration into a
  later microtask, which the dispatch sequence depends on not happening.
  Kind-wise these are `internal.*`, so they land in `internal_events` and leave
  every existing `events` question about agent work alone.
  **One "Solus internals" switch** in the Trace card header governs the whole
  group — `setup` and its steps, `queue_wait`, `turn_settlement` — across both
  the split panel and the full page, which are one component. Off by default
  (the ordinary question a turn is opened with is what the agent did),
  persisted like the time range, and hidden entirely on a trace with nothing to
  reveal. Hiding a row hides its subtree, so a dispatch step is never reparented
  onto the turn root where it would read as a phase of the turn. `TraceCoverage`
  and the legend stay computed over the **full** span set: coverage is a
  server-derived attribution fact, and re-deriving it from the visible subset
  would make the bar lie whenever the switch is off. A deep link to an internal
  span reveals it regardless of the stored preference, without changing it.
- **WP4.21 — Telemetry leaves the machine (landed).** `metrics.db` was not one
  sink among several; it was the only one. `writeSpan` had a single `INSERT` and
  no fan-out, so no span had ever reached OTel — `otel.ts` wired up a
  `LoggerProvider` and a `MeterProvider` and nothing else, and the only things
  exported were `logger.ts`'s log records and `log.metric()` durations. There
  was also no settings UI at all: configuration was `OTEL_EXPORTER_OTLP_*`
  environment variables or nothing.
  **Traces now export.** `@opentelemetry/sdk-trace-node` and
  `exporter-trace-otlp-http` are added, and `writeSpan` fans out to
  `exportOtelSpan` after the insert — best-effort, never able to fail the write,
  because a span that could not be shipped is still a span Insights can read.
  Solus records complete spans and only then hands them over, so there is no
  live tracer: a finished record is adapted to the exporter's own
  `ReadableSpan` and handed to a `BatchSpanProcessor`, which keeps the batching,
  retry and shutdown-flush the SDK already implements. **Ids carry across rather
  than being regenerated** — a Solus trace id is a UUID, which is exactly the 16
  bytes OTLP wants, and a span id is the first 8 of its own — so one turn is the
  same trace in Insights and in the operator's backend, and the id printed on
  the turn detail is the id to paste into the collector.
  **Settings are host-scoped**, in `ServerSettings` beside `metricsRetentionDays`
  and reached over RPC (`otelSettingsGet` / `otelSettingsUpdate`), because the
  exporter runs beside the server: a phone on this page is configuring the
  machine it is connected to, not itself. The Telemetry tab is therefore
  web-visible rather than desktop-only, and the store is keyed by server, since
  two hosts a user is connected to can ship to different collectors or to none.
  Saving reconfigures the running process, so turning export on does not need a
  restart. **Environment variables still win**: a deployment that sets them
  keeps behaving exactly as before, and the form goes read-only and says why —
  a switch that lies about what it does is worse than one that is honestly
  unavailable. Enabling requires an endpoint (otherwise the switch would report
  "on" while exporting nowhere), a pasted trailing slash is stripped before
  signal paths are appended, and the default is off with an empty endpoint:
  nothing leaves the machine until an operator names a destination. The endpoint
  and headers are the operator's secrets and are never logged; only the shape of
  the decision is.
- **WP4.27 — The tracer is the span model, and SQLite is an exporter
  (landed).** WP4.21 left Solus holding two tracers. The bespoke one —
  `SessionEmitter` over `facade.ts`, with its own `AsyncLocalStorage`, its own
  span buffer and its own id space — was the real one, and OTel was reached
  through an adapter that turned a finished database record back into a
  `ReadableSpan`. That is the standard arriving as an afterthought: we wrote a
  tracer and then wrote a translator to the one every collector already speaks.
  It is now the other way round.

  **One `Tracer`, two sinks.** `observability/tracer.ts` builds a
  `BasicTracerProvider` whose processors are a `SimpleSpanProcessor` into the
  new `SqliteSpanExporter` and, when the host's settings ask for it, a
  `BatchSpanProcessor` into `OTLPTraceExporter`. The difference between them is
  the point: **the record must never drop and the copy may.** A batch processor
  discards on queue overflow, which is an acceptable loss for spans an operator
  asked to be shipped elsewhere and a correctness bug for the table Insights
  answers from, so the SQLite sink is synchronous — a span is queryable the
  moment it ends, with nothing in flight to flush. Sampling is pinned on for the
  same reason: a sampler read from the environment would silently delete rows
  somebody is querying. The OTLP processor is attached and detached on the same
  settings toggle WP4.21 built, through a small holder rather than the
  provider's fixed processor list, and detaching flushes what it replaces.

  **The exporter owns the projection, which is why nothing above it moved.**
  Insights is a SQL surface, not a trace viewer: `field-registry.ts` promotes
  `session_id`, `provider`, `model`, `project_root` and `origin` to columns,
  `kind` selects a view, and every registered field resolves to a column or a
  path inside `attrs`. A tracer knows one flat attribute bag. A span therefore
  states its Solus vocabulary in `solus.*` attributes — kind, service, status
  and the five dimensions — and the exporter reads them back out into columns,
  leaving `attrs` holding exactly the registry's own camelCase names. Status is
  carried explicitly because OTel has UNSET/OK/ERROR and Solus also records
  `interrupted`: a turn the user stopped must not read as one that failed.
  `field-registry.ts`, `rollups.ts`, the Insights renderer and the Telemetry
  settings tab are unchanged, which is the test of whether the projection is in
  the right place.

  **Ids are OTLP's, and a trace root is still named by its trace.** Solus ids
  were UUIDs derived down to OTLP widths on the way out, so a span id printed in
  Insights was not the span id in the collector. Both are now the same string,
  at OTLP's own widths, with one restatement: `spans` has always identified a
  turn by `span_id = trace_id` — the join `events` reads a turn's automation,
  task and branch through — and OTLP has no such thing. `SolusIdGenerator` gives
  a root span the first half of its own trace id, so the exporter recognises a
  root, and a root's children recognise their parent, as a pure function of the
  span rather than as bookkeeping. Rows written before this keep their UUIDs and
  keep answering; ids are opaque strings to every query.

  **`SessionEmitter` is now policy over a real tracer, and the old pathways are
  gone rather than kept beside it.** The hand-rolled `DispatchContext` and its
  `AsyncLocalStorage` are replaced by OTel's context: `runDispatch` opens a scope on the setup span and
  `dispatchStep` finds its parent in `context.active()`, so `createWorktree`
  still records four git commands under its caller while taking no telemetry
  argument. The `BufferedSpan` machinery is deleted outright: a span is a span,
  and it ends when the work ends rather than being held in a list until the turn
  settles. The `ReadableSpan` adapter in `otel.ts` is deleted, and that module
  now only owns the settings-driven OTLP configuration for all three signals.
  What survives is the policy OTel does not have: turn settlement semantics,
  start-time clamping so a provider timestamp cannot draw work as overlapping a
  dispatch that had not launched it, the `capped`/`cappedAttrs` limits, and
  closing every span a crashed or interrupted dispatch left open.

  **`facade.ts` is gone with the API it was a facade for.** `startSpan` and
  `endSpan` wrote an open row and updated it later, which only made sense while
  the database was the tracer; nothing writes an open row now, because a span
  reaches the table once, when it ends. What is left is `span-table.ts`: the row
  shape, the insert and the retention delete, with every id and timestamp
  required — the tracer mints ids and Solus decides times, and the table invents
  neither. The span vocabulary those files shared (`SpanStatus`,
  `SpanAttributes`, `SpanDimensions`) moved to `registries.ts` beside the kinds,
  services and attribute keys it belongs with, and the unused `observability/`
  barrel is deleted. Registered-vocabulary validation lives at the one boundary
  where an untyped span could arrive — the exporter — and a span that fails it
  is logged and dropped rather than thrown, because an exporter that throws
  takes the ending span's caller with it.

  **Two consequences, both deliberate.** A span now carries the dimensions the
  turn knew when it *ended*, not the ones it had settled on by the time it was
  written — so the turn root and everything after `completeSetup` are unchanged,
  while a dispatch step, which runs before the provider has answered, records
  the backend and project it was dispatched to (passed to `beginTurn`, since the
  control plane knows both) and no executed model, because there is not one yet.
  And a tool span that a provider revises after it has already closed keeps its
  first outcome: an ended span is ended, which is the model's rule and not a
  workaround.
- **WP5 — OTel + app emitters.** The exporter, its settings UI and the span
  context all landed early, at WP4.20, WP4.21 and WP4.27: traces, metrics and
  logs ship over OTLP under one resource, and `context.active()` carries the
  running span. What is left is the emitters and the enrichment — a gRPC
  exporter option, logger enrichment from the active span before the `dev.log`
  entry is built (`logger.ts:249-252`), an `internal.rpc` wrapper in
  `SolusServer.handle`, indexer/git/automation emitters, and the `log.metric()`
  migration.

## Open questions

- **OTel settings on mobile.** The plan specifies the settings UI for desktop and
  web; the repo rule requires mobile capability or an explicit exception. Proposal:
  mobile shows OTel status read-only, editing is desktop/web — needs sign-off as a
  second platform exception (the first is Insights query composing).
- Exact attrs shape of the `tool_call_complete` outcome field — resolve at WP2 start
  against both providers' available outcome data.
- ~~Chart rendering in Insights~~ — **resolved at WP4: LayerChart, for the
  waterfall as well as the histogram.** Composed from its primitives (`Chart`,
  `Svg`, `Bars`, `Axis`, `BrushContext`) rather than its simplified chart
  components: the histogram needs a brush over the same band scale two bar
  layers share, and the waterfall needs ranged bars (`x` returning
  `[start, end]`) on a band scale of span rows. Its four container variables are
  bridged to Solus tokens in `index.css`, so charts follow the theme.
  **Two consequences of putting the waterfall on one shared scale**, both
  deliberate: span labels and durations are HTML columns pinned to the band's
  row height rather than SVG axis ticks, because they carry indentation,
  truncation, and hit targets that ticks cannot; and a selected span's detail
  opens *below* the plot rather than inline under its row, because pushing rows
  apart mid-trace would break the alignment the shared axis exists to provide.
  The design composition shows inline expansion; the shared axis is worth more.
- **The span detail is a sticky dock, not a block at the end of the plot.** A
  trace runs to hundreds of rows, so a detail that only lives after the last row
  costs a scroll to the bottom and back for every pick. The detail card now
  sticks to the foot of the Insights scroller while any of the plot is in view:
  the reader picks a row deep in the trace and keeps reading with the detail
  still on screen. Consequences: the Trace card must not be `overflow-hidden`
  (that would make it the scroll container and kill the sticky), the dock caps
  its own height and scrolls internally so it can never own the viewport, and
  because the detail is no longer beside its own row its head closes on an
  edge-to-edge position ruler — the span's extent inside the turn — as the only
  thing left saying when in the turn it ran. The head is monochrome and reads in
  three descending registers (kind and service, name, then duration with share
  and start offset); colour appears only on a failed status, and the dock wears
  no kind rail or status dot, since the row that opened it already carries the
  hue. Escape from inside the dock closes it; the close control is a real button
  so the pick is reversible by pointer too.
