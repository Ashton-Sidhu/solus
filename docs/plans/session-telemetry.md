# Session telemetry

## Context

Solus observes agent timings today but keeps none of them. `RunHandle` tracks a run's
start and tool-call count, `task_complete` reports cost and token usage, and the renderer
derives per-tool durations from message timestamps. Every one of those facts is discarded
when the turn ends or the tab closes. A user cannot ask how long their test suite takes
across a week, which tool burns the most agent time, or what a session cost.

This plan captures agent runs and tool calls as spans in a dedicated local database,
records Solus's own operations as metrics through the existing `log.metric` path, exposes
both through a project-panel section and an Insights page with canned and user-authored
SQL, and lets a user export the same data to their own OpenTelemetry collector.

Local capture is on by default. Nothing leaves the machine unless the user configures
export.

## Vocabulary

Locked before implementation. One name per concept.

- **span** — a timed, parented record of agent work: a `run` or a `tool_call`, plus the
  waits that bracket them. Stored in `telemetry.db`, exported as an OTLP trace.
- **run** — one `AgentRunner.run` call. The metrics unit. Not "turn": CLAUDE.md defines a
  turn as one user-to-agent cycle, which steering violates (a steered prompt joins the
  provider turn already in flight and produces no new run).
- **metric** — a timed Solus operation with no span tree: worktree setup, git status,
  session indexing. Emitted with `log.metric`.
- **service** — the queryable dimension naming what produced a record: `session`, `title`,
  `review`, `peer_agent`, `worktree`, `git`, `index`. Carried on every span, metric, and
  log entry.
- **elapsed vs active** — a run's `elapsed_ms` is wall clock including waits; `active_ms`
  excludes them. Both are stored; the UI always labels which it shows.

## Decisions and why

**Spans key on the provider `agentSessionId`, never Solus's `sessionId`.** The Solus id is
minted with `crypto.randomUUID()` (`control-plane.ts:724`) and mapped in the in-memory
`agentSessionToSession` (line 202), so reopening a session after a restart produces a new
id for the same conversation. Keying on it would fragment history silently. The provider
id is durable and is already the primary key of the `sessions` table.

**Instrumentation lives at the `AgentRunner.run` seam** (`agent-runner.ts:89`), which
already attaches a per-run `onNormalized` listener with the `RunHandle` in scope. The
control-plane funnel (`control-plane.ts:297`) looks like the obvious hook but drops every
ephemeral run at line 303, which would make title generation, review agents, and
peer-agent runs invisible.

**Separate database.** `solus.db` holds irreplaceable domain data — tasks, works, plans.
Telemetry is high-churn and disposable, and mixing them means retention `DELETE`s can only
reclaim space with a full-file `VACUUM` that exclusively locks tasks and works; a hot span
WAL against a file that otherwise writes every few minutes; and a durability setting
(`synchronous = NORMAL`) chosen for tasks, not telemetry. A dedicated file makes "delete my
metrics" an `rm`.

**Tool duration is execution time only.** The provider streams the `tool_use` block before
it asks permission, so a span started at the `tool_call` event counts the human's decision
time. In `ask` mode that turns "slowest tools" into a ranking of which prompts the user was
slowest to approve, presented as agent performance. The span is recorded at `tool_call` but
its clock starts at permission resolution.

**No cross-database joins.** `project_root`, `provider`, and `model` are denormalized onto
the run rollup at write time. This keeps the two files independent and is more correct: the
model used for a run in March must not change when the `sessions` row is re-indexed.

**Span model, not OTel context propagation.** Parent links are already explicit
(`parentToolUseId`, the run handle), so spans are created with
`trace.setSpan(ROOT_CONTEXT, parentSpan)` rather than `AsyncLocalStorage`.

**`service.name` stays `solus`.** OTel `Resource` is per-`TracerProvider`, not per-span, so
varying `service.name` would need one provider per service. `service` is a span attribute
and an indexed column instead — equally queryable in every backend.

## Schema — `~/.solus/telemetry.db`

Own module mirroring `db/index.ts`, own migration list. `journal_mode = WAL`,
`synchronous = OFF` (losing telemetry on power loss is acceptable),
`auto_vacuum = INCREMENTAL` so pruning reclaims space without a locking `VACUUM`.

```sql
CREATE TABLE spans (
  span_id TEXT PRIMARY KEY,
  parent_span_id TEXT,
  trace_id TEXT NOT NULL,
  session_id TEXT,              -- provider thread id; NULL before session_init
  service TEXT NOT NULL,
  name TEXT NOT NULL,           -- run | tool_call | permission_wait | queue_wait
                                -- | rate_limit_wait | thinking
  tool_name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,             -- NULL = never completed
  status TEXT NOT NULL,         -- ok | error | unfinished
  attributes TEXT               -- bounded JSON: tool args, error text
);
CREATE INDEX spans_by_session ON spans(session_id, started_at);
CREATE INDEX spans_by_tool ON spans(service, tool_name, started_at);
CREATE INDEX spans_by_parent ON spans(parent_span_id);

CREATE TABLE runs (              -- typed rollup, written once at run settle
  span_id TEXT PRIMARY KEY,
  session_id TEXT,
  service TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  project_root TEXT,
  started_at INTEGER NOT NULL,
  elapsed_ms INTEGER,
  active_ms INTEGER,
  outcome TEXT NOT NULL,         -- completed | interrupted | failed
  cost_usd REAL,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  tool_call_count INTEGER,
  permission_wait_ms INTEGER, queue_wait_ms INTEGER,
  saw_rate_limit INTEGER
);
CREATE INDEX runs_by_started ON runs(started_at);
CREATE INDEX runs_by_project ON runs(project_root, started_at);

CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  service TEXT,
  value_ms REAL NOT NULL,
  attributes TEXT,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX metrics_by_name ON metrics(name, recorded_at);
```

Spans are pruned after 30 days (configurable: off / 7 / 30 / 90 / forever). `runs` and
`metrics` are kept indefinitely — a few thousand rows a year — so the cost dashboard keeps
full history while drilldown stays bounded.

## Span tree

```
run                    service, model, cost, tokens, outcome, elapsed/active
├─ queue_wait          only when the prompt waited behind a busy session
├─ thinking            from the thinking start/stop events (types.ts:1232)
├─ permission_wait     sibling, never a child of the tool call
├─ tool_call           tool.name, bounded args, is_error — execution time only
│  └─ tool_call        nested sub-agent call, via parentToolUseId
└─ run                 a peer-agent child run, parented across the seam
```

Blocked time is measured and queryable but never folded into a tool's duration.

## Bounded arguments

Tool args are stored and exported. `toolInput` is unbounded JSON
(`claude-event-normalizer.ts:353`), so a `Write` row would otherwise carry a whole file.

Parse, bound each string field, re-serialize — the row stays *valid* JSON, so the renderer
labels a span by reusing `getToolDescription` (`activity-summary.ts:189`), the same
function the transcript uses. `logger.ts`'s `boundedLogValue` (line 106) already implements
this bounding and needs exporting.

Content-bearing fields — `content`, `old_string`, `new_string` — are dropped outright;
`file_path`, `command`, `pattern`, and `query` are kept. Hard 4 KB row cap as a backstop.

## Write path

`DatabaseSync` is synchronous, so every write blocks the main event loop. Buffer spans in
memory and flush through `withTx`, mirroring `logger.ts:64-84` — a 500 ms timer, a size
cap, and a counted drop warning on overrun.

One `INSERT` per span at span *end*, not an insert-then-update: half the statements, and it
batches cleanly. When a run settles, any still-open span is written with `ended_at NULL`
and `status = 'unfinished'`, and the buffer flushes immediately so a finished run is
queryable at once. Also flush from `shutdown-coordinator.ts`.

Accepted loss: an app crash or force-kill loses up to ~500 ms of buffered spans and any
open ones. `logger.ts` already makes the same trade. Interrupts, timeouts, and provider
failures all settle the run and are captured.

## Contract changes

- `AgentRunRequest` gains `service` (`agent-runner.ts:11`), stated explicitly by all four
  call sites: `control-plane.ts:2240` → `session`, `text-generator.ts:48` → `title`,
  `review-agent.ts:67` → `review`, `claude-subagent-tool.ts:82` /
  `codex-subagent-tool.ts:67` → `peer_agent`. `persistence` cannot carry this — `ephemeral`
  lumps a 1.5 s title generation with a ten-minute peer agent.
- `permission_request` / `permission_resolved` (`types.ts:1247`) gain `toolUseId`, so a
  permission links back to its tool call. Claude has it and discards it
  (`claude-permissions.ts:161`, `options.toolUseID`). Codex needs its own check
  (`codex-permissions.ts:18` returns only `{toolName, sessionId}`); if it cannot supply
  one, fall back to matching the pending tool name within the run and log when ambiguous —
  never guess silently.
- `logger.ts` gains `setMetricSink`, mirroring `setLogEventSink` (line 88), so the logger
  never imports the telemetry database.

## Slices

Each is independently valuable and revertable. **Slice 1 first** — everything else consumes
its schema, and it carries all the hot-path risk.

**1 — Capture.** `telemetry.db` + migrations, span recorder, `AgentRunner` instrumentation,
`service` and `toolUseId` contract changes, buffered writer, retention prune,
`setMetricSink`, and `log.metric` at Solus's own operations: worktree setup
(`control-plane.ts:2054`, currently a bare `log.info` with no duration), git status
(`git-helpers.ts:59`), session index sweep, session load, diff computation, review guide.
No UI.

**2 — Read path.** `telemetry.query` RPC, worker isolation, read-only connection and
statement guard, `insights.store.svelte.ts`, project-panel section showing the focused
session's rollup beside `UsageMeters`.

**3 — Insights page.** One `route-registry.ts` entry (`placement: 'any'`,
`exclusiveGroup: 'page'`, lazy component — nine lines, as `automations` is at line 257),
`openInsights` beside `openAutomations` (`workspace.context.svelte.ts:2548`), command
palette entry, `opt+shift+<key>` shortcut. Canned queries ship as editable presets over the
same execution path as user SQL. Saved queries live in `solus.db`, so they survive a
telemetry wipe.

**4 — Export.** `@opentelemetry/sdk-trace-node` + `exporter-trace-otlp-http`, OTLP span
export, Telemetry settings section across desktop/web/mobile.

Deferred: natural-language → SQL (slots onto slice 3 later, writing into the same editor).

## Query surface (slices 2–3)

Aggregation happens in SQL; the wire carries summaries, not rows. A 30-day span window
shipped raw to a phone is exactly the payload rule 3 forbids.

User-authored SQL runs in a `node:worker_threads` worker with its own
`new DatabaseSync(path, { readOnly: true })`. This is not optional: `DatabaseSync` has **no
`interrupt()`** (verified on Node v25.8.1) and executes synchronously, so an accidental
cross join would freeze the main process and every connected client with no way to cancel.
A worker makes a runaway query a `terminate()`. Layered with it: read-only connection,
single `SELECT`/`WITH` only, rejecting `ATTACH` (which would otherwise reach `solus.db`),
`PRAGMA`, and multi-statement input, plus a hard `LIMIT` and result-byte cap.

Freshness: refetch on open, and invalidate on run settle via a `telemetry-updated` topic,
only while the page is mounted and visible. No polling.

## Settings

A **Telemetry** section, following the `analytics` consent precedent
(`server/settings.ts:14`):

- Local capture — on by default, no prompt. Turning it off stops recording and keeps
  existing data; destroying history is the separate **Delete all telemetry** action, which
  is now just removing one file.
- Retention window.
- OTLP export — enabled, endpoint, headers. `OTEL_EXPORTER_OTLP_*` env wins where set, so
  operators keep the conventional path.
- **Include tool arguments in exported traces** — a separate flag, defaulted on once export
  is configured, labelled to say plainly that file paths and commands leave the machine.

`otel.ts:10-14` promises "unset → every function here is a no-op, so nothing ever leaves
the machine." The tracer now always runs for the local sink. Nothing still *leaves* without
configuration, but that comment must be rewritten to say so precisely rather than left to
imply something no longer true.

## Verification

Focused unit tests over deterministic event sequences with an injected clock — no sleeps,
no timing-dependent assertions.

- Feed `tool_call → permission_request → permission_resolved → tool_result` through the
  recorder and assert the tool span's `started_at` is the **resolution**, not the call.
  This is the test that encodes the decision above and fails if someone "simplifies" the
  permission link away.
- A run that is interrupted mid-tool writes the open span with `status = 'unfinished'`.
- Bounded args: a `Write` row keeps `file_path` and drops `content`; the stored JSON still
  parses.
- Retention prunes spans past the window and leaves `runs` and `metrics` intact.
- The statement guard rejects `ATTACH`, `PRAGMA`, multi-statement input, and any write.
- `service` reaches the rollup from all four call sites.

Then `bun run build`.

## Surfaces

- **Clients** — the panel section and Insights page live in `src/renderer`, which the web
  client mounts directly (`client/vite.config.ts`), so desktop, web, and mobile share one
  implementation. Mobile needs a placement decision for the page in `WebMobileLayout`.
- **Providers** — Claude and Codex both flow through the `AgentRunner` seam. The only
  provider-shaped decision is `toolUseId` on permission events; if Codex cannot supply one,
  that is an explicit documented limitation, not a silent gap.
- **Modes** — the page is a route, so Editor and Pill both get it through the registry.
- **Reverse states** — capture has an off switch, data has a delete action, retention has a
  window, and export has an endpoint that can be cleared.
