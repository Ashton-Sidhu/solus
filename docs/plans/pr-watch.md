# Pull request watches

Status: implemented, 2026-10-07. Not yet run against GitHub.

A session can watch one of its linked pull requests. The host reads the pull
request in the background, and when something the agent must act on happens —
a check fails, every required check passes, someone comments or reviews, or the
branch starts to conflict — it wakes the agent with a queued prompt that says
what changed. The agent ends its turn instead of polling `gh` or sleeping.

The model follows T3 Code's PR watch (`apps/server/src/orchestration-v2/
PullRequestWatchReactor.ts` and `pullRequestWatch.ts`, read at `611132c171`),
including the fixes it needed after launch. Two parts differ on purpose:
Solus keeps the watch list in memory so a sweep reads no database, and Solus
reuses its existing pull request reads for everything except a new batched
fingerprint.

## Vocabulary

- **watch** — a session watching one pull request that it links. One row of
  `session_pull_request_watches`. A watch has a `watchId`, new at each start.
- **watcher** — `PrWatcher` (`prs/pr-watcher.ts`), the host service that reads
  watched pull requests and wakes sessions.
- **fingerprint** — a short summary of a pull request that changes when
  anything a watch reports could have changed: its state, head, mergeability,
  check counts by state, and comment and review counts and edit times.
- **watch read** — the full read of one pull request: the pull request, its
  checks, its conversation and its review threads.
- **news** — one thing a watch read found that the agent has not been told:
  `checks-failed`, `checks-passed`, `remarks`, `conflicting`, `closed`.
- **wake** — the prompt the watcher queues on the session with the news.

Do not say "monitor", "babysit", "subscription" or "PR watch job". A watch
belongs to a session, not to a task.

## Decisions

1. **One agent tool.** `watch_pull_request` takes the pull request (URL or
   number) and `watching` (default true). `watching: false` stops the watch.
   T3 Code has two tools (`watch_pull_request`, `unwatch_pull_request`) that
   send one command with a boolean; one tool says the same with less in every
   prompt. The tool links the pull request to the session first when it is not
   linked (source `agent`). It is in the Tasks tool group beside `link`.
2. **Claude and Codex alike.** The tool is a Solus toolbox tool, so both
   providers get it. The "Pull request linking" runtime block gains one
   paragraph: call `watch_pull_request` and end the turn to wait for CI or
   review; do not poll; stop the watch before handing the work back.
3. **A person can watch too.** The linked pull request row on every client
   shows an eye while it is watched and has Watch / Stop watching. A person's
   watch wakes the same agent.
4. **Only an open pull request.** Watching a merged or closed pull request is
   refused. A watch is refused on a settled session.
5. **What wakes the agent** (`prs/pr-watch-rules.ts`, pure):
   - `checks-failed`: a check finished as failure, cancelled, timed out or
     action required. Each failed check is reported once per head, as soon as
     it fails, so a check that never finishes cannot hold back the news. A
     rerun that fails again on the same head is reported again.
   - `checks-passed`: every required check passed (every check when none is
     required), reported once per head. If a required check appears later that
     the agent was not told about, it is reported again.
   - `remarks`: a comment, a review with a body, or a review thread comment
     created or edited after the watch's watermark, by anyone but the viewer
     whose credential reads the pull request (the agent's own account). An
     edited bot comment counts, by its edit time.
   - `conflicting`: the pull request now conflicts with its base. An unknown
     mergeability keeps the last answer.
   - `closed`: the pull request closed without merging. The watch ends.
   A new head resets what was reported about checks.
6. **When a watch ends**, with the reason logged once
   (`pr_watch_ended`):
   - the pull request merged (no wake: the session settles by the pull
     request rule);
   - it closed (wake);
   - 10 wakes in a row brought only remarks, so two bots cannot keep an agent
     busy forever (wake);
   - 8 watch reads in a row failed for a reason other than a rate limit (wake);
   - the session settled, was stopped, or the link was removed;
   - the agent or a person stopped it.
   A rate limit never ends a watch: the read waits for the reset.
7. **Stop stops watches.** A person's Stop ends every watch of the session,
   like it ends the running turn. The agent can start a new one.
8. **The sweep path reads no database.** T3 Code reads every thread with a
   pull request from its projection every 2 minutes, even with no watch. Here
   the watcher loads the watches once at start and then keeps them in memory.
   Every write goes through `data/sessions/pull-request-watches.ts`, which
   emits a change; the watcher reloads only that session's watches. With no
   watch, the watcher's clock does not run.
9. **Writes happen on news.** The stored state changes only when there is news,
   a new head, or a mergeability change. Check progress stays in memory. After
   a restart the first read compares with the stored state, so nothing is
   reported twice and nothing reported is lost.
10. **A stale read cannot undo a stop.** The watcher records a read with the
    watch's `watchId`; the write does nothing when the watch was stopped or
    restarted while the read ran.
11. **Cost.** Each sweep reads the fingerprints of every watched pull request
    of a repository in one GraphQL request (25 pull requests per request, about
    1 point). A watch read happens only when a fingerprint moved, while a check
    is in progress, and every 30 minutes (edits inside review threads are not in
    the fingerprint). Remarks are read only when the remark half of the
    fingerprint moved, or every 30 minutes. Sessions that watch the same pull
    request share one read. Sweeps are background work: they leave GitHub's
    reserve to people and back off on a rate limit
    (`providers/github/request-budget.ts`).
12. **The wake.** `PromptDispatch.promptSession(sessionId, text, 'queue',
    { via: 'pull-request-watch' })`: after the running turn, never inside it.
    The text names the pull request and lists each item with its author, path
    and link, at most 10 items per kind, and comment excerpts of at most 200
    characters with HTML comments removed. It ends with what to do and how to
    stop the watch. Desktop and web label the bubble "Pull request watch", as
    they label a background command.
13. **One host.** A watch is a record of the host that runs the session. It is
    not sent through the delivery queue. A client that reads an organization
    session through the Solus API sees no watch on it.

## Data

`data/sessions/schema.ts`: `session_pull_request_watches` (`session_id`,
`repository`, `number`, `watch_id`, `started_at`, `state` JSON,
`organization_id`), primary key `(session_id, repository, number)`.
Migrations generated with `bun run db:generate`.

`state` is `PullRequestWatchState`: the head it last saw, the failed checks
reported on that head, whether the pass was reported and the required checks it
named, the remark watermark (time and the ids at that time), whether it
conflicts, and the number of remark-only wakes in a row.

`SessionPullRequestLink.watch?: { startedAt: number }` tells clients that the
link is watched.

## Host

- `data/sessions/pull-request-watches.ts` — start, stop, stop all of a session,
  list, record a read (guarded by `watchId`), and the change listener.
  `settleSession` and `unlinkSessionPullRequest` stop the session's watches.
- `prs/pr-watch-rules.ts` — the pure rules: `evaluateWatch` and `wakeText`.
- `prs/pr-watcher.ts` — `PrWatcher`, started by `boot-server.ts`.
- `ReviewProvider.readWatchFingerprints(repo, numbers)` — the GitHub provider
  reads fingerprints in one aliased query. The watch read uses the existing
  `getPullRequests`, `listChecks`, `listComments` and `listReviewThreads`
  through `prIndex`, the index PR sync and the clients share: the pull request
  is seeded, the checks are absorbed, and the conversation is a forced read of
  the entity's fields, so every surface sees what the watch read. Comments,
  reviews and thread comments now carry `editedAt`.
- "Watch" means only this feature. PR sync keeping a link fresh is its
  interest (`readPrLinkInterests`, `readSessionPullRequestInterests`).
- RPC `sessionPullRequestWatch` (`sessionId`, `repository`, `number`,
  `watching`), on the execution plane, editor access. It answers a
  `SessionPullRequestWatchOutcome`. The links change topic,
  `session.pullRequestsChanged`, carries the change.
- A person's Stop is the `stopSession` handler in `boot-server.ts`: it stops the
  session's watches before it stops the turn. A host stop (a plan accepted, a
  run launcher retry) does not.
- `prs/start-pull-request-watch.ts` — the checks a start makes (settled,
  already watching, linked, still open), shared by the tool and the RPC.
- Agent tool `watch_pull_request` (`execution/agents/tools/task-tools.ts`).

## Clients

- **Desktop and web** (shared Svelte): a row of the rail's Linked card
  (`project-panel/LinkedSection.svelte`) shows an eye while the pull request is
  watched, and its tooltip says so. The row's menu has Watch Checks and
  Reviews, or Stop Watching; a merged, closed or missing row offers neither. A
  refused watch shows a toast with the reason (`watchRefusal`). A wake shows in
  the transcript with the "Pull request watch" origin label.
- **Mobile**: the phone has no Linked card. The thread row's pull request badge
  shows an eye when a link of the session is watched. The row's long-press menu
  has Watch #N, or Stop Watching #N for the watched link
  (`presentThreadPullRequests`, `watchRefusalMessage`). A wake shows as a
  message in the thread; the phone has no origin labels for host-sent
  messages yet, for this or for a background command.
- The session sidebar's pull request chips have no watch action; the rail and
  the agent are the two ways in.

## Limits

- Review thread comments past the first 100 of one thread are not read.
- Only GitHub has fingerprints. Another code host would need its own.
