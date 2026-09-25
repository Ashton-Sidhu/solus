# Task conversation: the lead session

Status: proposed, 2026-09-25. Task 01M3AZ4M9Z4YNKD6TGDY2300B0.

A task gets one continuous conversation. The user types a prompt into the task
page. A long-lived session, the **lead**, reads it, starts worker sessions on
the task, hears their reports, and answers the user. The task page keeps every
section it has today and gains that conversation as its default input.

The comparison the maintainers used: Claude Projects and Cursor. The task is the
project container. Its description, links, works, plans, PRs and comments are
the persistent context, already injected into every task-bound session as the
task packet. The lead is the one long chat over that context. Workers are the
parallel agents, but each is a first-class Solus session with its own tab,
transcript, worktree and PR.

## Vocabulary

- **lead** — the one session that owns a task's conversation. Role `lead` on
  `task_session_links`.
- **worker** — a session the lead starts on the same task. Role `working`, an
  attempt like any other.
- **task conversation** — the lead's transcript and input as rendered on the task
  page.
- **lead contract** — the rules appended to the lead's task packet.

Do not coin "orchestrator session", "parent session", "root chat" or "task
thread". The orchestration layer's own word for a session that started another
is *parent*; a lead is a parent, but a parent is not always a lead.

## Decisions

1. The conversation is the task page's default input. The comment composer moves
   into the Activity section.
2. Only a session started as lead is lead. There is no promotion of an existing
   session and no "Make lead" or "Release lead" control.
3. Workers are **attempts on the same task**, never subtasks. Solus does not
   manage epics (task 01M3BC67J3RZDXQTYKMCPBA9EB removes local epic management
   and the `subtask` option on `start_session`). An epic is an upstream snapshot
   on the task, and its description reaches the lead through the packet.
4. The lead does **very small** direct work only. Its thread must stay small so a
   cache miss on a long thread does not spend the user's limits. The contract
   says this and keeps the lead's own reads and replies short.
5. The session sidebar gets a **Leads** section. A task with a lead is listed
   there, not in the active column. The lead's tab is an ordinary tab
   everywhere else.

## What exists already

- Orchestration: `start_session`, `send_session`, `stop_session`,
  `read_session`, `read_task_sessions`, reports and notices delivered into the
  parent, and the card in the parent's transcript where a person answers a
  child's question, plan or permission. `docs/session-orchestration.md`,
  `packages/server/src/orchestration/`, `packages/server/src/sessions/session-tools.ts`.
- Task binding at first dispatch: `prepareSessionTask` in
  `packages/server/src/tasks/task-sessions.ts`, called from the renderer's
  `prompt-dispatch.ts` through `tasksPrepareForSession`; the link on
  `session_init` for a dispatched host.
- The task packet: `formatTaskContext` in `packages/server/src/tasks/task-context.ts`.
- The task page: `packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte`
  with its Sessions list, Activity feed, comment composer and properties rail.
- A conversation outside the main tab: `components/conversation/ConversationPane.svelte`
  renders `ConversationView` and `EditorInputCard` for a mounted tab.

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
rides `TaskSessionLink.role` in `sessionsByTask`, so every client sees it.

Server rule, in `writeSessionLink` (`task-sessions.ts`): a task has at most one
`lead` link. A second lead is refused with an error the renderer shows. A `lead`
link transfers session ownership exactly as `working` does.

## Server

1. **Prepare.** `prepareSessionTask` accepts `role` and passes it to
   `writeSessionLink`. The `tasksPrepareForSession` handler and
   `tasksLinkSession` handler in `packages/server/src/server/handlers/tasks-handlers.ts`
   forward it.
2. **Lead contract.** `formatTaskContext` gains a `role` argument. For `lead` it
   appends, after the work contract:
   - You coordinate this task. You do not implement beyond very small edits.
   - Start workers with `start_session` (`task='attempt'`, this task's id), one
     worktree each (`worktree_base_branch`), with the full brief in the prompt.
     A worker does not see this conversation.
   - Keep `report` on and do not poll. Answer the user from reports,
     `read_task_sessions` and linked items. Do not read transcripts or source
     files to answer; ask a worker instead.
   - Keep replies short: what happened, what was produced with its link, what is
     open. Write durable summaries into the task body or a task comment.
   - Link every pull request. Move the task to in_review when a pull request is
     ready for a human.
   - On a new user message, read `read_task_sessions` first.
   The system hint in `packages/server/src/agents/system-hint.ts` does not
   change; the packet is the one place the contract lives.
3. **Role lookup.** The control plane already resolves the task for a session
   when it builds the packet (`control-plane.ts`, around the
   `sessionTaskPreparer` path). It passes the session's link role from
   `taskSessions()`.
4. **Provider parity.** Claude Code and Codex both receive the packet and both
   have the session tools through `solusToolbox`. No provider-specific work.
5. **Restart.** Orchestrator state is in memory; open exchanges end on restart
   and the lead is told (`CHILD_INTERRUPTED_BY_RESTART`). The contract's
   "read first" rule is the recovery.

## Renderer

1. **Start path.** `openTaskSession(task, { role: 'lead' })` in
   `contexts/workspace/session-opening.ts` opens a task draft that carries the
   role (`session-drafts.svelte.ts`). `prompt-dispatch.ts` sends it in
   `prepareForSession`. The `session_init` reducer sends it in `linkSession`
   for a dispatched host.
2. **Conversation region.** In `TaskPage.svelte`, under `TaskHeader` in
   Overview:
   - With a lead link: reveal the lead as a background tab through
     `session.workspace.revealSession(sessionId, serverId, { background: true })`,
     then render `ConversationView tabId forceVisible` and
     `EditorInputCard tabId paneId`, as `ConversationPane.svelte` does. The tab
     stays mounted while the page is visible. Leaving the page does not close it;
     the tab strip shows it as any session.
   - Without a lead: an `InputBar` composer bound to a lead draft. The first send
     starts the lead and the region switches to the transcript.
   - Without a workspace (the organization's workspace service only): the lead's
     read-only transcript through `session/record/RecordTranscript.svelte`, no
     composer, and a line saying where it runs.
3. **Composer placement.** The conversation composer is the page's bottom bar on
   every rung. The comment composer moves inside the Activity section, above the
   feed. On the stacked rung, Conversation is the first tab, and the bottom bar
   shows the conversation composer on that tab and the section action on the
   others, as `bottomAction` does today.
4. **Sessions list.** `TaskSessionsList.svelte` pins the lead row first with a
   "Lead" mark, workers below unchanged. Stop, open, split and unlink work on the
   lead as on any row. Unlinking the lead clears the conversation region back to
   the empty composer.
5. **Focus.** After the lead is started, and after any card answer in the region,
   focus returns to the conversation composer.
6. **Sidebar: the Leads section.** The sidebar is one flat list built by
   `buildSidebarListItems` in `components/session/lib/sidebar-list-items.ts`
   (drafts, the active column, the Snoozed shelf, the Completed shelf). Each
   task row already nests its sessions from `TaskSessionLink.role`.
   - Add `'leads'` to `SidebarSection` and to the `header.section` union. In
     `buildSidebarListItems`, add a `shelf('leads', …)` before the active column,
     so it is the first thing under the drafts.
   - In `session-sidebar.store.svelte.ts`, add `leadTasks`: the active tasks
     whose `sessionsByTask` entry has a `lead` link. Remove them from
     `visibleTasks`. A row lives in exactly one place, as today: lifecycle still
     wins, so a snoozed or completed task with a lead goes to its shelf.
   - The row is the existing task row. Its first child is the lead, marked
     "Lead", then the workers by `linkedAt` as today. `buildSessions` orders the
     lead first.
   - Open state is `leadsShelfOpen`, local to the component like the other
     shelves, default open. A header branch in `SessionSidebar.svelte` beside
     Snoozed and Completed.
   - Selecting the row opens the task page, where the conversation is. The
     lead's own tab stays reachable from the row's child and from the tab strip.
     `openTaskLinkedSession` in `session-opening.ts` prefers the lead over the
     latest attempt.
   - Phone: `apps/client/src/shell/mobile/lib/mobile-list-items.ts` wraps the
     same builder, so the section arrives by itself; add its header branch in
     `MobileSessionList.svelte` and keep it open like Snoozed.
   - Tests: `tests/unit/sidebar-list-items.test.ts` for the section order and
     the one-place rule; `mobile-list-items.test.ts` for the phone.

## States

- Loading: the region shows the page skeleton until the lead's tab is revealed.
- Lead running: the composer is enabled; a worker's question or permission shows
  as its card in the transcript.
- Lead stopped or idle: the composer is enabled; sending resumes it.
- Lead unavailable on this host: the existing "session no longer available"
  toast, and the region offers to start a new lead.
- Reconnect: the tab reducer already restores the transcript; the region reads
  the same tab.
- Stale: `TaskSessionsList` reads live status from the tab or the host feed as
  today.

## Out of scope

- Subtasks, epic management, progress or rollup.
- Promoting an existing session to lead.
- Persisting orchestrator exchanges across restarts.
- A lead on an upstream ticket that has no Solus task row.

## Verification

- Unit: one lead per task (`task-sessions` test); `formatTaskContext` prints the
  lead contract for `lead` and not for `working`; `prepareSessionTask` writes the
  role.
- Renderer: the task page shows the composer with no lead and the conversation
  with one; the comment composer is inside Activity; the lead row is first.
- `bun run lint:surfaces`, `bun run lint:layout`, `bun run lint:hosts` on changed
  files.
- Desktop, web and mobile all mount `TaskPage`; check the stacked rung on a
  phone-width pane.

## Sequence

1. Contract, server rule, prepare path, lead contract, unit tests.
2. Renderer start path and the conversation region with a lead present.
3. Empty state, composer placement, Sessions list mark, focus.
4. Console read-only case.
5. Docs: a section in `docs/session-orchestration.md` naming the lead.
