# Observability

**Goal:** record what agents and Solus itself actually do — turn time, tool time, wait
time, prompts, tokens, and cost — as queryable spans in a local metrics database, and
optionally export the same data live to a user-owned OpenTelemetry collector. Users make
data-driven workflow decisions from their real session history; maintainers investigate
Solus's own internals through the same pipe.

**Status: planned.** Nothing is implemented. GPT Sol (Codex, `gpt-5.6-sol`) audited
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
- **Kind** — the span's type: `turn`, `setup`, `tool_call`, `model_work`,
  `permission_wait`, `queue_wait`, `rate_limit_wait`, `background_task`, `agent_run`, and the
  `internal.*` namespace (`internal.rpc`, `internal.indexer_sweep`,
  `internal.worktree_op`, …). Registered constants, never free strings.
- **Service** — which subsystem owns the span: `solus.sessions`,
  `solus.text-generation`, `solus.review-guide`, `solus.subagents`,
  `solus.automations`, `solus.indexer`, `solus.rpc`, `solus.git`. Registered
  constants. Every span has exactly one.
- **Trace** — one turn (or one internal operation) and all its child spans, sharing a
  `traceId`. A turn's children **tile** its duration: tiling means the *interval
  union* of blocking children covers the turn with no unexplained gap. Children may
  overlap (parallel and nested tools), so summed child durations can exceed the turn
  — share/rollup presets must use exclusive-time accounting, never naive sums.
- **Facade** — the single write API (`src/main/observability/`). Everything records
  through it; it dual-writes to the metrics store and, when configured, OTLP. Nothing
  outside the facade knows about tables or exporters.
- **Emitter** — code that calls the facade for one domain. The *session emitter* (turn
  traces) is the first; app emitters (RPC, indexer, git, automations) follow.
- **QuerySpec** — the serializable query contract: table-less (always `spans`),
  `timeRange`, `filters` (columns or `attrs` JSON paths), `groupBy` (columns or time
  buckets), `aggregates` (`count | avg | min | max | sum | p50 | p95`), `orderBy`,
  `limit`. What the builder edits, saved queries store, and the engine compiles to SQL.
- **Preset** — a QuerySpec shipped in code, shown as a one-click card. Not a DB row.
- **Saved query** — a user-authored QuerySpec persisted in `solus.db`.
- **Insights** — the renderer surface (`src/renderer/components/insights/`). Peer of
  Git/Run/Tasks/Works/Automations in the project panel.
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
6. Full-span turns: not just tool calls — model work, permission waits, queue waits,
   rate-limit waits, background tasks. Children tile the turn.
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
query: QuerySpec → compiler → parameterized SQL over spans
  → RPC handlers (observability-handlers.ts) → Insights UI (desktop/web; mobile read-only)
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
├─ model_work          derived: the turn is running and nothing else owns the clock
│                      attrs: hasThinking; timeToFirstTokenMs on the first segment
├─ tool_call           name: tool name; children nested via parentToolUseId
├─ permission_wait     name: tool name; attrs.decision: granted | denied
├─ rate_limit_wait
└─ background_task     attrs.blocking: false — excluded from critical-path rollups
```

Turn attrs: `prompt` (capped ~4 KB, `promptTruncated` flag), `promptChars`,
`promptSource` (`typed | queued | automation | agent | dispatch`), `interTurnIdleMs`
(previous settlement → this dispatch, same session), `reasoningEffort`, `taskId`,
`automationId`, `costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`toolCallCount`, `permissionDenialCount`.

Tool-call attrs: size-capped input fields (~8 KB, truncation-flagged),
`parentToolUseId`, `isSubagent`, provider outcome (exit code / error) where available.

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

QuerySpec compiles server-side to parameterized SQL. Attribute filters/groups use
`json_extract(attrs, ?)`; percentiles use an ordered-window pass (SQLite has no
native percentile). Raw SQL is deliberately **not** exposed over RPC — there is no
read-only SQLite handle, and saved queries need a serializable definition anyway.

Methods (add to `RPC_INVOKE_METHODS` in `src/shared/rpc.ts`; handler module
`src/main/server/handlers/observability-handlers.ts`, wired in `server/index.ts`;
clients bind automatically via `ws-transport.ts` / the preload):

- `metricsQuery(spec)` — grouped rows.
- `metricsListSavedQueries()` / `metricsSaveQuery(q)` / `metricsDeleteQuery(id)`.
- `metricsSessionSummary(sessionId)` — rollup for session surfaces.
- `metricsTurnTrace(traceId)` — one turn's full span tree (waterfall).

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
- **Internals toggle** ("Show Solus internals", persisted per user): adds
  `internal.*` kinds to the builder and reveals the Solus-health preset pack (RPC p95
  by method, indexer sweeps, worktree ops). Saved queries against internal kinds
  still execute when the toggle is off.
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
- Tiling is interval-union coverage of blocking children; overlap is legal
  (parallel/nested tools); rollup presets use exclusive-time accounting.
- Ephemeral services get one coarse `agent_run` span, not a child tree.
- Automation runs sit in the **user** namespace (users care how long their nightly
  automation takes); only scheduler plumbing is `internal.*`.
- No transcript backfill in v1; metrics start at ship time. (Phase-2 option: indexer
  extension approximating historical durations from Claude transcript timestamps.)
- No raw-SQL RPC escape hatch.
- `metricsRetentionDays` default 30; prune at boot + daily.
- Mobile v1 read-only (approved exception, documented here).

## Work packages

Each WP lands green (`bun run build`, focused unit tests) before the next starts.

- **WP1 — Foundation.** `src/main/observability/`: facade, kind + service registries,
  `metrics.db` connection + migration ladder + `spans` schema, rollover job,
  `metricsRetentionDays` setting. Tests: span write/finalize, rollover boundary,
  registry rejection of unregistered kinds/services.
- **WP2 — Session emitter + provider passthrough.** ControlPlane hooks; the turn
  state machine (interval-union tiling incl. the `setup` child; finalize on every
  terminal path); dimension snapshot from `_launchRun`'s returned run; terminal
  status recorded in the exit/error listeners (the settlement continuation cannot
  see exit codes); `enqueuedAt` threaded through queue drain for `queue_wait`;
  permission close hook in `ControlPlane.respondToPermission` + terminal cleanup;
  prompt + inter-turn attrs with an explicit prompt-source field; dispatch origin
  threaded through `SessionCtx` / `PromptOptions` (not just `SessionRunInput`);
  `AgentRunRequest.service` on all five call sites + the `AgentRunner` hook for
  ephemeral `agent_run` spans closing on throw/reject/timeout too; the optional
  outcome field on `tool_call_complete` (optional because Claude lacks a provider
  outcome at `content_block_stop`); all eight [codex-audit] corrections. Tests:
  synthetic event streams for both providers asserting complete, gapless trees —
  including interrupt, failure, parallel tools, queue drain, and Codex
  usage-delta cases.
- **WP3 — Query engine + RPC + saved queries.** QuerySpec compiler (with percentile
  pass and exclusive-time rollups), `observability-handlers.ts`, RPC registration
  **plus the hand-maintained typed `SolusAPI` surface in `src/preload/index.ts`**,
  `saved_queries` in `solus.db`. Tests: compiler golden cases incl. attrs paths and
  time buckets.
- **WP4 — Insights UI.** Store, presets, builder, waterfall, internals toggle;
  desktop + web; mobile read-only presets. One integrated pass after developer
  agreement, per house rules.
- **WP5 — OTel + app emitters.** Settings-driven exporter (traces/metrics/logs,
  per-service resources, privacy gates) — note `otel.ts` today exports only
  logs/metrics over HTTP, so WP5 adds the trace SDK and gRPC exporter packages
  (`package.json:51-57`); settings UI; span context via `AsyncLocalStorage` with
  logger enrichment before the `dev.log` entry is built (`logger.ts:249-252`);
  `internal.rpc` wrapper in `SolusServer.handle`, indexer/git/automation emitters,
  `log.metric()` migration.

## Open questions

- **OTel settings on mobile.** The plan specifies the settings UI for desktop and
  web; the repo rule requires mobile capability or an explicit exception. Proposal:
  mobile shows OTel status read-only, editing is desktop/web — needs sign-off as a
  second platform exception (the first is Insights query composing).
- Exact attrs shape of the `tool_call_complete` outcome field — resolve at WP2 start
  against both providers' available outcome data.
- Whether `model_work` should be split further (thinking vs generation) or stay one
  kind with `hasThinking` — decide from real waterfalls during WP2.
- Chart rendering in Insights: existing in-repo primitives vs a small chart lib —
  decide at WP4 with the dataviz guidance.
