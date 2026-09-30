# Session pull requests

Status: implemented, 2026-09-30. Task 01M3AZ4M9Z4YNKD6TGDY2300B0.

A session owns the pull requests it works on. A task reads the pull requests
of its sessions and holds no copy of them. The host also holds where a session
is in a person's list: active, settled, or snoozed. This follows
`docs/plans/task-conversation.md` decision 8: a session has a task only when it
joins one, so most sessions have none, and their pull requests must still be
found, watched and shown.

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
4. **Unlink is a tombstone.** Unlinking a session link sets `dismissed`.
   Unlinking a pull request on a task deletes the task link; when the task has
   none, it dismisses the link on each session of the task that owns it.
5. **Each link stores the last observation** (`pr_state`, `pr_draft`,
   `pr_updated_at`, `title`), so a row draws its pull request with no network
   read. PR sync writes it to task links and session links alike.
6. **A merged pull request completes the task** that reads it, through a task
   link or a session link, when every pull request of the task is merged.
7. **The host holds the state of a session** (`session_states`), so every
   client shows the same list. A session settles when:
   - a person marks it done;
   - every pull request of the session is merged or closed, the last one ended
     after the last prompt and after a person last made the session active, and
     the session is not mid-turn (`settleSessionsWithEndedPullRequests`);
   - its task finishes, unless another task that is not finished holds it;
   - it had no prompt for 30 days and waits on no open pull request
     (`settleIdleSessions`).
   A prompt makes a settled or snoozed session active. A person can also make
   a settled session active; its pull requests then settle it again only if one
   ends later. Reopening a task makes the sessions that its finish settled
   active.
8. **The shelves.** Completed lists finished tasks and settled sessions.
   Snoozed lists snoozed sessions; a task is never snoozed. Both shelves also
   list a session with no conversation open on the client. A session that its
   task's finish settled has no shelf row of its own unless its conversation
   is open: the finished task is the row.
9. **PR sync watches a session link until its session is settled.** There is
   no time limit on the link. A task that is not finished keeps the links of
   its sessions watched, because the task reads them.
10. **Menus.** A session row opens the session menu, a task row the task menu,
   and a pull request chip its own menu. The session menu links the session to
   a task and links a pull request to the session. The task menu has no session
   actions.

## Who writes a session link

| Writer | Source |
|---|---|
| PR sync, for each live session whose own worktree is on the pull request's branch | `branch` |
| The pull request list, when the asking session's own worktree is on a listed branch | `branch` |
| Create pull request in Solus | `created` |
| The agent tool `link` with `kind=pr` and no `task_id`, from any session | `agent` |
| `link` with `kind=pr` and a `task_id`, when the calling session works on that task | `agent` |
| A person: Link pull request… on a session, or an edit of the pull request from the session | `manual` |

PR sync asks about the branch of a session of a task that is not finished, and
of a session that is not settled and was active in the last 30 days
(`BRANCH_LOOKUP_MS`). The 30 days limit only the branch lookup. A link, once
made, is watched until its session is settled.

`link` with `kind=pr` for a task the calling session does not work on, the
task page's link picker, and a pull request review session's first prompt write
a task link. There is one agent tool for links, `link` (it was `link_task`):
a separate tool for the session case would be a second name for one question.
An agent has no unlink tool; a person removes a link in the list.

Every session that has the `link` tool gets a "Pull request linking" block in
its runtime instructions (`execution/agents/runtime-instructions.ts`), for Claude
and Codex alike. The block tells the agent to link each pull request that it
creates or works on right away, every layer of a stack, because a `gh`
operation does not register a pull request with the session. The task packet
does not repeat the rule. When the Tasks tool group is off, the block is absent.
When `list_session_pull_requests` is also on, the block tells the agent to call
it before it finishes pull request work and to link each pull request that is
missing.

The project rail shows a session's links in its **Linked** card
(`project-panel/LinkedSection.svelte`). The card is present only while the
session links a pull request. Open pull requests come first; merged, closed and
missing ones follow, dimmed. A row opens the pull request, and its context menu
copies the URL or unlinks it. The header's plus button opens the same link
dialog as the session menu. The phone has no rail, so the Actions tab of its
plus menu shows the same rows with an unlink button and a "Link a pull request"
row.

### An agent on an attached machine

The session of an organization run has two hosts: the machine that runs it and
the organization's Solus API, where a person opens it. `link` with no task
writes the link on the machine, whose PR sync watches the pull request, and
records an op in the delivery queue (outbox domain `sessions`, verb
`link-pull-request`, resource id = the session id).
The Solus API applies it to the same session (`data/sessions/session-applier.ts`).
`link` with a `task_id` sends its `tasks` op with the pull request URL, and
the task applier makes a session link when the origin session works on the task.

## Data

`packages/server/src/data/sessions/schema.ts`: `session_pull_requests`
(`session_id`, `repository`, `number`, `url`, `title`, `source`, `created_by`,
`linked_at`, `pr_state`, `pr_draft`, `pr_updated_at`, `organization_id`).
Migrations `0026` (SQLite) and `0015` (Postgres).

`session_states` (`session_id`, `settled_at`, `settled_by`, `unsettled_at`,
`snoozed_until`, `snooze_note`, `last_prompt_at`, `organization_id`).
Migrations `0027` and `0016`.

`packages/contracts/src/session-state.ts`: `SessionState`, `SessionShelfEntry`.

`packages/contracts/src/session-pull-requests.ts`: `SessionPullRequestLink`.
`TaskLink` and `TaskSidebarPrLink` gain `ownerSessionId` for a link the task
reads from a session.

## Host

- `data/sessions/session-pull-requests.ts` — link, unlink, read, rekey, the
  watch list and the observation write.
- `data/tasks/task-links.ts` — the two task reads include session links;
  `recordPullRequestObservation` writes both tables.
- `data/tasks/sync-engine.ts` — `completeTasksForMergedPullRequest` finds a
  task through either link.
- `prs/pr-sync.ts` — live checkouts come from live tasks and from the session
  index (`recentWorktreeSessions`); interest comes from both watch lists.
- RPC: `sessionPullRequestsList`, `sessionPullRequestLink`,
  `sessionPullRequestUnlink`. Topic: `session.pullRequestsChanged`. A change of
  a session's links also invalidates each task the session belongs to.
- A handoff that rekeys a session's task links rekeys its pull request links
  and its state.
- `data/sessions/session-states.ts` — settle, make active, snooze, the prompt
  record, the shelf read and the two settle rules. `prs/pr-sync.ts` runs the
  settle rules at the end of each tick. `SessionRuntime` records each prompt.
  `Task.update` settles and reopens the sessions of a task.
- RPC: `sessionShelfList`, `sessionSetSettled`, `sessionSnooze`. Topic:
  `session.stateChanged`.
- The agent tool `link` (`execution/agents/tools/task-tools.ts`), in the Tasks
  group.
- All these rows use Solus's session id. A session that ran outside Solus
  first has only a provider thread id until it is resumed in Solus; the first
  prompt moves its links and state to the session id.

## Renderer

- `contexts/prs/session-pull-requests.store.svelte.ts` holds session links for
  session rows. Task rows read the task's links, which the host answers with
  the session links in them.
- `contexts/workspace/session-task-link.ts` links a mounted session to a task
  at once, and unlinks it.
- `WorkspaceUiStore.linkPrompt` opens `SessionLinkPrompts` (mounted once by
  desktop and by web): `LinkSessionTaskDialog` and `LinkPullRequestDialog`.
- `contexts/workspace/session-states.store.svelte.ts` holds the settled and
  snoozed sessions of each host. `SessionSidebarStore` reads it: a session row
  takes its shelf from it (`sessionRowLifecycle`), and a settled or snoozed
  session with no conversation here gets a row that opens the session. A task
  row takes its shelf from the task's status. The client keeps no done mark
  and no snooze of its own.
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
  pull request, rekey, the task reads, the owned unlink.
- `pr-sync`: a session with no task gets its link; a dismissed link stays
  dismissed; a merged session link completes the task.
- `link-pull-request`: the URL check of the dialog.
- `session-states`: settle and its reverse, snooze, the prompt rule, the pull
  request rule (open link, busy session, later prompt, removed link), the idle
  rule, the task rules, rekey.
- `pr-sync`: a session with no task is watched whatever the age of its link,
  its merged pull request settles it, and a settled session is not read again.
- `session-pull-requests`: the `sessions` and `tasks` outbox ops that make a
  session link.
- `task-list`: `sessionRowLifecycle`.
