# Host-backed pull request reading

## Decision

Opening a pull request is a read-only provider operation. It does not create or
refresh a local worktree.

The review route owns a `PrReviewTarget`, which identifies the host repository,
pull request number, and exact head revision. A separate `PrCheckoutContext`
exists only after a source-dependent action requests it, or after the user asks
for a checkout.

## Provider path

- `prOpenReview` returns the host target.
- `prGetDiff` returns complete-file patch slices and rejects a stale head SHA.
- `prGetDiffFileContents` reads omitted source context at the requested revision.
- Both accept an optional commit SHA that scopes the read to one commit of the
  change. A commit-scoped read compares against the commit's parent, not the PR
  base, and skips the base staleness check: a commit is content-addressed, so
  its diff cannot change under its key. Inline commenting is disabled while a
  commit is scoped because comment anchors belong to the full head diff.
- `prPrepareCheckout` creates or reuses the deterministic PR worktree.
- `prCheckoutInRepo` moves the project's own repository to the pull request's
  branch. It re-reads the pull request, rejects a stale head, and fetches the
  exact head first.
- Pull request detail includes provider capabilities and the connected viewer's
  permissions. Controls use both sets instead of assuming GitHub access.
- Lifecycle and reviewer RPCs close, reopen, mark ready, convert to draft, and
  request or remove reviewers without creating a checkout.

These methods use the shared RPC registry, so desktop IPC and remote WebSocket
clients use the same contract.

## Checkout rules

Activity, threads, the host diff, draft comments, and review submission do not
need a checkout. Agent chat, fix sessions, guide generation, stacked own-delta,
and since-review calculation do need one.

Checkout requests are deduplicated by host, repository, pull request number, and
head SHA. A reusable checkout must be clean and must resolve to the requested
head. Dirty or locally advanced worktrees are preserved and cause only the
requesting action to fail; the host review remains readable.

The review surface also shows a checkout control, so the user does not have to
start a source-dependent action to get a checkout. It offers two destinations:

- **A separate worktree** — first and recommended. It reuses the existing
  checkout or the deterministic PR worktree, and does not change the project the
  review was opened from.
- **The current repository** — a second menu row with a confirmation step,
  because it moves one working copy to a different branch.

A checkout in the current repository never stashes, resets, or rewrites local
work. The host refuses it when the repository is dirty or conflicted, when the
head is stale, or when another worktree already holds the branch, and it reports
which condition blocked the request. After a successful checkout the client
activates a tab that already matches the repository, or opens a new draft there.
It never moves a live provider session.

## Stale data

Provider diff requests and review submissions carry the displayed head SHA. If
the pull request moves, the server rejects the action and asks the user to
refresh. Renderer diff state is keyed by server, project, pull request, and head
revision, so a late response cannot attach to a newer review target.

Merge and lifecycle actions also carry the displayed head SHA. The server checks
the current permission and repository merge-method configuration before it sends
the provider mutation.

Successful lifecycle, merge, and reviewer mutations return canonical provider
state. The initiating client patches its local PR state and cache from that
result instead of refreshing Activity. These commands do not publish the broad
`prs.invalidated` event. Other clients converge through normal focus, polling,
or explicit refresh paths.

## Current scope

GitHub is the first provider. Desktop-local and remote web use the same backend
and transport contracts. A complete mobile PR review surface remains a separate
product milestone.
