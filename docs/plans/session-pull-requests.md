# Session pull requests

Status: implemented, 2026-09-30. Task 01M3AZ4M9Z4YNKD6TGDY2300B0.

> **2026-11-10.** [Provider-owned tasks](provider-owned-tasks.md) replaced the
> task model. GitHub and Jira own every task; Solus has no local task, no task
> in an organization and no task sharing. The rules of this plan for session
> links and task links stay; a link names its task by the task key. These
> statements are history: `data/tasks/sync-engine.ts` (the file is removed;
> `completeTasksForMergedPullRequest` is in `data/tasks/done-on-merge.ts`),
> `Task.update` as the place that settles sessions (it is
> `data/tasks/task-settle.ts`), and the task row and the finished task on a
> shelf (`task-conversation.md` decision 5). "A merged pull request completes
> the task" now means that Solus moves the task to the status category `done`
> on its provider. A task is finished when its category is `done`. A prompt to
> a session of a finished task does not reopen the task.

A session owns the pull requests it works on. A task reads the pull requests
of its sessions and holds no copy of them. The host also holds where a session
is in a person's list: active, settled, or snoozed. This follows
`docs/plans/task-conversation.md` decision 8: a session has a task only when it
joins one, so most sessions have none, and their pull requests must still be
found, kept fresh and shown.

The model follows T3 Code, where a thread owns its pull request links
(`projection_thread_pull_requests`, read at commit `0fcd5f90`) and its settled
and snoozed state, and where a thread settles when all its pull requests end.
T3 Code has no task level; the task part is ours.

## Vocabulary

- **session link** — one row of `session_pull_requests`: a session, a pull
  request, who linked it and what PR sync last saw.
- **task link** — a `pr` row of `task_links`: a pull request linked on the task
  itself, for one that no session of the task made.
- **source** — who made a session link: `branch`, `created`, `agent`, `manual`.
- **dismissed** — the stored source of a session link that a person removed.
  The row stays so PR sync does not link the pull request again.

- **settled** — the state of a session whose work is finished. The list shows
  it on the Completed shelf. `settledBy` says what settled it: `person`,
  `pull-request`, `task`, or `idle`.
- **snoozed** — the state of a session a person deferred until a wake time.
- **active** — a session that is not settled and not snoozed. It has no row in
  `session_states`, or a row with no settle and no snooze.

Do not say "automatic link" or "system link" for a session link. A pull request
that PR sync finds is a session link with source `branch`. Do not say "done" or
"completed" for the state of a session: a task is done, a session is settled.
The Completed shelf is the name of the place in the list.

## Decisions

1. **The session owns the link.** One pull request can belong to several
   sessions, and a session to several pull requests. The key is the stable
   Solus session id, the repository (`host/owner/repo`, lower case) and the
   number.
2. **A task reads, and does not copy.** `readTaskLinks` and `readTaskPrLinks`
   answer a task's own `pr` links plus the session links of its sessions. A
   session that joins a task brings its pull requests; a session that leaves
   takes them. A `referenced` session brings none. A pull request linked both
   ways is the task's own link.
3. **Source rules** (`nextSessionPullRequestSource`). A `branch` discovery
   never writes over a row. An explicit link (`created`, `agent`, `manual`)
   claims a `branch` row and revives a `dismissed` row. An explicit link does
   not write over another explicit link.
   **A session holds one `branch` row, and it follows the branch**
   (2026-10-22, after T3 Code's `branchPullRequest`, one detected pull request
   per thread beside its explicit links). A new `branch` discovery deletes the
   session's `branch` rows whose pull request has ended (merged, closed, or
   gone) and stops their watches, so a session whose agent opens the next pull
   request on its branch shows that one, not a growing list of found rows. A
   `branch` row still open stays, as do explicit rows and tombstones. T3 Code
   keeps the detected pull request in its own field; Solus keeps it in the
   same table with its source, so the task reads, the observation write, and
   the chips consume one shape.
4. **Unlink is a tombstone.** Unlinking a session link sets `dismissed`.
   Unlinking a pull request on a task deletes the task link; when the task has
   none, it dismisses the link on each session of the task that owns it.
5. **The last observation is stored once** per organization and source
   authority (`pull_request_observations`: `state`, `draft`, `title`,
   `updated_at`), and each link names the observation it reads, so a row
   draws its pull request with no network read. PR sync writes the observation
   and the `keeps_session` bit of every link that names it in one transaction,
   task links and session links alike (plans/029 §5.1).
6. **A merged pull request completes the task** that reads it, through a task
   link or a session link, when every pull request of the task is merged.
7. **The host holds the state of a session** (`session_states`), so every
   client shows the same list. A session settles when:
   - a person marks it done;
   - every pull request of the session is merged or closed, the last one ended
     after the last prompt and after a person last made the session active, and
     the session is not mid-turn (`settleSessionsWithEndedPullRequests`);
   - its task finishes, unless another task that is not finished holds it;
   - it had no prompt for 30 days and waits on no open pull request. Since
     `docs/plans/session-archive.md` such a session is archived
     (`archiveIdleSessions`), not settled; `settledBy: 'idle'` stays on older
     rows.
   A prompt makes a settled or snoozed session active. A person can also make
   a settled session active; its pull requests then settle it again only if one
   ends later. Reopening a task makes the sessions that its finish settled
   active.
8. **The shelves.** Completed lists finished tasks and settled sessions.
   Snoozed lists snoozed sessions; a task is never snoozed. Both shelves also
   list a session with no conversation open on the client. A session that its
   task's finish settled has no shelf row of its own unless its conversation
   is open: the finished task is the row.
9. **PR sync keeps a session link fresh until its session is settled.** There
   is no time limit on the link. A task that is not finished keeps the links of
   its sessions fresh, because the task reads them. This is PR sync's
   interest, not a watch: a watch wakes the agent (`docs/plans/pr-watch.md`).
10. **Menus.** A session row opens the session menu, a task row the task menu,
   and a pull request chip its own menu. The session menu links the session to
   a task and links a pull request to the session. The task menu has no session
   actions.
   The conversation header also has a task icon beside Share. It opens the
   searchable popover below the icon for a session with no task, or the task page for a linked
   session. Drafts also show the task icon in the session breadcrumb, where it
   opens the draft task picker. The input header has no task control. These
   controls are shared by desktop, web, and mobile. The session
   sidebar footer has Settings and Keyboard shortcuts icons; it has no Docs
   icon.

## Who writes a session link

| Writer | Source |
|---|---|
| PR sync, for each live session whose branch is the pull request's branch, in its own worktree or on the shared checkout | `branch` |
| The pull request list, when the asking session's branch is a listed branch | `branch` |
| Create pull request in Solus | `created` |
| The agent tool `link` with `kind=pr` and no `task_id`, from any session | `agent` |
| `link` with `kind=pr` and a `task_id`, when the calling session works on that task | `agent` |
| A person: Link pull request… on a session, or an edit of the pull request from the session | `manual` |

PR sync asks about the branch of a session of a task that is not finished, and
of a session that is not settled and was active within the list's idle window
(`SESSION_LIST_IDLE_MS`, 30 days, after which an idle session is archived;
`docs/plans/session-archive.md`). The window limits only the branch lookup. A
link, once made, is kept fresh until its session is settled. The branch is the
one the session last ran on (the session index): a session on the shared
checkout counts as much as one in its own worktree, as a thread's branch does
in T3 Code. A session that has not run since the shared checkout changed
branch keeps its old branch until its next turn. Before PR sync writes a
`branch` row it reads the live checkouts again and writes only when the
session's branch is still the one it looked up (`linkBranchOwners`), so a
stale lookup can only miss a link, never make a wrong one.

**A branch name alone does not match** (2026-10-27). GitHub matches
`headRefName` in every fork, so a session on `main` in a fork of a busy
repository found the pull request another contributor opened from their own
`main`. A session's branch has one head: the repository and branch that
`git push` sends it to (`resolvePushHead`: `<branch>@{push}`, else the push
remote `git push` would choose, under the branch's own name). A pull request is
the branch's only when it names that head (`PullRequestHead` in
`@solus/contracts/repository-key`). PR sync, the branch lookup of a git action,
orchestration, and the detailed status's `prUrl` all key branches by head. A
scope that is no checkout on this host, such as the record of a run on another
machine, names the branch of the base repository. A session on its
repository's default branch is not looked up at all: it works on the project,
not on a pull request. A client does not know where a checkout pushes, so it
never matches a branch by name: the git card names the host's `prUrl`
(`prForCheckout`), and a task row shows the session links PR sync writes.

`link` with `kind=pr` for a task the calling session does not work on, the
task page's link picker, and a pull request review session's first prompt write
a task link. There is one agent tool for links, `link` (it was `link_task`):
a separate tool for the session case would be a second name for one question.
An agent removes a session link with `unlink` with `kind=pr` (by number or URL), as a person does in the list; the row stays a tombstone, so PR sync does not link it again (2026-10-27).

Several pull requests are one call (2026-11-01). `link` with `kind=pr` takes `target_ids`, a list of numbers or URLs such as the layers of a stack; it links each one the session does not show yet and returns them by repository as linked, already linked, or invalid, and an invalid name does not stop the others. `unlink` with `kind=pr` takes `states` (`open`, `closed`, `merged`) instead of `target_id`; it removes every link whose state, as PR sync last saw it on the link row, is one of them. A draft is open. A link that PR sync has not answered for, or that the code host says is gone, has no known state and stays. The transcript names such a call by its count ("Link 6 pull requests").

Every session that has the `link` tool gets a "Pull request linking" block in
its runtime instructions (`execution/agents/runtime-instructions.ts`), for Claude
and Codex alike. The block tells the agent to link each pull request that it
creates or works on right away, every layer of a stack, because a `gh`
operation does not register a pull request with the session. The task packet
does not repeat the rule. When the Tasks tool group is off, the block is absent.
When `list_links` is also on, the block tells the agent to call
it before it finishes pull request work and to link each pull request that is
missing.

The rail's Git card shows one pull request with its review guide, checks, and
next move (`GitSection`, `LinkedPullRequestRows`): the branch's own until a
person chooses another, and the first linked one when the branch has none.
Under it, as "Also linked", one row for each other open pull request the
session links in the project's repository, read as the list and the review
pane read one: the lifecycle as the glyph's shape (open, draft), mergeability
as its tone (`readinessTone`: red cannot merge, green can, purple merged), the
checks as a tinted glyph before the number, and the title. A row brings its
pull request into the group, and the group's
number (`#412 1/3 ›`) cycles to the next one; the card grows one row per
link, not one group. The choice is the tab's and goes back to the branch's
own pull request when the branch or project changes. It keeps the
session's links in interest while it is shown, so a linked pull request the
project has not read yet is pushed to it. A link in another repository is not
on the card: a number means nothing outside its repository, and the card acts
on this project's checkout. On desktop and web, the session sidebar row
shows the links. The "N PRs" chip's list unlinks a row with its hover ×,
or with Delete or Backspace on the highlighted row; a single chip unlinks
from its right-click menu. The session menu opens the link dialog, which lists
the session's links as the chip's list does, each with the same ×; the item
reads "Pull Requests…" while the session has links. On
the phone, the thread row's menu has "Unlink #N", or an "Unlink Pull Request"
submenu with one item per link.

### An agent on an attached machine

The session of an organization run has two hosts: the machine that runs it and
the organization's Solus API, where a person opens it. `link` with no task
writes the link on the machine, whose PR sync keeps the pull request fresh, and
records an op in the delivery queue (outbox domain `sessions`, verb
`link-pull-request`, resource id = the session id).
The Solus API applies it to the same session (`data/sessions/session-applier.ts`).
`link` with a `task_id` sends its `tasks` op with the pull request URL, and
the task applier makes a session link when the origin session works on the task.

## Data

`packages/server/src/data/links/schema.ts`: a session link is a session→pr
`pull-request` edge of `resource_links` (`repository`, `number`, `url`,
`title`, `source`, `status` with the `dismissed` tombstone, `author`,
`created_by`, `created_at`, the watch fields, and `keeps_session`); what PR
sync saw is in `pull_request_observations` (docs/database-schema.md,
Relationships).

`session_states` (`session_id`, `settled_at`, `settled_by`, `unsettled_at`,
`snoozed_until`, `snooze_note`, `last_prompt_at`, `organization_id`).
Migrations `0027` and `0016`. `archived_at` came with migration `0017` on
both engines (`docs/plans/session-archive.md`).

`packages/contracts/src/session-state.ts`: `SessionState`, `ACTIVE_SESSION_STATE`.

`packages/contracts/src/session-pull-requests.ts`: `SessionPullRequestLink`.
`TaskLink` and `TaskSidebarPrLink` gain `ownerSessionId` for a link the task
reads from a session.

## Host

- `data/sessions/session-pull-requests.ts` — link, unlink, read, PR sync's
  interest (`readSessionPullRequestInterests`) and the observation write.
- `data/tasks/task-links.ts` — the two task reads include session links;
  `recordPullRequestObservation` writes the observation and binds every edge
  (`data/links/pull-request-observations.ts`).
- `data/tasks/done-on-merge.ts` (was `sync-engine.ts`) —
  `completeTasksForMergedPullRequest` finds a task through either link.
- `prs/pr-sync.ts` — live checkouts come from live tasks and from the session
  index (`recentBranchSessions`); interest comes from both interest reads
  (`readPrLinkInterests`, `readSessionPullRequestInterests`).
- RPC: `sessionPullRequestsList`, `sessionPullRequestLink`,
  `sessionPullRequestUnlink`, and `sessionPullRequestWatch`
  (`docs/plans/pr-watch.md`). Topic: `session.pullRequestsChanged`. Unlinking
  a pull request, or settling the session, stops its watch. A change of
  a session's links also invalidates each task the session belongs to.
- `data/sessions/session-states.ts` — `SessionShelf`, one per session:
  settle, make active, snooze, archive, and the prompt record. The pull
  request settle rule and the idle archive are functions over many sessions.
  `prs/pr-sync.ts` runs them at the end of each tick. `SessionRuntime` records
  each prompt. `Task.update` settles and reopens the sessions of a task.
- RPC: `sessionSetSettled`, `sessionSnooze`, `sessionSetArchived`; each answers
  the state it leaves. The list is `sessionRecordList` with each record's
  state (`docs/plans/session-archive.md`). Topic: `session.stateChanged`, with
  the state.
- The agent tool `link` (`execution/agents/tools/task-tools.ts`), in the Tasks
  group.
- The agent tool `organize_session`
  (`execution/agents/tools/session-organize-tool.ts`), in the Sessions group.
  It settles, unsettles, snoozes, wakes, archives, unarchives, or marks unread any session on this
  host; the caller's session when it names none. An agent's settle is a
  `person` settle: the agent acts for the person. It refuses a wake time in
  the past and a snooze of a settled session. A read-state change is
  broadcast as `session.readStateChanged` from the data layer, so the RPC and
  the tool reach every client the same way. Pins are not in the tool: a pin
  has no live event yet, and the mobile app has no pins.
- All these rows use the session id (`docs/plans/session-identity.md`). PR
  sync finds pull requests through the thread index, so it maps each thread to
  its session before it writes. A session id does not change, so nothing moves.

## Renderer

- `contexts/prs/session-pull-requests.store.svelte.ts` holds session links for
  session rows. Task rows read the task's links, which the host answers with
  the session links in them.
- `contexts/workspace/session-task-link.ts` links a mounted session to a task
  at once, and unlinks it.
- `WorkspaceUiStore.linkPrompt` opens `SessionLinkPrompts` (mounted once by
  desktop and by web): `LinkSessionTaskDialog` and `LinkPullRequestDialog`.
- `contexts/workspace/session-list.store.svelte.ts` holds each host's session
  list with each session's state (`docs/plans/session-archive.md`).
  `SessionSidebarStore` reads it: a session row takes its shelf from it
  (`sessionRowLifecycle`), and a listed session with no conversation here gets
  a row that opens the session. A task row takes its shelf from the task's
  status. The client keeps no done mark and no snooze of its own.
- `SessionContextMenu`: Link to task… or Open task and Unlink from task; Link
  pull request…; Snooze and Mark done on a session's own row.
- `TaskContextMenu`: task actions and Link pull request…; the single-session
  items and Snooze are removed. The task picker has no Snooze. A task is
  marked done with the check on its row, as before.
- `PrContextMenu` on a pull request chip: Review, Open on GitHub, Copy link,
  Unlink.
- Phone: the task sheet has Link to task / Unlink from task and Link pull
  request. The Snooze tile and the Snooze button show only for a session.

## Limits

- Only GitHub pull request URLs are links, as for task links.
- On an attached machine, only an agent's link travels to the organization's
  Solus API. A link that PR sync finds from a branch, and the state of a
  session, stay on the machine that holds them.
- A snooze or a settle is for the session, not for one person. Two people who
  share a session see the same state.

## Verification

- `session-pull-requests`: source rules, the tombstone, two sessions on one
  pull request, the task reads, the owned unlink.
- `pr-sync`: a session with no task gets its link; a dismissed link stays
  dismissed; a merged session link completes the task.
- `link-pull-request`: the URL check of the dialog.
- `session-states`: settle and its reverse, snooze, the prompt rule, the pull
  request rule (open link, busy session, later prompt, removed link), the idle
  rule, the task rules.
- `pr-sync`: a session with no task is kept fresh whatever the age of its link,
  its merged pull request settles it, and a settled session is not read again.
- `session-pull-requests`: the `sessions` and `tasks` outbox ops that make a
  session link.
- `task-list`: `sessionRowLifecycle`.
