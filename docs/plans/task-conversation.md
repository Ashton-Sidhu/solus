# Task conversation: the lead session

Status: implemented, 2026-09-27. Sidebar sections and sessions with no task,
2026-09-30. Task 01M3AZ4M9Z4YNKD6TGDY2300B0.

A task gets one continuous conversation. The user selects the task and types.
A long-lived session, the **lead**, reads the prompt, starts worker sessions on
the task, hears their reports, and answers. The conversation is the lead's own
tab in the leading pane; the task page opens beside it in the companion pane
and keeps every section it has today.

The comparison the maintainers used: Claude Projects and Cursor. The task is the
project container. Its description, links, works, plans, PRs and comments are
the persistent context. Every task-bound session reads it with `read_task`; the
task packet in its system prompt names the task and the work contract, and
holds no state that changes while the agent works. The lead is the one long chat over that context. Workers are the
parallel agents, but each is a first-class Solus session with its own tab,
transcript, worktree and PR.

An earlier version of this plan embedded the conversation in the task page as
a bounded region with its own composer. That put a scrolling transcript inside
a scrolling page, a second composer on a page that already had one, and a
second conversation implementation beside the pane the workspace already
renders. The pane model already did the job: a conversation in the leading
pane, a record beside it.

## Vocabulary

- **lead** — the one session a task is talked to through. Role `lead` on
  `task_session_links`.
- **worker** — a session the lead starts on the same task. Role `working`, an
  attempt like any other.
- **lead draft** — the session draft a lead starts from, bound to the task with
  role `lead`. It is a draft in the leading pane like any other.
- **lead contract** — the rules appended to the lead's task packet.
- **Tasks section**, **Sessions section** — the two live sections of the
  session sidebar. A row in Tasks is a **task row**; a row in Sessions is a
  **session row**.
- **task chip** — the mark on a session row that names the task the session
  belongs to, when that task has no task row on this client.

Do not coin "orchestrator session", "parent session", "root chat", "task
thread" or "task conversation region". The orchestration layer's own word for a
session that started another is *parent*; a lead is a parent, but a parent is
not always a lead.

## Decisions

1. The conversation is the lead's own tab. The task page does not embed it and
   keeps its comment composer as its default input.
2. Only a session started as lead is lead. There is no promotion of an existing
   session and no "Make lead" or "Release lead" control.
3. Workers are **attempts on the same task**, never subtasks. Solus does not
   manage epics (task 01M3BC67J3RZDXQTYKMCPBA9EB removes local epic management
   and the `subtask` option on `start_session`). An epic is an upstream snapshot
   on the task, and its description reaches the lead through `read_task`.
4. The lead does **very small** direct work only. Its thread must stay small so a
   cache miss on a long thread does not spend the user's limits. The contract
   says this and keeps the lead's own reads and replies short.
5. The session sidebar has two live sections, **Tasks** and **Sessions**
   (this replaces the Leads section of 2026-09-27).
   - A task row is flat. Selecting it opens the task as the split view: the
     lead's conversation in the leading pane and the task page in the
     companion pane. The task's other sessions are on the task page, not under
     the row.
   - A row lists one session under itself, and only while that session is on
     screen: a session of the task that is not its lead. The list then shows
     which task the conversation belongs to. No row lists more than one.
   - The Sessions section holds sessions with no task. A session of a task
     that is not open on this client also keeps its row there, with a task
     chip. When the task is opened here, that session leaves Sessions and
     shows under the task row while it is on screen.
   - A task is open on a client when a person opened it there, or when its
     lead's conversation is mounted there. A session that is only linked to a
     task does not open the task.
6. Opening a task opens its lead, and creates one when it does not exist. A
   task with no lead opens a lead draft with the task page beside it, so
   "click a task, type" is how most leads begin. This is the rule for a task
   row, the task picker, the Tasks page and New task. New session on
   the task page stays a plain attempt; Start lead on the same section is the
   explicit way while the task has no lead.
7. The task page opened beside a lead stays until closed, as any page opened
   aside does. Selecting a session with no lead does not close it.
8. A session makes no task of its own. A task is made by a person (the task
   composer), an agent, a ticket or an automation, and a session joins it.
   A new session has no task; `TaskTarget` is `existing` or `none`. No code
   path makes a task from a prompt: `session` is not a task source, the
   `skipTaskCreation` flag is gone, and `start_session` takes
   `task='attempt'` (join a task) or `task='none'`. Migration
   `no-session-tasks` turns each record an earlier build made for a session
   into an ordinary task.
9. New session is `mod+N`. New task is `mod+T`: it files an "Untitled task"
   and opens it as the split view, with no modal. The lead's first prompt
   names the task: the session's opening-prompt metadata sets the task's
   title, and its description when the task has none, while the title is
   still the placeholder. The person made the task; the prompt only names it.
   New session in task keeps the current session's task and has no default
   key.

## What exists already

- Orchestration: `start_session`, `send_session`, `stop_session`,
  `read_session`, `read_task_sessions`, reports and notices delivered into the
  parent, and the card in the parent's transcript where a person answers a
  child's question, plan or permission. `docs/session-orchestration.md`,
  `packages/server/src/execution/orchestration/`, `packages/server/src/execution/agents/tools/session-tools.ts`.
- Task binding at first dispatch: `prepareSessionTask` in
  `packages/server/src/data/tasks/task-sessions.ts`, called from the renderer's
  `prompt-dispatch.ts` through `tasksPrepareForSession`; the link on
  `session_init` for a dispatched host.
- The task packet: `formatTaskContext` in `packages/server/src/data/tasks/task-context.ts`,
  appended to the system prompt of every run. It carries the task's id and
  title, a `read_task` instruction and the work contract. The task's status,
  body, comments, epic and links come from `read_task`, prior attempts from
  `read_task_sessions`. The user message carries nothing about the task. A
  dispatched session still ships the task snapshot with each prompt, because
  `read_task` on the execution host answers from it.
- The task page: `packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte`
  with its Sessions list, Activity feed, comment composer and properties rail.
  It is a route, so it opens in the companion pane through `goToTask` with the
  `secondary` target.
- Panes: the workspace splits into a sidebar pane, a leading pane and companion
  panes (`layout/lib/workspace-body.ts`). The phone and the narrow web layout
  have one pane; `hasCompanionPanes` on the client shell says which.

## Data

`packages/contracts/src/task-types.ts`

```ts
export type TaskSessionRole = 'lead' | 'working' | 'referenced'

export interface PrepareSessionTaskRequest {
  // …existing fields…
  /** Start this session as the task's lead. Refused when the task has one. */
  role?: 'lead'
}
```

`task_session_links.role` already stores the role; no column changes. The role
rides `TaskSessionLink.role` in `sessionsByTask`, so every client sees it. The
link role rides the first prompt as `PromptOptions.taskRole`, because the
execution host writes the link only once the session id exists; every later
turn reads the role off the session's own link.

Server rule, in `writeSessionLink` (`task-sessions.ts`): a task has at most one
`lead` link. A second lead is refused with an error the renderer shows. A `lead`
link transfers session ownership exactly as `working` does.

## Server

1. **Prepare.** `prepareSessionTask` accepts `role` and passes it to
   `writeSessionLink`. The `tasksPrepareForSession` handler and
   `tasksLinkSession` handler in `packages/server/src/transport/handlers/tasks-handlers.ts`
   forward it.
2. **Lead contract.** `formatTaskContext` takes the session's role. For `lead`
   it appends, after the work contract:
   - You coordinate this task. You do not implement beyond very small edits.
   - Start workers with `start_session` (`task='attempt'`, this task's id), one
     worktree each (`worktree_base_branch`), with the full brief in the prompt.
     A worker does not see this conversation.
   - Keep `report` on and do not poll. The lead is woken once, when every
     worker it waits on has finished, and then tells the user the outcome. The
     user answers workers' questions and permissions on their cards.
   - Answer the user from reports, `read_task_sessions` and linked items. Do
     not read transcripts or source files to answer; ask a worker instead.
   - Send follow-ups with `report` off unless an answer is needed. Do not relay
     findings between workers; put shared findings in a task comment.
   - Keep replies short: what happened, what was produced with its link, what is
     open. Write durable summaries into the task body or a task comment.
   - Link every pull request. Move the task to in_review when a pull request is
     ready for a human.
   - When the user writes, read `read_task_sessions` first. After session
     reports, do not: they already say what each worker did.
   The system hint in `packages/server/src/execution/agents/system-hint.ts` does not
   change; the packet is the one place the contract lives.
3. **Role lookup.** The control plane passes `taskRole` on the first turn and
   the session's own link role after.
4. **Provider parity.** Claude Code and Codex both receive the packet and both
   have the session tools through `solusToolbox`. No provider-specific work.
5. **Restart.** Orchestrator state is in memory; open exchanges end on restart
   and the lead is told (`CHILD_INTERRUPTED_BY_RESTART`). The contract's
   "read first" rule is the recovery. Reports held for the lead are lost with
   the process; `read_task_sessions` has the same facts.
6. **Wakes.** Every wake reads the lead's whole thread again, so the host
   wakes it as rarely as it can (`parent-delivery.ts`). A report to a lead that
   still waits on other messages is held; when its last open message settles,
   every held report reaches it as one prompt. Notices (a worker's question,
   plan, permission or rate limit) never reach a lead's model: the person
   answers on the card. When the person stops the lead, its held reports are
   dropped. Measured on two Codex leads before this rule, the reads a lead made
   after each report were about half of its context growth.
7. **No task from a prompt.** `prepareSessionTask` only binds the task its
   caller names (`taskId` is required). `SessionRuntime` calls it when the
   prompt names a task that this host holds; a prompt that carries a task
   snapshot names another host's task, which the dispatching client bound
   there.

## Renderer

1. **Opening a lead.** Both moves live in `contexts/workspace/session-opening.ts`,
   so every entry point agrees:
   - `openTaskSession(task, { role: 'lead' })` opens a lead draft in the leading
     pane and, where the shell has companion panes, the task page beside it
     through `goToTask(taskId, 'click', 'secondary')`.
   - `openTask(task)` is the split view: the lead's tab, focused or resumed,
     with the task page beside it; a task with no lead gets a lead draft the
     same way, whatever else has run on it. Opening a task always means talking
     to it.
   - `openTaskLinkedSession(task)` is the older "jump back to the work" command
     the context menus' Resume keeps: the lead when there is one, else the
     latest attempt. Only a lead brings the page beside it.
   - The phone has one pane, so none of these opens the page; the conversation
     keeps the pane and the page is a tap away on the session's task chip.
   - A task page in the companion pane keeps the session sidebar open
     (`companionCollapsesSidebar` in `layout/lib/workspace-body.ts`), as the
     automation builder does: the list the row was clicked in stays on screen
     for the next task.
   - The Tasks page's rows open through `openTask` where the shell has
     companion panes. `openTask` promotes a provider ticket to a native task
     first, as Start does. Without companion panes, or without a workspace, the
     row opens the task page over the list as before.
   - New task (`WorkspaceContext.startNewTask`, and the Tasks page's New
     task) files an untitled task and hands it to `openTask`. The palette,
     `mod+T` and the Tasks page all start there. The task composer modal is
     left only for a board column's "+", which files into that column and
     stays on the list. `SessionMetadata.generateSessionMetadata` names the
     task through `Task.nameFromLeadPrompt`, whatever the session auto-rename
     setting is.
   - `openTask` calls `WorkspaceContext.onTaskOpened`. The sidebar store sets
     that hook to `restoreTask`, so an opened task has a task row from then on.
2. **Sidebar select.** `selectTask` in `session-sidebar.store.svelte.ts`: a
   task row opens through `openTask`, whatever has run on the task. A session
   row selects its session. `selectTaskRecord`, the picker's path, follows the
   same rule.
3. **Sidebar: the two sections.** A row with a task record is a task row;
   every other row stands for one session. The store splits its open rows
   into `taskRows` and `sessionRows`;
   `buildSidebarListItems` in `components/session/lib/sidebar-list-items.ts`
   puts each under its header, before Snoozed and Completed. The phone list
   wraps the same builder. A row lives in exactly one place: lifecycle still
   wins. A finished task and a settled session go to Completed; a snoozed
   session goes to Snoozed; a task is never snoozed. A session takes its shelf
   from the state its host holds (`docs/plans/session-pull-requests.md`,
   decisions 7 and 8).
   - `isDurableRowShown` gives a task a row only while it is open on the
     client (decision 5). A mounted session whose task has no row gets a
     session row that carries `linkedTask`; `TaskRow` draws it as the task
     chip, and the chip opens the task page beside the session.
   - `disclosedSession` (the pure rule in `task-list.ts`, the on-screen answer
     in the store) names the one session a row lists under itself.
     `TaskSessionRow` draws it; it is always the selected row.
4. **Composer.** A draft's default target is `{ kind: 'none' }`. The composer
   shows the task chip only when the draft has a task; the chip then offers No
   task and the project's tasks. It no longer offers New task. `prompt-dispatch.ts` binds a task on its host only when the
   prompt names one.
5. **Task page.** Unchanged in shape: Overview, Linked, Sessions and Activity in
   one column, the comment composer as the bottom bar, the properties rail
   beside them; the strip and the sheet on the stacked rung. The Sessions list
   pins the lead first with a "Lead" mark and offers **Start lead** beside New
   session while the task has no lead. Start lead calls `openTaskSession` with
   the lead role, so the page it was pressed on closes and reopens beside the
   draft.
6. **Console without a workspace.** The task page lists the lead in Sessions
   and opens its record read-only, as any session row does. Nothing else.

## Settings → Tasks

The Tasks tab in Settings holds every task setting. It is host-framed, like
General.

- **Task behavior.** Task lifecycle control and Completed task history moved
  here from General. They keep their keys (`agentTaskLifecyclePolicy`,
  `sidebarCompletedRetentionDays`).
- **Lead agent and model** (`leadModel`, mirrored by the settings context like
  `defaultModels`). Off means the default agent and model for new sessions.
  `SessionOpening.createTaskDraft` applies it to a lead draft through
  `runOnModel`; the draft's chip still changes it before Send.
- **Default worker model** (`workerModel`) and **Lead instructions**
  (`leadInstructions`) are settings of each host, because the execution host
  builds the lead's packet. `formatTaskContext` adds them after the lead
  contract, and only for a lead. They extend the contract; they never replace
  it. The worker model is a default: instructions that name another agent and
  model win. Routing rules ("frontend work to Claude, backend work to Codex")
  go in the instructions, because the lead already chooses each worker's
  agent and model with `start_session`.
- Each model setting also stores a reasoning level (`reasoningEffort`),
  chosen in the chip's reasoning column. The lead draft starts at it, and the
  packet names it as `reasoning_effort` for a worker. A selection saved
  without a level runs at the model's default.
- A model setting stores only Claude Code and Codex, as the other model
  settings do. Both backends get the same packet.

## States

- Lead running: its tab shows the run; a worker's question or permission shows
  as its card in the transcript.
- Lead stopped or idle: sending into its tab resumes it.
- Lead unavailable on this host: `openTaskLinkedSession` finds no record and
  the existing "session no longer available" path applies; the task page's
  Start lead is refused by the server while the link exists, and unlinking the
  lead from the Sessions list clears the way.
- Reconnect: the tab reducer restores the transcript as for any tab.
- Stale: `TaskSessionsList` reads live status from the tab or the host feed.

The row menus and the pull request links of sessions and tasks are in
`docs/plans/session-pull-requests.md`.

## Out of scope

- Subtasks, epic management, progress or rollup.
- Promoting an existing session to lead.
- Persisting orchestrator exchanges across restarts.
- A lead on an upstream ticket that has no Solus task row.
- Closing the aside task page when the selection moves to a session without a
  lead (decision 7).

## Verification

- Unit: one lead per task (`task-store`); `formatTaskContext` prints the lead
  contract for `lead` and not for `working` (`injected-context`); the Sessions
  list's lead detection and ordering and the four-tab strip (`task-page`); the
  Tasks and Sessions sections and the one-place rule (`sidebar-list-items`,
  `mobile-list-items`); which session a task row lists under itself
  (`task-list`); which tasks have a row (`session-sidebar-promotion`);
  the selection rule for a task row, a session row and the picker
  (`session-sidebar-selection`); a session's default task target
  (`session-task-target`); no task from a first prompt, and the bind of a
  named task (`session-runtime-observability`, `task-store`); the migration
  of earlier session records (`task-store`); the keys (`keybinding-manifest`).
- `bun run lint:surfaces` and `bun run lint:layout` on changed files.
- Desktop, web and mobile all mount the sidebar and `TaskPage`; the phone list
  gets the sections through the shared builder.
