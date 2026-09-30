# Session outputs

Status: implemented, 2026-09-30. Task 01M3AZ4M9Z4YNKD6TGDY2300B0.

A session owns what it makes. A task shows what its sessions made, and those
links follow the session: a session that joins a task brings its outputs, and
a session that leaves takes them. This is the same rule as for pull requests
(`docs/plans/session-pull-requests.md`), for works, plans and automations.

## Vocabulary

- **output** — a work, a plan or an automation that a session made. The item
  records its session: a work and a plan by the provider thread, an automation
  in `createdBy`.
- **output link** — a row of `task_links` that is on the task because a working
  session of the task made the item. `output_session_id` names that session.
  `TaskLink.ownerSessionId` carries it to the clients.
- **deliberate link** — a row of `task_links` that a person or an agent made to
  say that the item belongs to the task. `output_session_id` is null.

Do not say "automatic link" for an output link, and do not say that an output
is "linked to a session". A session makes an output. A task links it.

## Decisions

1. **Outputs are not links to a session.** Only a pull request is linked to a
   session, because a session works on pull requests that it did not make and
   their state settles the session. An output already records its session.
2. **The task keeps a row for each output.** The row is a copy that Solus keeps
   in step with the session, not a live read. The reason is access: the
   workspace API gives read access to a work through its `task_links` row
   (`data/tasks/resource-visibility.ts`), and a task share reaches the works
   that have a row (`data/tasks/task-sharing.ts`). A work records a provider
   thread and a task records Solus's session id, and the map between the two
   is not in the database those checks run on. A live read would need that map
   in SQL, so it would change who can read a work.
3. **The row follows the session.**
   - An output made while the session works on a task gets a row at once
     (`Task.linkSessionOutput`).
   - A session that joins a task brings the outputs it made before
     (`readSessionOutputs`). Only the first link of the session to the task
     does this.
   - A session that leaves a task takes its output links (`deleteSessionLink`).
     A session that moves to another task takes them there.
   - A session that a task only references brings nothing.
4. **A deliberate link stays.** A person or an agent who links an item that is
   on the task as an output makes the link deliberate (`claimSessionOutputLink`).
   It then stays when the session leaves.
5. **A person removes an output from the task with Remove.** The row is
   deleted. It does not come back when the session is linked again.
6. **An artifact is not an output for this rule.** Most artifacts are read
   once. An artifact is on the task only when its maker asked for that
   (`link_to_task`), and then it is an output link like the others.

## Data

`task_links.output_session_id` (migrations SQLite `0031`, Postgres `0020`). Its
value is the `session_id` of the task's session link, so a leave is one
delete, and a rekey of the session link rekeys it.

## Host

- `data/tasks/session-outputs.ts` — `readSessionOutputs`: the works, plans and
  automations of one session, by each id the session is known by.
- `data/tasks/task.ts` — `Task.linkSessionOutput` (was
  `linkArtifactForSession`), the adoption in `linkSession`, the claim in
  `linkWorkspaceObject`.
- `data/tasks/task-sessions.ts` — `writeSessionLink` answers whether the link
  is new; `deleteSessionLink` and `rekeyTaskSessionLinks` keep the output links
  in step.
- The writers are the same six as before: a work create and update, the work
  applier, the plan event in `SessionRuntime`, the automation handler and the
  two automation tools.

## Limits

- An artifact made with `link_to_task` while its session had no task does not
  come to the task when the session joins one. The request is not stored.
- An output that a person removed from the task comes back if the session
  changes the same item again, because a change writes the output link again.
- A dispatched session's work that names its task (`taskId` on the work op) is
  a deliberate link, as before. It stays when the session leaves.
- The task page does not name the session beside an output. The link's maker
  (`createdBy`) names the agent session.

## Verification

`session-outputs`: a join brings works, plans and automations and no artifact; a
referenced session brings nothing; a leave takes outputs and leaves deliberate
links; a claim; a move between two tasks; an output made on the task; a
removed output stays removed on a second link.
