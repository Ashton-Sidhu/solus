# Tasks: entities that sessions link to

Status: implemented, 2026-10-27. This replaces the lead-session plan of
2026-09-27 (task 01M3AZ4M9Z4YNKD6TGDY2300B0) and its sidebar sections of
2026-09-30.

A task is a record that sessions can be linked to. It does not start its own
kind of session, and it has no place in the session sidebar. Its description,
links, works, plans, PRs and comments are the persistent context. A session
linked to a task reads that context with `read_task`.

## Vocabulary

- **attempt** — a session linked to a task with role `working`. A session has
  at most one owning task.
- **reference** — a session linked to a task with role `referenced`. It is a
  relationship, not ownership.
- **task chip** — the mark on a session row that names the task the session
  is linked to. It opens the task page.
- **lead** — no longer a task concept. The word stays for the orchestrator's
  lead contract, which no session gets now (see "Orchestrator").

Do not coin "task thread", "task conversation" or "task row".

## Decisions

1. A task has no lead. `TaskSessionRole` is `working` or `referenced`.
   Migration `0025_task_without_lead` turns each earlier `lead` link into
   `working` and drops `tasks.lead_preferences`.
2. Opening a task opens its task page (`goToTask`). It does not open a
   session, a draft or a split view. This is the rule for the Tasks page, the
   picker, the task chip, the breadcrumb and New task.
3. New task files an "Untitled task" and opens its page. It has no default
   key; the palette and the Tasks page offer it.
4. The task page's New session composes a plain attempt draft
   (`SessionOpening.openTaskSession`). Resume in a task menu opens the latest
   linked session (`openTaskLinkedSession`).
5. The session sidebar lists sessions only. A session linked to a task keeps
   its own row, with the task chip. There is no Tasks section and no task row
   on any shelf.
6. A session that another session delegated (`Session.parentSessionId`, from
   the host's `delegation` record) is listed under the row of the session that
   started it, on screen or not (`nestedRowParents` in `session-tree.ts`). A
   chain of delegations nests under its top row, one level deep. The nested
   session keeps its row in `catalogTasks`, so its menu, breadcrumb, snooze,
   and X are its own; only its place in the list changes. A session whose
   parent has no active row keeps its own row. `TaskSessionRow` draws it as
   one line, its name alone, with the accent path only while it is on screen.
   Its branch and host are in the tooltip.
7. Snoozing a task is personal and hides it from the Tasks page
   (`docs/task-snooze.md`). It does not move any sidebar row.
8. A session makes no task of its own. A task is made by a person, an agent, a
   ticket or an automation, and a session joins it. A new session has no task;
   `TaskTarget` is `existing` or `none`. No code path makes a task from a
   prompt: `session` is not a task source, and `start_session` takes
   `task='attempt'` (join a task) or `task='none'`.
9. A linked session gets the task packet (`formatTaskContext` in
   `packages/server/src/data/tasks/task-context.ts`) in its system prompt:
   the task's id and title, a `read_task` instruction and the work contract.

## Orchestrator

The orchestration runtime is unchanged: `start_session`, `send_session`,
`stop_session`, `read_session`, `read_task_sessions`, reports and notices into
the parent, and the cards where a person answers a child
(`docs/session-orchestration.md`).

These parts are kept for reuse, but nothing triggers them now:

- The **lead contract** (`LEAD_CONTRACT`, `formatLeadContract` in
  `task-context.ts`) and the user's lead settings: **Lead agent and model**
  (`leadModel`), **Default worker model** (`workerModel`) and **Lead
  instructions** (`leadInstructions`) in Settings → Tasks. No run receives the
  contract, and no draft starts on the lead model.
- The **lead wake rule** in `session-orchestrator.ts` and `parent-delivery.ts`:
  a lead's reports are held until its last open message settles, and notices
  never reach its model. `orchestrateSessions(runtime, isLead)` takes the
  predicate; its default answers false for every session.

To use them again, choose the trigger that makes a session a lead, pass it as
`isLead`, and append `formatLeadContract` to that session's system prompt.

## Verification

- Unit: the packet carries no lead contract, and the lead contract keeps its
  rules and the user's settings (`injected-context`); the lead wake rule
  (`session-orchestrator`, "a lead"); task links (`task-store`); the Sessions
  list (`task-page`); a session's default task target (`session-task-target`);
  a task clicked past does not take the screen (`task-open-latency`); the
  sidebar lists sessions only (`sidebar-list-items`, `task-list`); the keys
  (`keybinding-manifest`).
