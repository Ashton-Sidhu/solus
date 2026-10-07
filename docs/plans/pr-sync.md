# PR sync — the host keeps pull requests fresh, clients subscribe

Status: implemented, 2026-09-29. §12 lists where the build differs from this plan. Replaces the current pull request read and refresh
code. There are no users, so this plan removes the old code instead of migrating it.

## 1. Why

At startup the desktop app sends about 30 GitHub requests in 3 minutes. After that
it sends about 6 requests every minute (`dev.log`, 2026-09-29). Five of the startup
requests are 404s for pull requests #60 and #65–#68. Those numbers do not exist in
`Ashton-Sidhu/solus`, but about 80 tasks link to them.

The cause is ownership, not one bug. Pull request state is shared, external data.
The host should own it. Today, freshness is decided in six places, and each one
has its own clock and its own idea of "fresh":

| Scheduler | Where | Rule |
|---|---|---|
| Client refresh | `PrsStore` `listenForPrRefresh` | 60 s interval + window focus |
| Client reads | `PrMirror`, `ProjectPrs.backgroundRetryAt` | 30 s stale, 5 min retry |
| Client needs-review | `PrNeedsReviewStore` | 15 min interval |
| Host reconciler + link discovery | `PrReconciler`, `PrLinkDiscovery` | 60 s interval, 1 / 15 / 5 min rechecks |
| Host checks poll | `checks-handlers.ts` | 10 s / 30 s while a review surface is open |
| Host cache | `PrIndex`, `CachedField` | 15 s detail, 30 s list |

Consequences:

- The cost grows with surfaces, devices, and linked tasks, not with repositories.
- A 404 is an error. It is not an answer. Each scheduler finds it again after its
  own backoff.
- The host reads one pull request at a time. One detail read costs 3 requests:
  `pulls.get`, the branch rules, and the approval requirement. The last two are
  facts about the repository, and nothing caches them.
- A task link's snapshot is `prIndex.lastRead` (`readTaskPrLinks`). It is in host
  memory only. After each restart, every linked pull request, also a merged one,
  is unknown, and the clients fetch it again.
- Some reads bypass `PrIndex`: the guide warmer, `persistReviewCheckpoint`, the task
  inbox, the worktree branch lookup, and `pull-request-url.ts`.
- Web and mobile do not subscribe to `pr.checksChanged` or to needs-review. Only
  the desktop runtime wires those subscriptions (`desktop-runtime.svelte.ts:347`).

## 2. Vocabulary

- **PR sync** — the one host service that reads pull requests from the code host.
  No other code calls `provider.review` to read a pull request's state.
- **repository sync** — the part of PR sync for one repository
  (`host/owner/repo`, lowercase). It has one clock.
- **PR record** — what the host knows about one pull request:
  `{ repo, number, result, pullRequest?, observedAt }`.
- **result** — `found`, `missing` (the code host says that it does not exist), or
  `no-access` (the credential cannot read the repository). A network failure is
  not a result. The record keeps its last result.
- **interest** — a reason to keep something fresh. A client or the host declares
  it. With no interest, a repository sync does not run.
- **settled** — a pull request that is merged or closed, or a record that is
  `missing`. A settled record is not read again by number.

Do not use "reconcile", "mirror", "invalidate", or "observe" for this domain after
the change.

## 3. Model

### 3.1 Host: `PrSync` (`packages/server/src/prs/pr-sync.ts`)

One instance per server, made in `boot-server.ts`. It holds one `RepositorySync` per
repository that has interest.

```ts
type PrInterest =
  | { kind: 'repository' }             // list pages, project panel open PRs, palette
  | { kind: 'pull-request'; number: number }
  | { kind: 'branch'; head: string }   // GitSection, mobile navbar, link discovery
  | { kind: 'review'; number: number } // an open review pane: fast tick + check runs
  | { kind: 'needs-review' }

interface RepositorySync {
  records: Map<number, PrRecord>
  byBranch: Map<string, number>
  watermark: string | null             // largest updatedAt seen
  facts: RepositoryFacts               // viewer, permissions, merge methods,
                                       // approval requirement, branch rules
  interests: Map<InterestOwner, PrInterest[]>
}
```

`InterestOwner` is a client connection id or `host:tasks`. A client replaces its
full interest set for a repository in one call. When its connection closes, the
host drops its interest. No release protocol is needed, and a lost release cannot
leak.

`host:tasks` interest comes from the database: `pull-request` for each link on a
task that is not done or dropped and whose record is not settled, and `branch` for
each isolated-checkout session branch of such a task. This replaces
`PrReconciler.watchList` and `PrLinkDiscovery`.

### 3.2 One tick per repository

Each repository sync with interest runs every 60 s. A `review` interest makes it
run every 15 s, and every 10 s while that pull request has a check in progress.
A faster pass reads only the check runs (step 4); the recent list keeps the 60 s
cadence. The first list read asks for 50 rows a page; after a watermark exists,
10 rows a page.

A rate limit from the code host (REST 403 or 429 with
`x-ratelimit-remaining: 0` or `retry-after`, or GraphQL `RATE_LIMITED`) is not
a credential failure: the request does not go to the next credential. The
repository, and every other repository on the same code host, waits until the
reset time that the host gives, or 5 minutes when it gives none.

Every GitHub answer carries its quota in `x-ratelimit-*` headers, and each
account's client records them (`providers/github/request-budget.ts`). A clock
tick is background work: when less than 10% of a quota is left, its requests
stop before they are sent, as if GitHub had answered with a rate limit, so the
rest is left for the requests a person waits on. The process sends at most 8
GitHub requests at once, because GitHub's secondary limits punish bursts. A
repeated REST read sends `If-None-Match`; GitHub answers an unchanged resource
with a 304, which does not count against the quota.

A tick:

1. **Recent changes — 1 GraphQL request.** List the repository's pull requests by
   `UPDATED_AT` descending, in all states, until `updatedAt <= watermark`. Each row
   has the full `PullRequest` fields that the UI draws, with review status,
   mergeable state, head ref, and the check rollup state. This one query replaces
   `pulls.list` + the review status query, the per-number detail reads, branch
   discovery, and the reconciler reads. A reopened or pushed pull request has a new
   `updatedAt`, so it appears here. A settled pull request that does not change
   costs nothing.
2. **Unknown numbers — at most 1 GraphQL request.** Numbers with interest and no
   record are read in one aliased query (`pr60: pullRequest(number: 60)`). GitHub
   answers a number that does not exist with a `null` alias and a `NOT_FOUND`
   error for that path. The other aliases still return data. That pair is
   `missing`.
3. **Branch matching — no requests.** Match session and worktree branches against
   the repository rows already loaded by step 1 and the known-number batch.
   An unmatched branch stays unknown; it does not trigger a `head` lookup.
   Later repository reads can discover its PR. Restarting does not cause one
   request per saved worktree. A branch outside the loaded pages is not proof
   that no PR exists.
4. **Check runs** — only for `review` interest, the existing batched query
   (`listChecks`). Other surfaces use the rollup state from step 1.
5. **Needs review** — only for `needs-review` interest, every 5 min, one search
   request.

Repository facts load once per repository and reload after 1 h or after a write
fails with a permission or merge-rule error. The detail read no longer fetches
branch rules or the approval requirement.

Warm cost for one repository with no changes: **1 request per minute**. The number
of clients, surfaces, and linked tasks does not change this. Today it is about
6 requests per minute (`dev.log`).

### 3.3 Output

After each tick, and after each write, `PrSync` compares the new records with the
old ones: `result`, `updatedAt`, check rollup, and `needsMyReview`. Then it:

- Broadcasts `pr.changed { repo, records }` with the changed records only.
- Writes the snapshot to each task link for the changed pull request (§3.5), then
  calls `emitPullRequestTasksChanged`.
- Calls `completeTasksForMergedPullRequest` for records that became `merged`
  (the current `PrReconciler.completeMerged` rule, busy-session retry included).
- Links a pull request found for a `host:tasks` branch to its task
  (`task.linkPullRequest`, as `PrLinkDiscovery.refresh` does now).

### 3.4 Writes

Every pull request mutation handler (`prMerge`, `prUpdate`, `prSetLabels`,
`prUpdateLifecycle`, auto-merge, reviewers, review, comments) gives the pull
request it gets back to `prSync.apply(repo, pullRequest)`. That broadcasts
`pr.changed`. Head SHA and permission guards read `prSync.readFresh(repo, number)`.
This is the only forced read.

### 3.5 Durable link snapshot

`task_links` gets columns for the last observation: `pr_result`, `pr_state`,
`pr_draft`, `pr_title`, `pr_url`, `pr_updated_at`. `readTaskPrLinks` reads them
from the database, not from `prIndex`. A settled link is never read from the
network again. A `missing` link shows "Pull request not found" with a **Remove**
action. The host never deletes a link by itself: a wrong repository mapping or a
short permission problem must not destroy user data.

`Task.linkPullRequest` already stores the lowercase repository key
(`github.com/owner/repo`) as `target_scope`. Older links can hold a local path
instead. A path changes meaning when its remote changes. That is the probable
cause of the developer's links to #60 and #65–#68, which use
`/Users/sidhu/solus`. PR sync resolves a path scope through the current remote
once per tick and writes the result to the link, so each such link costs at most
one batched read.

### 3.6 On-demand review data

Commits, reviewers, threads, comments, changed files, the diff, and the interdiff
stay request/response reads. Only an open review pane needs them. They are cached
in the host `PullRequest` entity. A `pr.changed` with a new `updatedAt` or head SHA
drops them. The client review pane reloads them on that event. This replaces
`prs.invalidated`.

## 4. Contract changes (`packages/contracts`)

Add:

| Name | Shape |
|---|---|
| `prSetInterest` | `(ctx, interests: PrInterest[]) → PrRepositorySnapshot` — replaces this connection's interest for the ctx repository and returns the known records for it |
| `prRefresh` | `(ctx) → void` — the user's refresh button: runs a tick now |
| `prListPage` | `(ctx, filter, page) → PrListPage` — search, older pages, and filters that the recent window does not cover; rows go into the records |
| `pr.changed` | `{ repo: string; records: PrRecord[] }` |

Remove: `prGetDetail`, `prList`, `prNeedsReview`, `prChecksActivity`,
`prInvalidate`, `prs.invalidated`, `pr.lifecycleChanged`, `pr.checksChanged`.
Also remove `prListProjects`: the all-projects page sends `repository` and
`needs-review` interest for each project and draws the records (§5).
`prGetOverview` stays for the review pane.

Update `host-api.ts`, `rpc-planes.ts`, the preload bridge, and the demo handlers
(`apps/client/src/demo/handlers/pr.ts`) together.

## 5. Client (`packages/workspace-ui/src/contexts/prs/`)

`PrsStore` becomes a copy of the host records. Its keys are
`(serverId, repo, number)`. `prSetInterest` snapshots and `pr.changed` events fill
it. It has no timers, retry maps, stale times, or queue.

- Surfaces call `prs.want(serverId, ctx, interest)` → release. The store combines
  the interests per repository and sends one `prSetInterest` when the set changes,
  with a microtask batch. On reconnect it sends the set again and applies the
  snapshot.
- The store owns its event subscription, so desktop, web, and mobile get the same
  behavior. The runtime wiring in `desktop-runtime.svelte.ts` and `App.svelte` for
  checks and needs-review goes away.
- The Pull Requests page, with one project or with **All projects**, sends
  `repository` and `needs-review` interest for each project it shows, and draws
  the records. Authored and Review requested come from `author` and
  `needsMyReview`. It updates live and costs nothing after it closes. Search and
  older pages use `prListPage`.
- The review pane sends `review` interest for its pull request.
- The session sidebar, `TaskPage`, and `TaskPreviewPane` read the
  link snapshot. They ask for `pull-request` interest only for links that are not
  settled. The host already keeps open task links fresh. The client interest only
  makes the tick run while the row is on screen.

Delete:

- `listenForPrRefresh`, `enqueue`/drain, `refreshObserved`, and the `numbers` /
  `details` / `linkedNumbers` interest shapes in `prs.store.svelte.ts`.
- `ProjectPrs.refreshObserved`, `readBackground`, `backgroundRetryAt`, the listing
  handshake (`beginListing` … `endListing`), and `forgetAll`.
- `PullRequest.loadDetail`, `refreshDetail`, and the list/detail/overview mirrors in
  `pr-mirror.ts`. Keep mirrors only for the on-demand review data in §3.6.
- `PrNeedsReviewStore` polling. The count is derived from records with
  `needsMyReview`.
- `PrChecksStore.reportActivity` and `load`. Check runs arrive as record fields.
- `PrsStore.listProjects`, `listHost`, and the `prListProjects` concurrency and
  priority-row code (server `provider-handlers.ts:156-178`).
- The `prs.invalidated` handlers in `PrsPage.svelte` and `PrReviewPane.svelte`.

Keep `pr-list-memory.ts` (localStorage first paint of the list page). It is
display memory, not a scheduler.

## 6. Server deletions

- `pr-reconciler.ts` and `pr-link-discovery.ts`. Their rules move into `PrSync`
  output (§3.3).
- The polling timer in `checks-handlers.ts` and its per-client activity records.
- `PrIndex` list and needs-review caches and TTLs. `PrIndex` becomes the record
  store inside `PrSync`. This also removes the invalidation bug with mixed-case
  list keys (`pr-index.ts:152`).
- `loadRequiredApprovalCount` in each detail read. It becomes a repository fact.
- Direct `provider.review.getPullRequest` / `listPullRequests*` calls in
  `guide-warmer.ts`, `persistReviewCheckpoint`, `data/tasks/inbox.ts`,
  `worktree-handlers.ts`, `worktree-manager.ts`, and `pull-request-url.ts`. They
  read through `PrSync`.

## 7. Providers

Only GitHub implements `ReviewProvider`. Add two operations and use them only
from `PrSync`:

- `listRecentPullRequests(repo, since) → PullRequest[]` (§3.2 step 1).
- `getPullRequests(repo, numbers) → Map<number, PullRequest | null>`
  (§3.2 step 2).

This is not specific to a provider (Claude or Codex). Agents reach pull requests
through the same RPCs and tools, so both agent backends get the change.

## 8. Tests

New, in `tests/unit/`:

- `pr-sync-cost.test.ts` — with 1, 3, and 20 interest owners on one repository, a
  warm tick makes one list request. A settled record is not read again.
- `pr-sync-missing.test.ts` — five unknown numbers make one batch request. `null`
  becomes `missing`, and later ticks do not ask again.
- `pr-sync-interest.test.ts` — a closed connection drops its interest. With no
  interest the tick stops. `host:tasks` interest follows task status.
- `pr-sync-tasks.test.ts` — a merge found by a tick completes the linked task
  (move the cases from `pr-reconciler.test.ts`). A branch found for a task session
  links the pull request (from `pr-link-discovery.test.ts`).
- `prs-store-sync.test.ts` — the client applies a snapshot and `pr.changed`, sends
  one `prSetInterest` for many surfaces, and sends it again on reconnect.

Delete or rewrite: `pr-reconciler.test.ts`, `pr-link-discovery.test.ts`,
`prs-store-effort.test.ts`, `linked-pr-store.test.ts`, `pr-store-lookups.test.ts`,
`pr-mirror-coalescing.test.ts`, `checks-activity-lifecycle.test.ts`, and the parts
of `pr-index.test.ts` and `pr-entity-commands.test.ts` about refresh.

## 9. Order of work

All five steps are done (2026-09-29). Old code was deleted in the step that
replaced it.

1. Provider reads, host `PrSync`, `task_links` snapshot columns (migration
   `0020_pr_link_snapshot`, postgres `0009`), merge completion from saved link
   state. Deleted `PrReconciler`, `PrLinkDiscovery`, `pullRequestIsMerged`,
   `readActivePrLinkTargets`.
2. Writes go through `PrSync.apply`; one-time reads that went straight to
   GitHub read through `PrIndex`. Deleted `prInvalidate`, `prs.invalidated`,
   `pr.lifecycleChanged`.
3. `prSetInterest`, `prRefresh`, `pr.changed`; client `PrsStore.want`. Deleted
   the client refresh timer, queue, `refreshObserved`, `backgroundRetryAt`,
   `watch`, `watchLinkedPrs`, and the lifecycle subscriptions. Missing links
   show "Not found" on the task page and the preview; Unlink removes them.
4. Checks and needs-review as interests. Deleted the checks poll, per-client
   activity (`prChecksActivity`, `pr.checksChanged`), `prNeedsReview`, the
   needs-review poll, and the desktop and web runtime wiring for both.
5. Docs: `docs/pull-request-list.md`, `docs/session-history.md`, this plan.

Tests: `pr-sync`, `github-pr-sync-reads`, `pr-checks-read`, `prs-store-sync`,
`linked-pr-store`, and the updated PR store, inbox, entity and merge suites.

## 10. Surfaces

- **Clients:** desktop, web, and mobile use the same `PrsStore`. This removes the
  current web/mobile gap for checks and needs-review.
- **Connection modes:** interest is tied to the connection, so local IPC and
  WebSocket work the same way. Two devices on one repository cost the same as one.
- **Reverse states:** `missing` can become `found` if a link changes. A reopened
  pull request leaves `settled` through step 1.
- **Stale:** a record carries `observedAt`. The UI can show the age when a tick
  fails.

## 11. Decisions

1. **Cadence.** 60 s for a repository with interest. 15 s while a review pane is
   open on one of its pull requests, and 10 s while that pull request has a check
   in progress.
2. **All-projects page.** Uses interest like every other surface (§5). One read
   path. It stops costing requests when the page closes.
3. **Missing links.** Shown as "Pull request not found" with a Remove action.
   Never deleted automatically. New links store the canonical repository key.

## 12. Where the build differs from this plan

- **On-demand reads stay.** `prList`, `prListProjects`, `prGetDetail`,
  `prGetOverview` and `prChecks` are reads a person starts: opening a page,
  a pane, a search, the next page. They are not schedulers, and none of them
  caused the startup traffic. They stay, with their client mirrors, so the list
  page, pagination, search and the merge controls keep working as before. What
  was removed is every timer and every refresh a client ran on its own.
- **The list page subscribes and still reads its first page.** It sends
  `repository` interest while open and still reads its first page with
  `prListProjects`. A pushed row updates in place, and a new pull request joins
  the unsearched list at the top. `PrSync` sends no rows for `repository`
  interest in the answer to `prSetInterest`.
- **Pushed rows do not supersede a list read.** `ProjectPrs.absorbSynced` takes
  a pushed row without the revision bump that `applyPullRequest` uses for this
  client's own writes. Otherwise a tick that lands while the first page is on
  the wire would drop that page.
- **Interest is per connection and project**, as `connection#project`, so two
  checkouts of one repository on one client do not replace each other's set.
- **Only three columns** were added to `task_links` (`pr_state`, `pr_draft`,
  `pr_updated_at`). The existing `title` and `url` carry the rest, and the
  repository is parsed from the URL.
- **No `observedAt`.** A failed tick keeps the last answer and waits five
  minutes; the UI does not show the age.
- **Sidebar rows do not ask.** The session sidebar draws the saved link
  snapshot and asks PR sync for nothing; live tasks are already synced from the
  host side. The task page, the project rail and the preview ask for
  `pull-request` interest while they show a link.

- **Sessions own links too** (2026-09-30, `docs/plans/session-pull-requests.md`).
  PR sync no longer writes a task link for a branch it finds. It writes a
  session link with source `branch`, for a session of a live task and for a
  recent session with no task. Interest, the observation write and the merge
  completion read `task_links` and `session_pull_requests`.
