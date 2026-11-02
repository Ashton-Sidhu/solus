# Data model validation

Source baseline: `c4c64aff2`, with the current working tree, 2026-11-01.
This is design evidence, not an implemented schema or an application benchmark.
Only files under `plans/` changed. No live databases or servers were used.

## Thread model: model PASS; integration NOT TESTED

Root independently reran the four saved scripts below after reviewing the
worker's fixtures. Run from the repository root:

```sh
bash plans/data-model-validation/thread-sqlite-model.sh
bash plans/data-model-validation/thread-sqlite-order.sh
bash plans/data-model-validation/thread-reducer-checks.sh
bash plans/data-model-validation/thread-payload-benchmark.sh
```

Results: 47 main SQLite model assertions, three two-connection SQLite allocation
assertions, and eight checks of actual TypeScript reducer/client reconciliation
functions. All 58 passed. The first worker harness attempt had a placeholder-count
error before assertions; the corrected saved scripts passed both worker and root
runs. Scripts use in-memory SQLite, not production files. The reducer script
imports actual source without starting the application or test preload.

The model covers ordering, task duplicate replay, scoped external identities,
unpublished-only deletion, pending selection/acknowledgement, stale version
rejection and command reapplication, independent thread updates, resolve-all,
private/external state separation, deletion versus move, and plan index rebuilds.
The two-connection check demonstrates a SQLite write lock and a successful retry;
it does not prove that application retry handling exists.

### Measured payload and query shape

Root run: Python 3.14.5, SQLite 3.53.1, arm64, Bun 1.3.14.
Median of five batches of 200 changing edits in memory:

| Threads | Whole-list JSON | Single-thread JSON | Whole-list serialization + SQL | Single-thread serialization + SQL |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1,220 bytes | 1,218 bytes | 4.05 µs | 3.95 µs |
| 10 | 12,191 bytes | 1,218 bytes | 22.71 µs | 3.91 µs |
| 100 | 121,991 bytes | 1,218 bytes | 201.94 µs | 3.92 µs |

These are logical serialized payloads, not physical writes, WAL bytes, network
latency, or end-to-end performance. The timing fixture uses simple tables and
excludes normalized index maintenance, parent updates, authorization, reads,
events, response reconstruction and transaction commits. Do not infer a 50× or
100× application speedup. Resolve-all still updates every open thread: at 100
threads it touches 100 rows rather than one document. Full-list responses remain
O(number of threads) unless separately changed.

All five model EXPLAIN queries used keyed searches without temporary sorting:
ordered work threads, ordered task comments, pending task delivery, thread CAS,
and scoped external identity. These are synthetic SQLite plans only.

### Corrected proposed schema

Replace `task_comments` and `work_annotations` with `comment_threads`; retain
`plan_annotations` without its comment array. Store explicit external-comment
state on `works`. Three current tables become two: net −1.

Thread identity is `(organization_id, subject_kind, subject_id, subject_part,
thread_id)`, all non-null. Store body, typed author, source, task provenance,
creation/update time, review position, mutation version, delivery state, external
identity and a specific review payload containing anchors/replies/read/resolution.
The fixture `subjects` table represents fields on existing parents, not a new
production table. Do not introduce it as another registry.

Required corrections to the initial proposal:

1. Task ordering remains `(created_at, id)`; work/plan ordering remains explicit
   list position. Use separate matching indexes.
2. Allocate review positions by atomically advancing an existing parent counter
   and inserting in the same transaction. No unprotected `MAX()+1`.
3. External uniqueness includes provider/account/site/target scope. Relinking
   must not collide with IDs from the previous provider target.
4. Keep task `private/pending/sent` separate from external work operation receipts
   containing `sending/failed/uncertain`, request IDs and results. Never repeat an
   external mutation merely because a database CAS retries.
5. Distinguish thread mutation version, external-state version, provider-link
   generation, and a parent collection revision for ordering full responses.
   Format version `1` and millisecond timestamps are not concurrency tokens.
6. Plan threads belong to durable annotation identity, not the rebuildable plan
   index. Work moves retain comments; task moves remove source comments.

The corrected design has one fewer table but one more logical key/index structure
than the current three-table group. This is justified by actual ordering and
pending-delivery queries, not by a claim that fewer tables always means less I/O.

### Integration gates still open

The scripts do not test new application persistence, PostgreSQL concurrency,
authorization, cross-host transfers, outbound delivery/recovery, physical I/O,
RPC/event/client version handling, or collection-revision rejection of reordered
responses. The proposed collection revision is not present in the saved model.

Convert whole-array mutation callers in `data/works/work-annotations.ts`,
`annotations/comment-tools.ts`, and `transport/handlers/history-handlers.ts` to
commands or checked batches. A stale snapshot diff can still delete a newer
thread. Reapply reply commands after CAS conflict; concurrent prose edits require
an explicit conflict policy. Preserve reducer permission checks, mentions and
parent revisions transactionally. Avoid extra large external-state columns in
ordinary work metadata projections. Preserve explicit polymorphic deletion and
move rules when replacing task FK cascades.

Before implementation approval, add disposable PostgreSQL two-connection tests,
external-send failure/relink tests, and full client stale-response tests. The
current result supports the storage choice; it does not close these gates.

## Relationship model

Corrected SQLite prototype: PASS. Join-only session candidate query: REJECTED.
Application integration and PostgreSQL: NOT TESTED. Root reviewed and reran the
worker's final executable scripts:

```sh
bash plans/data-model-validation/relationship-semantics.sh
bash plans/data-model-validation/relationship-benchmark.sh
```

The saved root outputs are `relationship-semantics-result.json` and
`relationship-benchmark-result.json`. There are 44 semantic checks, 27 comparisons
of candidate result sets and order, and three write-count checks: **74 substantive
checks passed**. Printed assertion totals are 83 because the benchmark also
compares the baseline query with itself nine times. Do not count those as new
proof. One negative control deliberately confirms that the initial numeric-only
sort differs from current task-link ordering; the corrected sort then passes.

### What the fixtures establish

* Direct task links take precedence over newer inherited session links; references
  contribute no PRs. Final ordering preserves text-sorted direct PR keys and
  numerically sorted inherited PR numbers at equal timestamps.
* Dismissed PRs stay dismissed on branch discovery. Explicit linking can revive
  them. Stop/restart/unlink preserve watch generation guards and actor identity.
* Removing an adopted output does not recreate it on repeated session binding.
  Claimed outputs survive departure; unclaimed outputs leave with their session.
* Work origin remains in the access union even when visible membership is removed.
  This is not a test of the complete application access policy.
* Organization and source-authority observations stay separate. Partial canonical
  PR identity and mismatched observation foreign keys are rejected.
* One active working task owner is enforced by a partial unique index. Historical
  owners and references do not prevent a valid ownership transfer.
* Unresolved path targets retain their raw identity. Attaching canonical observation
  identity to one path does not silently merge another path.
* Observation updates and candidate-bit changes roll back together. Title-only
  changes update no candidate bits.

### Read benchmark and required correction

Environment matches the thread run. Each of nine datasets has 10,000 sessions
with 26-character text IDs and 10,000 PR links. Fanouts are 1, 10 and 100;
distributions are all closed, one observation open, and all unknown. The query
combines ten recent sessions with PR candidates, orders by ID and limits to 200.
It isolates the candidate predicate; it does not reproduce the production query's
full ACL, activity ordering, user preferences, transport or rendering.
Two warmups precede 15 rotating read trials. ANALYZE ran. All data is in memory.

Root median milliseconds:

| Links per PR | State distribution | Current | Join-only | Cached candidate bit |
| ---: | --- | ---: | ---: | ---: |
| 1 | Closed | 0.9311 | 10.0633 | 0.8479 |
| 1 | One open | 0.9914 | 9.9931 | 0.8964 |
| 1 | Unknown | 0.0720 | 0.2078 | 0.0697 |
| 10 | Closed | 0.9572 | 7.9616 | 0.8560 |
| 10 | One open | 1.0858 | 7.9877 | 1.0166 |
| 10 | Unknown | 0.0755 | 0.2085 | 0.0732 |
| 100 | Closed | 0.9281 | 7.5065 | 0.8444 |
| 100 | One open | 1.2345 | 3.7621 | 1.1624 |
| 100 | Unknown | 1.5970 | 3.7504 | 1.5019 |

Reject the join-only candidate path: its median was approximately 2.3–10.8 times
the current query in this run. A materialized candidate-set alternative also
regressed, particularly when many observations were unknown. The corrected bit
removed the large regression on all nine datasets; its small advantage over the
baseline is not evidence of a general production speedup.

Keep a derived `keeps_session` integer on active session PR links. It is true
when the selected authority's observation is unknown or not ended. Index exactly:

```sql
CREATE INDEX resource_links_open_session
ON resource_links(owner_id, organization_id)
WHERE keeps_session = 1;
```

The hot EXISTS query matches owner_id, organization_id and `keeps_session = 1`.
A CHECK must restrict a true bit to active session PR links; constrain the bit
to non-null 0/1. The measured query uses a covering partial-index search. Adding
redundant subtype predicates changed SQLite's index choice in earlier attempts;
recheck EXPLAIN if changing either predicate or index order.

### Write tradeoff

Forty rotating transactional write/rollback trials followed five warmups.
With F links to one PR, a title update changes **F → 1** rows. Closing an open or
unknown PR changes **F → F+1** rows, because candidate bits still need updating.
At fanout 1, root median close time was 0.0046 ms current versus 0.0083 ms new;
at fanout 100 it was 0.1721 versus 0.1649 ms. These are RAM tests without fsync,
PostgreSQL roundtrips, notifications or replication. The design saves repeated
full observations, not every fanout write. No index-count reduction is proven.

Observation and candidate updates must share one transaction. Link creation,
revival, resolution and authority changes must serialize with observation changes
on the same observation identity, before deriving the bit. A foreign key and a
transaction around only one writer do not prove this concurrent invariant.

### Corrected model and integration gates

Use `resource_links` plus `pull_request_observations`. Retain raw target scope/key
separately from nullable canonical PR repository/number. Observations are keyed by
organization, source authority, repository and positive PR number. Authority keys
describe visibility context, never tokens. Keep watch fields together; retain
generation guards, task output ownership, dismissal state, provenance, and the
partial active-working-owner constraint. Session target scope must have one
canonical spelling so uniqueness cannot be bypassed with scope aliases.

Keep work origin on the existing work row (currently `session_id`; the proposal
calls it `origin_session_id`) and visible memberships as edges. Deduplicate direct
versus inherited PRs before final ordering. A stable tie-break for indistinguishable
inherited copies is a new deterministic choice, not proof of the old unspecified
tie order. Do not silently canonicalize or merge unresolved references.

NOT TESTED: two raw aliases resolving to the same canonical target with conflicting
pins/titles/provenance; concurrent observation versus link changes; concurrent
ownership transfers; PostgreSQL execution plans; the full application session-list
query; RPC integration; complete authorization and cross-host behavior. Resolve
the alias collision policy and run disposable PostgreSQL tests before implementation
approval. No permitted PostgreSQL endpoint was configured; none was contacted.

Source correction: `task_session_links.pr` and `tasks.pr` are still written by
`data/tasks/task.ts:634` and `:639`. Their legacy label does not mean they are dead.
The first-stage plans do not remove them. A later relationship implementation must
replace those callers explicitly before removing the fields.

## Session identity merger

Fixture: `session-merge-fixture.ts` (`bun run`, bun:sqlite, in memory; 5,000
sessions). Run 2026-11-01. Verdicts: records + states + leads PASS; plus
admissions CONDITIONAL and adopted (admission id equals the Solus session id;
`admit` needs a same-owner `DO UPDATE` arm); plus `transcript_index` FAIL (the
index row is keyed by provider thread id, 1:N per session). Query parity held on
`readSessionListPage`, `settleSessionsWithEndedPullRequests`,
`liveSessionBranches`, `settledSessionIds`, lead and admission lookups, with no
new SCAN or TEMP B-TREE. Per-row write cost moved by under 1 µs either way.
PostgreSQL, the live runtime and the `viewed_at` move were not exercised. The
full column list, idempotent statements and invariants are in plan 029 §4.2.

## Combined decision

The six first-stage implementation plans target 74 → 67 logical tables. The
corrected relationship model replaces four remaining relationship tables with two
(the watch table was already removed), and threads remove one more: **67 → 64**.
These are model-supported candidates, not implemented reductions. The session
identity merger (above) later passed fixture validation and is adopted in plan
029, giving the 62-table target.

The requested model checks are complete. Integration gates remain open and are
not waived by the passing fixture totals. First-stage implementation, relationship
implementation and thread implementation are all still TODO.
