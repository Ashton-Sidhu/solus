# GitHub checks API surface & polling budget (WS1)

Research resolution for issue #14. Answers design-doc open question 4 and pins the
`PrChecksSummary` shape for the Wave 0 contracts. Solus authenticates with a **classic
OAuth device-flow token scoped `repo project`** (`src/main/providers/github/auth.ts`),
so every readability claim below is evaluated against that token class first.

---

## 1. Endpoint set

### Check runs (GitHub Actions, most CI apps)

`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`

- `ref` = the PR's `headSha` (already fetched by `getPullRequest` in
  `src/main/providers/github/provider.ts`). Never poll by branch name — a force-push
  would silently re-point the results.
- `filter=latest` (default) returns only the most recent run per check suite —
  exactly what a green/red rollup wants. `per_page=100`; paginate (rarely needed —
  >100 distinct check runs on one commit is a monorepo pathology).
- Each run: `status` (`queued` | `in_progress` | `completed` | `waiting` | `requested`
  | `pending`) and `conclusion` (`success` | `failure` | `neutral` | `cancelled` |
  `skipped` | `timed_out` | `action_required` | `null` while running).
- Auth: "OAuth app tokens and personal access tokens (classic) need the `repo` scope
  to use this endpoint on a private repository." — works with Solus's token as-is.

### Commit statuses (legacy Statuses API — Jenkins, external CI, bots)

`GET /repos/{owner}/{repo}/commits/{ref}/status` (combined, singular)

- One call returns a pre-computed `state`: `failure` "if any of the contexts report
  as error or failure", `pending` "if there are no statuses or a context is pending",
  `success` "if the latest status for all contexts is success" — plus the latest
  status per context in `statuses[]`.
- Covered by `repo` scope (`repo:status` is the narrower subset).
- **Both surfaces are needed.** Check runs and commit statuses are disjoint systems;
  a repo can gate merges on either or both. GitHub's own PR page merges them, and so
  must we.

### Required checks — three routes, very different readability

| Route | Endpoint | What a classic `repo`-scoped token gets |
|---|---|---|
| Branch protection (legacy) | `GET /repos/{o}/{r}/branches/{branch}/protection` (or `.../protection/required_status_checks`) | **Admin-only in practice.** Fine-grained mapping is repository **Administration (read)**; non-admin callers get `403 "Resource not accessible by personal access token"` (org repos) or `404` (branch not protected / no visibility). The `repo` scope does not help — the *user's role* gates it. |
| Repository rulesets | `GET /repos/{o}/{r}/rules/branches/{branch}` | **Readable with plain read access** (fine-grained mapping: **Metadata (read)**). Returns active rules only (rulesets in `evaluate`/`disabled` enforcement are omitted), including `required_status_checks` rule parameters. **Does not see legacy branch protection** — rulesets only. |
| GraphQL `isRequired` | `CheckRun.isRequired(pullRequestId:)` / `StatusContext.isRequired(pullRequestId:)` on the head commit's `statusCheckRollup.contexts` | **Readable by anyone who can view the PR.** GitHub computes required-ness server-side across *both* legacy protection and rulesets and exposes it per-context. This is what `gh pr checks` uses (cli/cli `api/queries_pr.go`), and it works for non-admin contributors. |

**Consequence — the `unknown` state.** Over REST alone, a non-admin on a repo using
*legacy* branch protection cannot learn which checks are required (protection GET is
403, rulesets GET doesn't cover legacy protection). GraphQL `isRequired` closes that
gap for any viewer. So `unknown` requiredness only remains when:

1. the GraphQL query itself fails (older GHES schema, partial outage) and the REST
   fallbacks above are exhausted (protection 403 + empty rulesets), or
2. contexts overflow the `first: 100` page and we choose not to paginate.

Treat `403`/`404` from the protection endpoint as "requiredness unknown via this
route", never as "no required checks".

### Coarse gate signal, already free

`PullRequest.mergeStateStatus` (GraphQL: `BEHIND` | `BLOCKED` | `CLEAN` | `DIRTY` |
`DRAFT` | `HAS_HOOKS` | `UNKNOWN` | `UNSTABLE`) ≈ REST `pulls.get` `mergeable_state`,
which the provider **already reads** into `PullRequestDetail.mergeStateStatus`.
`BLOCKED`/`UNSTABLE` means "GitHub itself won't merge yet" without knowing *which*
check blocks — a correct-by-construction fallback for WS2's gate-on-green whenever
per-check requiredness is `unknown`. No preview header needed on current GHEC.

### GraphQL bulk query (the batch poll)

One query fetches the rollup for N PRs:

```graphql
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 30, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        mergeStateStatus
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state                       # SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name status conclusion detailsUrl startedAt completedAt
                      isRequired(pullRequestNumber: $prNumber)   # per-node; see note
                    }
                    ... on StatusContext {
                      context state targetUrl createdAt
                      isRequired(pullRequestNumber: $prNumber)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

(`isRequired` needs the PR id/number; in the bulk form pass it per-PR via aliased
`nodes(ids: [...])` sub-queries or accept one query per PR for the required split —
still cheap, see §4. `statusCheckRollup` already merges check runs *and* commit
statuses, so GraphQL is one surface instead of two.)

**Point cost:** cost = unique connection requests ÷ 100, rounded, minimum 1. The
query above is 1 (pullRequests) + 30 (commits) + 30 (contexts) = 61 requests →
**~1 point** for all 30 PRs. Node count ≈ 30 × (1 + 100) ≈ 3,030 — nowhere near the
500,000-node cap. Thirty equivalent REST polls cost ≥ 60 requests.

---

## 2. Recommended `PrChecksSummary` shape (Wave 0 contract)

```ts
/** Rollup over required checks when requiredness is known, over all checks otherwise. */
export type PrChecksState = 'pending' | 'passing' | 'failing' | 'unknown'

export interface PrCheckItem {
  /** Check-run name or status context string — unique key within its kind. */
  name: string
  /** Check runs and commit statuses are disjoint API surfaces; keep the origin. */
  kind: 'check_run' | 'status'
  /** Normalized live state. 'expected' = protection wants it but nothing reported yet. */
  status: 'queued' | 'in_progress' | 'completed' | 'expected'
  /** Null while running. Statuses map: error|failure→'failure', pending→null, success→'success'. */
  conclusion:
    | 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped'
    | 'timed_out' | 'action_required' | 'stale'
    | null
  detailsUrl: string | null
  completedAt: string | null
}

export interface PrChecksSummary {
  /** Commit the checks were read for. Discard the summary when the PR head moves. */
  headSha: string
  state: PrChecksState
  /** Split by GraphQL isRequired; both empty + requiredness 'unknown' = nothing readable. */
  required: PrCheckItem[]
  optional: PrCheckItem[]
  /** 'unknown' ⇒ the required/optional split is unreliable; WS2 must gate on
   *  mergeStateStatus (BLOCKED/UNSTABLE) instead of the split. */
  requiredness: 'known' | 'unknown'
  /** Coarse GitHub-side merge gate (CLEAN | BLOCKED | UNSTABLE | …) — the fallback signal. */
  mergeStateStatus: string | null
  /** Poll bookkeeping: staleness display + ETag/cache reuse. */
  fetchedAt: string
}
```

State derivation (mechanical, per binding principle "mechanical over inference"):

- scope = `required` if `requiredness === 'known'` and `required.length > 0`, else all items;
- any scoped item with `conclusion ∈ {failure, timed_out, action_required, cancelled, stale}` → `failing`;
- else any scoped item not `completed` (incl. `expected`) → `pending`;
- else at least one scoped item → `passing`;
- else (no items at all and rollup absent) → `unknown`. `neutral`/`skipped` count as passing, matching GitHub's merge-box behavior.

---

## 3. Polling recommendation

**Activity-gated polling (recommended, matches the design doc's lean).**

- **No idle polling.** Refresh on demand when the PR list surface mounts/regains focus.
- **While Review Mode or the merge queue is active:**
  - **Bulk (all open PRs):** one GraphQL rollup query every **60 s** (~1–2 points).
  - **Focused PR (the one on screen / at the head of the merge queue):** REST
    `check-runs` + combined `status` every **15–30 s** with **`If-None-Match`** using
    the stored ETag. "Making a conditional request does not count against your
    primary rate limit if a `304` response is returned and the request was made while
    correctly authorized" — so unchanged polls are free; only real transitions bill.
  - **Requiredness:** resolve once per (PR, headSha) via GraphQL `isRequired` (or the
    rulesets endpoint as REST fallback), cache it; re-resolve on head move or a
    ≥10 min TTL. Requiredness changes are rare; check outcomes are not.
- **Stop conditions:** PR merged/closed, checks summary reaches a terminal state
  (`passing`/`failing` with nothing `pending`) — then drop to the 60 s bulk tick only.
- Store the ETag + last summary per (PR, headSha); GraphQL has **no** conditional
  requests, which is fine because its whole-fleet poll already costs ~1 point.
- Caveat flagged for WS1 implementation: docs promise ETags on "most endpoints";
  empirical verification of stable ETags on `/check-runs` specifically was not
  possible in this environment (sandboxed `gh api` blocked) — verify during WS1 and
  fall back to unconditional GETs at the bulk cadence if the ETag churns per-request.

**Why not poll-everything-always:** 30 PRs × 2 REST calls at 60 s = 3,600 req/hr =
72 % of the entire 5,000 req/hr budget that the token shares with every other Solus
feature (PR list, threads, files, reviews). Even ETag-optimized, worst-case (busy CI)
approaches that. Gated GraphQL polling costs ~1–2 % of a *separate* budget.

---

## 4. Rate-limit budget table

Verified limits: REST primary = **5,000 requests/hr** per authenticated user (shared
across all apps acting for that user); GraphQL = **5,000 points/hr** per user,
tracked separately from REST; REST secondary = ≤ 900 points/min (GET = 1 pt) and
≤ 100 concurrent. Authorized 304s are free.

| Strategy (30 open PRs) | Cost per poll | Interval | Hourly cost | Budget share |
|---|---|---|---|---|
| (a) REST poll-everything, no ETag | 60 GETs | 60 s | 3,600 req | 72 % of REST — unsafe |
| (a) REST poll-everything, no ETag | 60 GETs | 3 min | 1,200 req | 24 % of REST — tolerable ceiling |
| (a) REST + ETag, quiet CI (all 304) | 60 GETs → 304 | 60 s | ~0 req | free, but worst case ≈ row 1 |
| (b) GraphQL bulk, gated on Review Mode | ~1–2 pts | 60 s | ≤ 120 pts | ~2 % of GraphQL |
| (b) + focused-PR REST w/ ETag | 2 GETs (mostly 304) | 20 s | ≤ 360 req worst-case, ~0 typical | < 8 % of REST worst-case |
| Requiredness resolution | 1 pt or 1 GET per (PR, headSha) | on head move | ~30–60/hr worst | noise |

**Recommendation: (b) activity-gated** — GraphQL bulk at 60 s while Review Mode /
merge queue is active, focused-PR REST+ETag at 15–30 s, no idle polling. Leaves
> 90 % of both budgets for the rest of Solus and degrades gracefully (bulk query
alone still yields correct summaries if the ETag fast path is unavailable).

---

## 5. Citations

- Check runs for a ref (params, scopes, status/conclusion enums, 1000-suite cap):
  https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference
- Combined status for a ref (state computation, `repo:status`):
  https://docs.github.com/en/rest/commits/statuses?apiVersion=2022-11-28#get-the-combined-status-for-a-specific-reference
- Branch protection GET (+ `required_status_checks` payload):
  https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28#get-branch-protection
- Rules for a branch (active rulesets only, hypothetical branch names OK):
  https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28#get-rules-for-a-branch
- Fine-grained permission mapping (protection → Administration:read; rules/branches →
  Metadata:read; commit statuses → Commit statuses:read):
  https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- Non-admin 403 on protection GET (community confirmation):
  https://github.com/orgs/community/discussions/153722
- REST rate limits (5,000/hr primary; 900 pts/min + 100-concurrent secondary):
  https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- Conditional requests — authorized 304s don't count:
  https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate
- GraphQL point formula (Σ connection requests ÷ 100, min 1), 5,000 pts/hr,
  500,000-node cap:
  https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api
- `isRequired(pullRequestId/pullRequestNumber)` on `CheckRun`/`StatusContext`
  (schema): https://raw.githubusercontent.com/octokit/graphql-schema/master/schema.graphql ·
  precedent in `gh pr checks`: https://github.com/cli/cli/blob/trunk/api/queries_pr.go
- Combining check runs + statuses into one PR verdict (background):
  https://dev.to/gr2m/github-api-how-to-retrieve-the-combined-pull-request-status-from-commit-statuses-check-runs-and-github-action-results-2cen
