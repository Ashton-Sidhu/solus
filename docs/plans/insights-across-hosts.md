# Insights across hosts

Status: proposed, 2026-10-01. This plan replaces the Organization toggle on the
Insights page (`OrganizationTurns.svelte`, organization-scope §6.1).

## Decision

1. **Your Insights show your turns from all hosts.** A machine pulls your turn
   rows from other hosts out of the workspace service and writes them into its
   own `metrics.db`. The list, totals, chart, SQL, questions, and saved queries
   then run on that one SQLite database, as they do now.
2. **Only turn rows are synced.** A full span tree is pulled when the user
   opens a turn from another host.
3. **The organization view is in the solus-cloud console.** It shows the same
   `InsightsPage` and reads the workspace service. The Organization toggle is
   removed from Solus.

## Why

- Every signed-in host already sends its spans to the workspace service
  (`insight_spans`). The cloud already has the union of your hosts.
- One engine and one SQL dialect for your Insights. No SQL runs on the shared
  cloud database for this scope.
- The wire cost is small. Measured on one machine, 2026-10-01: 234 turns in
  about 21 hours, 72 spans and about 15 KB of attributes for each turn. A full
  tree for each turn is about 110 MB each month. A trimmed turn row is about
  0.5 KB, which is about 4 MB each month before compression.
- Web and mobile clients already read a host's `metrics.db` through RPC. They
  get the new rows without client-side data work.

## Vocabulary

- **turn row** — the root span of a turn (`kind = 'turn'`, `span_id =
  trace_id`) with only the attributes that the list, totals, and turn-level
  views read. It does not include the transcript or tool inputs.
- **pulled turn** — a turn row that came from the workspace service. Its
  `host_id` is not this machine's host id.
- **own turn** — a turn that this machine recorded. Its spans are complete.
- **turn tree** — all spans and log events of one turn.
- **insight sync** — the task on a machine that pulls turn rows. It keeps one
  cursor for each organization.
- **organization view** — the console page that shows all members' turns of
  one organization.

Do not use "remote turn", "cloud turn", or "foreign turn". Use "pulled turn".

## Scope

| Scope | Where | Data source | Turns |
|---|---|---|---|
| Your Insights | Solus desktop, web, and mobile | The machine's `metrics.db`: own turns and pulled turns | Only turns where `user_id` is you, or own turns with no user (signed out) |
| Organization view | solus-cloud console | The workspace service | All members' turns of one organization |

## Design

### 1. Sync endpoint on the workspace service

`GET /v1/insights/sync` (operation `syncInsights`, scope `insights:read`).

- Query: `cursor?`, `limit` (at most 500), `excludeHostId`.
- The service always filters to `user_id = <the caller's user>`. The caller
  cannot read another member's rows with this operation.
- The response is `{ items: InsightTurnRow[], nextCursor }`.
- `InsightTurnRow` has: `hostId`, `traceId`, `sessionId`, `provider`, `model`,
  `origin`, `projectRoot`, `startedAt`, `endedAt`, `durationMs`, `status`, and
  `attrs`. `attrs` holds only the keys that the `turns` view reads (cost,
  tokens, tool count, prompt source, task title, and a prompt preview of at
  most 200 characters). The field registry gives this key list. Do not keep a
  second list by hand.
- **The cursor is the arrival order, not `started_at`.** A host can send a
  turn hours after it started. Add `received_seq` to `insight_spans`
  (increasing, set on insert and on upsert). The cursor is
  `(received_seq, host_id, span_id)`.
- The endpoint is organization-scoped, like the other Insights operations. A
  user in two organizations is synced once for each organization.

### 2. Turn tree endpoint

`GET /v1/insights/:insightId/spans` (operation `getInsightSpans`).

- It returns all spans and log events of one turn.
- A member can read their own turns. The organization view can read every
  member's turns in that organization (this is the same rule as
  `listInsights`).

### 3. Insight sync on the machine

A focused service under `packages/server/src/sync/` (not `SessionRuntime`).

- It runs when a client opens Insights, then each 60 seconds while a client
  shows Insights, and when an organization delegation becomes available.
- It calls the workspace service with the person's delegated token
  (`sync/delegations.ts`). `excludeHostId` is this machine's host id, because
  this machine already has its own turns.
- It upserts each row into `spans` and adds `host_id`. The rows do not pass
  through the exporter, so they are not mirrored back to the cloud.
- It saves the cursor for each organization in `metrics.db`.
- When a row is written, it emits `metrics.turnsChanged`. The open list then
  updates, as it does for own turns.
- Signed out, or with "Send Insights to organization cloud" off: it does
  nothing. Own turns stay as they are now.

### 4. `metrics.db` changes

- Add `host_id` to `spans`. An own span has the machine's host id. An older
  span with no value is an own span.
- Add `host_id` to the field registry, so the views, the schema sheet, the
  question compiler, and SQL can use it.
- Add `user_id` filtering to the turn list: the list shows own turns and
  pulled turns. Pulled turns are always the signed-in user's turns.
- Pulled rows use the same retention as own rows (`rollover.ts`).

### 5. Turn detail

- An own turn opens as it does now.
- A pulled turn: the panel shows the turn row at once. Then it calls
  `getInsightSpans` through the machine, writes the tree into `spans`, and
  draws the waterfall and transcript. The tree is pulled one time only.
- The diff of a pulled turn reads that turn's host. If that host is connected
  to the client, the diff loads from it. If not, the panel shows "Host
  offline" and does not show a spinner.
- Session links and task bindings of a pulled turn use that turn's host, not
  `insightsStore.serverId`.

### 6. Host column and filter

- The turn list and the rail show a **Host** column. The label comes from the
  host directory (`hostRowLabel`). The cloud does not store host names.
- The rail has a **Host** filter: "All hosts" or one host. It adds
  `host_id = ?` to `MetricsTurnFilter`. The totals, chart, and list use the
  same filter.
- Desktop, web, and mobile all get the column and the filter. On mobile, the
  filter is in the existing filter sheet.

### 7. No backfill

Nothing sends old turns. A turn reaches the cloud only when its host mirrors
it, so pulled turns start from the time that each host turned on "Send
Insights to organization cloud". Older turns stay on their own machine.

### 8. Organization view in the solus-cloud console

- A console route `organizations/[organizationId]/insights` renders
  `InsightsPage` from `@solus/workspace-ui`. The console already links that
  package (`scripts/link-solus.ts`).
- The page reads the workspace service through an Insights source that
  implements the same metrics calls as a machine: turn page, totals, volume,
  trace, and session summary. The workspace service answers them from
  `insight_spans`, filtered by the organization.
- The table adds a **User** column and filter.
- The organization view has the SQL console and presets. It has no
  questions: the question compiler needs an agent on a machine, and the
  workspace service has none (decided 2026-10-01).
- **SQL in the organization view runs on Postgres.** The workspace service
  runs it in a read-only transaction, as a role that can read only the
  Insights views, with a row-level security policy on `organization_id`, and
  with a statement timeout. The views have the same names as on a machine and
  do not show `organization_id`. The schema sheet says that the dialect is
  Postgres.

### 9. Removal

Delete `OrganizationTurns.svelte`, `organization-insights.store.svelte.ts`,
`lib/organization-turns.ts`, and the toggle in `InsightsPage.svelte`. Delete
`HostApi.insightsList` and its callers if the console does not use them. Fix
the stale `data/insights/organization-turns.ts` references in
`organization-scope.md` and `plans/008-workspace-http-api.md`.

## Phases

1. **Sync.** `received_seq`, the sync endpoint, the insight sync service,
   `host_id` in `metrics.db` and the field registry. Tests: the cursor does
   not miss a late row, a second run writes nothing new, own host rows are not
   pulled, and another member's rows are never returned.
2. **Client.** Host column and filter on every client, pulled-turn detail, the
   offline diff state, and removal of the Organization toggle.
3. **Organization view.** The workspace-service Insights source, the
   Postgres reporting role and views, and the console route.

## Surfaces

- Clients: desktop, web, and mobile read the same host RPCs. Phase 2 adds the
  column and filter on all three.
- Providers: Claude and Codex turns are both spans. No provider decision is
  needed.
- Connection modes: the machine that the Insights page reads does the sync.
  A web client connected to a remote host sees that host's synced rows.
- Reverse states: turning off "Send Insights to organization cloud" stops the
  sync. Pulled rows stay until retention removes them.
- Stale states: the rail shows the time of the last sync and an error if the
  last sync failed.

## Open questions

1. **Upload cost.** The mirror on each machine (`insight-mirror.ts`) sends
   every finished span with its log events, about 110 MB each month at the
   measured rate. This plan does not change that. The organization view and
   the pulled-turn detail read those trees.
