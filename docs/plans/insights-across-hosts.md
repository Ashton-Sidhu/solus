# Insights across hosts

Status: phases 1 and 2 built, 2026-10-01. This plan replaces the Organization toggle on the
Insights page (`OrganizationTurns.svelte`, organization-scope §6.1).

## Decision

1. **Your Insights show your turns from all hosts.** A machine pulls your turn
   rows from other hosts out of the workspace service and writes them into its
   own `metrics.db`. The list, totals, chart, SQL, questions, and saved queries
   then run on that one SQLite database, as they do now.
2. **Only turn rows are pulled with the list.** A full span tree is a separate fetch when the user
   opens a turn from another host.
3. **The organization view is an Observability page in the solus-cloud web
   app.** It reads the mirrored Insights from the shared Postgres and reuses
   the Insights components. The Organization toggle is removed from Solus.

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
- **insight pull** — the step on a machine that reads turn rows from the
  workspace service before it answers a turn-list request.
- **organization view** — the console page that shows all members' turns of
  one organization.

Do not use "remote turn", "cloud turn", or "foreign turn". Use "pulled turn".

## Scope

| Scope | Where | Data source | Turns |
|---|---|---|---|
| Your Insights | Solus desktop, web, and mobile | The machine's `metrics.db`: own turns and pulled turns | Only turns where `user_id` is you, or own turns with no user (signed out) |
| Organization view | solus-cloud console | The workspace service | All members' turns of one organization |

## Design

### 1. Access

No new scope. Both callers use the existing `insights:read`, which reads one
organization.

- The insight pull on a machine always passes `userId` = the signed-in user.
  Solus only ever pulls your own turns.
- The organization view passes no `userId`. It reads every member's turns.
- Add `insights:read` to `DELEGATED_SCOPES` (`sync/delegations.ts`), because
  the machine pulls with the person's delegated token.

### 2. Endpoints

Extend the existing endpoints. Do not add a sync endpoint.

- `GET /v1/insights` (`listInsights`): each item adds `origin`,
  `projectRoot`, and a trimmed `attrs`. No new query parameter. `attrs` holds only the keys that the `turns` view reads (cost,
  tokens, tool count, prompt source, task title, and a prompt preview of at
  most 200 characters). The field registry gives this key list. Do not keep a
  second list by hand.
- `GET /v1/insights/:insightId/spans` (`getInsightSpans`, new) returns all
  spans and log events of one turn. Indexes on `(organization_id, host_id,
  trace_id)` serve it (`drizzle/*/0001_insight_trace_index.sql`).
- **The organization sees what Insights shows today** (decided 2026-10-01).
  Any member of the organization reads every member's rows, with a prompt
  preview, and every turn's full tree. The organization is the boundary. A
  row leaves out the response and the system prompt only to keep the pull
  small; the tree has them.
- No `received_seq` and no saved cursor. Section 3 explains how late turns
  are found.

### 3. Insight pull on the machine

A small function under `packages/server/src/sync/`, not a background service
and not part of `SessionRuntime`.

- A turn-list request (`metricsTurnPage` and `metricsTurnListingSummary`)
  starts a pull and answers at once from the rows that are here. It does not
  wait for the network. At most one pull runs at a time, and a pull is skipped
  when the last one ended less than 30 seconds ago.
- It asks for the time since the newest pulled turn, minus a 6-hour overlap.
  The first pull asks for the last 31 days, the longest window the workspace
  service answers.
- It calls the workspace service with the person's delegated token
  (`sync/delegations.ts`) and `userId` set to that person.
- It writes each row into `spans` with `host_id`, using `INSERT OR IGNORE` on
  `span_id`. The response also has this machine's own turns. They already
  exist in `spans`, so they are ignored and their full rows stay unchanged. A
  turn that was pulled before is also ignored. The rows do not pass through
  the exporter, so they are not mirrored back to the cloud.
- When it writes a new row, it emits `metrics.turnsChanged`. The open list then
  updates, as it does for own turns.
- It skips rows whose `hostId` is this machine's. It pulls for every
  organization that this host sends Insights to (`insightsEligible`), as the
  linked owner, with the owner's delegation.
- `metricsTurnTrace` pulls a pulled turn's tree before it answers, once.
  Code: `sync/insight-pull.ts`, `data/insights/pulled-turns.ts`.
- If the pull fails, the machine answers from the rows it has and reports the
  error with the answer.
- **Loading state.** The listing summary carries `pull: { pulling, error }`,
  and `metrics.insightPullChanged` reports each start and end. While a pull
  runs, a thin sweep runs along the top edge of the turn table; reduced
  motion holds it still. A failed pull shows "Other hosts unavailable" with
  the reason as its tooltip.
- Signed out, or with "Send Insights to organization cloud" off: it does
  nothing. Own turns stay as they are now.
- **Limit:** a turn that reaches the cloud more than 6 hours after it started,
  for example from a host that was offline, is not pulled. If this becomes a
  real problem, add an arrival sequence to `insight_spans` and use it as the
  cursor. The rest of this design does not change.

### 4. `metrics.db` changes

- Add `host_id` to `spans` (metrics migration slot 1). An own span has no
  value; a pulled span has the host that ran it. A null is unambiguous and
  needs no change to the exporter or to old rows.
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
- The change of a pulled turn is not read: the panel says "This turn ran on
  <host>. Git recorded its change there." It shows no spinner. Reading the
  change from that host while it is connected is not built.
- "Open session" on a pulled turn opens it on that turn's host when this
  client knows the host (`uplink.hostId`); otherwise it says the client is
  not connected to that host. The task binding is not read for a pulled
  turn.

### 6. Host column and filter

- The turn list and the rail show a **Host** column. The label comes from the
  host directory (`hostRowLabel`). The cloud does not store host names.
- The table header and the rail's Filters menu have a **Host** filter: "All
  hosts" or one host. It shows only when the window has turns from more than
  one host. `MetricsTurnFilter.hostId` is absent for every host, null for the
  host being read, and a host id for a pulled host. The totals, chart, and
  list use the same filter; `MetricsTurnListingSummary.hosts` lists the
  choices without the host filter applied.
- The column is sortable (`host` sorts by the recorded machine name). Labels:
  the host being read by its own name; a pulled host by the name in the
  account directory, then the recorded `hostname`, then a short id
  (`lib/turn-hosts.ts`).
- Desktop, web, and mobile all get the column and the filter. On mobile, the
  filter is in the existing filter sheet.

### 7. No backfill

Nothing sends old turns. A turn reaches the cloud only when its host mirrors
it, so pulled turns start from the time that each host turned on "Send
Insights to organization cloud". Older turns stay on their own machine.

### 8. Organization view: Observability in solus-cloud

Decided 2026-10-01: the organization view is an **Observability** page in the
solus-cloud web app, `organizations/[organizationId]/observability`. It is a
version of the Insights page, not a mount of `InsightsPage`.

- **Data.** The console and the workspace service share one Postgres. The
  mirror already fills `insight_spans` and `insight_log_events`, so the page
  reads them directly in the console's server code. It does not call the
  workspace service. Every read checks that the caller is a member of the
  organization and filters by `organization_id`.
- **What it shows.** What the Insights page shows today, for every member:
  the time range, totals, the volume chart, the turn table with search,
  status, Host, and User filters, sorting and paging, and a turn's waterfall
  and transcript.
- **Reused components.** `TurnList`, `VolumeChart`, `TraceWaterfall`,
  `TurnTranscript`, and `TimeRangePicker` take everything through props, and
  the console already mounts Solus components with one Svelte runtime. The
  page reuses them from `@solus/workspace-ui`. The queries are Postgres copies
  of `turn-page.ts`; the trace timing is a copy of the server's. Duplication is
  accepted (decided 2026-10-01).
- **Not in the first version: the SQL console.** The shared Postgres also
  holds accounts and sessions, so free SQL needs a read-only role limited to
  the Insights views by row-level security. That is phase 3b and needs a
  database role, which the console's migrations do not create today.

### 9. Removal

Delete `OrganizationTurns.svelte`, `organization-insights.store.svelte.ts`,
`lib/organization-turns.ts`, and the toggle in `InsightsPage.svelte`. Delete
`HostApi.insightsList` and its callers if the console does not use them. Fix
the stale `data/insights/organization-turns.ts` references in
`organization-scope.md` and `plans/008-workspace-http-api.md`.

## Phases

1. **Pull.** `insights:read` on the delegated token, turn-row fields on
   `listInsights`, the `getInsightSpans` endpoint, the insight pull, and `host_id` in `metrics.db`
   and the field registry. Tests: a second pull writes nothing new, a turn
   inside the overlap is found, an own turn is not changed by its pulled
   copy, and the pull writes only the signed-in user's turns.
2. **Client.** Host column and filter on every client, pulled-turn detail, the
   offline diff state, and removal of the Organization toggle.
3. **Organization view.** The Observability page in solus-cloud: Postgres
   reads, reused Insights components, sidebar entry.
3b. **Organization SQL.** A read-only reporting role with row-level security,
   and the SQL console on the Observability page.

## Surfaces

- Clients: desktop, web, and mobile read the same host RPCs. Phase 2 adds the
  column and filter on all three.
- Providers: Claude and Codex turns are both spans. No provider decision is
  needed.
- Connection modes: the machine that the Insights page reads does the pull.
  A web client connected to a remote host sees that host's pulled rows.
- Reverse states: turning off "Send Insights to organization cloud" stops the
  pull. Pulled rows stay until retention removes them.
- Stale states: the rail shows an error when the last pull failed.

## Open questions

1. **Upload cost.** The mirror on each machine (`insight-mirror.ts`) sends
   every finished span with its log events, about 110 MB each month at the
   measured rate. This plan does not change that. The organization view and
   the pulled-turn detail read those trees.
