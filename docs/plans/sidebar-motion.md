# Sidebar motion: stable rows, narrow updates, one list

**Status:** Steps 1 and 3 implemented on every client, step 2 partly implemented (2026-09-22); step 0 (a measurement) not started. See each step's status section.

**Goal:** the session sidebar animates as smoothly as T3 Code's. A row that arrives, leaves, or moves animates once, from start to end, and nothing else in the column moves while it does. A streamed message in one session does no work for the other rows.

**Where this comes from:** task "Newest Sessions First". That task made the column newest-first and flat, and ported T3 Code's list motion (`components/session/lib/sidebar-list-motion.svelte.ts`, from T3 Code's `Sidebar.motion.ts`). The motion itself is correct: a frame-by-frame sample in headless Chromium shows a displaced row slide 138 → 203 px in 150 ms and stop with no jump. What remains is the sidebar's data model, which this plan changes.

## Vocabulary

- **row** — one entry in the sidebar's task list: a durable task, or a loose session that has no task. A session can stay taskless for good — a draft opened without a task, an automation draft, or a prompt whose task host binding failed — so loose rows are a supported case, not a legacy path. This plan keeps them.
- **row identity** — the key the list renders a row under. One row keeps one identity from the moment it appears until it leaves.
- **promotion** — a loose session row becoming a durable task row when its first prompt mints a task.
- **order key** — the row identities in list order, joined. The motion pass runs only when it changes.
- **section** — a part of the one list: drafts, active, Snoozed, Completed. A section is a header in the list, not a separate list.

Do not use "loose task", "pending row", or "shelf list" in new code. A Snoozed or Completed "shelf" is a section.

## Why T3 Code is smooth

Five properties. Each claim is checked against T3 Code's `apps/web/src/components/Sidebar.tsx` and its helpers.

1. **Identity never changes.** The client mints a thread id (`randomUUID`) before any server round-trip and sends it with the first turn. The server keeps that id, so the row is keyed the same way for its whole life.
2. **Order is static.** Rows sort by creation, never by activity.
3. **Heights are fixed.** Card and slim rows have fixed heights, late data cannot change a row's height, and `content-visibility: auto` with a matching `contain-intrinsic-size` skips rows off screen.
4. **Updates are narrow.** A server event gives a new object only to the thread that changed (a `WeakMap` cache on the shell). Rows are memoized; each reads its own store slice. Git and pull-request data load only for rows near the viewport (an `IntersectionObserver` lease).
5. **Motion runs on order changes only**, over one flat list that holds every section.

## Where Solus stands

| Property | Solus | Evidence |
|---|---|---|
| Identity | **Changed on promotion** (fixed by step 1). A new session showed under its tab id; `prepareForSession` minted the task one round-trip later and the row returned under the task id. | The list faded one row out and another in exactly as the arrival settled. |
| Order | Static (creation, newest first). | `sortSidebarRowsByCreation` |
| Heights | Fixed. No `content-visibility`. | `TaskRow.svelte` (`h-[3.875rem]` / `h-[2.25rem]`) |
| Narrow updates | **No.** `allTasks` reads `session.messages` for every open tab, so a streamed message in any session rebuilds every row. Each row also runs two linear `taskForTab` scans and rebuilds its pull-request choices on every render. | `session-sidebar.store.svelte.ts`: `lastActivityAt`, `firstActivityAt`, `turnStartedAt`; `SessionSidebar.svelte` `taskRow` snippet |
| One list | **No.** Drafts, active, Snoozed, and Completed are four containers. A draft appearing shifts the column with no motion; a move between sections fades instead of sliding. | `SessionSidebar.svelte` |

The two sidebar files are also past the renderer's hard limit: `session-sidebar.store.svelte.ts` is 1,703 lines and `SessionSidebar.svelte` is 1,518.

## Step 0 — Measure

Before step 2, record one Performance trace in the running desktop app while one session streams and the sidebar holds at least ten rows. Record the scripting time per frame spent in the sidebar's derived values. This gives the number step 2 must reduce. It needs no code change; the developer records it.

## Step 1 — Mint the task id on the client

**Change:** the client mints the task id (a ULID) when it creates a session for a new task, and sends it on `tasksPrepareForSession`. The loose row then carries that id from its first frame, and promotion changes the row's contents, never its identity.

- **Contract:** `tasksPrepareForSession` input gains `taskId?: string`, the id for a task this call mints (`packages/contracts/src/rpc.ts` and the host-api types). It is invalid together with `existingTaskId`, which binds a task that already exists. With `parentTaskId` it names the new subtask (see "Decisions").
- **Server:** `prepareSessionTask` passes it to `writeTask`, which already accepts a pre-minted id (`task-store.ts:274`, `id?: string`, added for runner-minted ids in `cloud-service-model.md` §16). The server rejects an id that is not a ULID and treats an id that already exists for the same session as a retry, returning that task.
- **Workspace service:** a cloud-owned task (`tasksAreCloudOwned`) is written by the workspace service. It must accept the same id. Check the workspace service's task create path before starting.
- **Renderer:** `TaskTarget` `{ kind: 'new' }` carries the minted id; the store builds the loose row with `id = taskId` before the task exists. When the task arrives, `buildDurableTaskRow` produces a row with the same id.
- **Removes:** `lib/sidebar-row-keys.ts`, its test, and `keyedSearchedTasks` in `SessionSidebar.svelte`. A taskless session keeps its loose row under its tab id for its whole life, so it never changes identity and needs no key inheritance either.
- **Providers:** Claude and Codex both start through `prepareForSession`; no provider difference.
- **Connection modes:** desktop-local, desktop-hosted, and remote all mint in the renderer, so all three get the same id. A reconnect that resends the prompt reuses the id (idempotent by id).

**Tests:** the server keeps a client-minted id; a repeated prepare with the same id and session returns one task; a malformed id is rejected. In the store: a loose row and the durable row that replaces it have the same `id`.

### Step 1 — status

Done, with two changes from the text above, both decided 2026-09-22:

- **Row identity is `listKey`, not `id`.** A loose row's `id` is its tab id, and its done and snooze state are keyed by that (`doneTaskIds`, `rowSnoozes`), so `id` keeps its meaning. `SidebarTask.listKey` is the key the list and the motion render under: a durable row's task id, a loose row's planned task id (`newTaskId(session.task)`), else its tab id.
- **Every id that already names a task is refused.** The prepare call carries no session id, so the host cannot tell a retry from a second session. A client does not retry a prepare (a failure sends the prompt without a task), so refusal is safe.

What changed:

- `@solus/contracts/ulid` mints and checks ULIDs with Web Crypto for every side. The server's `tasks/ulid.ts` is gone; its importers use the contracts copy.
- `TaskTarget` `{ kind: 'new' }` carries `taskId`. `makeSession` assigns a fresh one to every such session — new, forked, and restored — so a copied target never shares an id. Drafts carry none.
- `PrepareSessionTaskRequest.taskId`; `prepareSessionTask` writes the task under it, and refuses a malformed id, an id already in use, or an id sent with `existingTaskId`. A subtask takes one the same way.
- `prompt-dispatch.ts` sends the planned id on the first prompt.
- `lib/sidebar-row-keys.ts` and its test are deleted.

Tests: `task-store.test.ts` (kept, subtask, refused), `session-planned-task-id.test.ts` (fresh per session, never shared, only for `new` targets), `sidebar-task-order.test.ts` (a durable row's `listKey` is its task id).

## Step 2 — Rebuild only the row that changed

**Change:** a streamed message must not invalidate the column.

- **Take message reads out of `allTasks`.** `activityAt` has two readers: the reconcile equality check and `compareTasks`, which only the pickers use (`sortTasks`). Remove it from `SidebarTask` and compute it inside the picker from the session.
- **Read scalars, not transcripts.** `createdAt` needs the first message timestamp and `runStartedAt` the turn start. The session event reducer already sets `currentTurnStartedAt`; add `firstActivityAt` to the session the same way, written once. The column then reads two scalars that change once per session or once per turn, not per message.
- **Build per-row answers once.** Replace the per-row `taskForTab(session.onScreenTabId)` calls with one derived `onScreenTaskId` in the store. Cache `prChoicesFor(task)` per row identity and invalidate it when the row's pull-request inputs change (the linked PR set, the branch, the mounted PR observation).
- **Split the files** as part of this step, along the seams it creates: the row projection (`allTasks`, `buildDurableTaskRow`, loose rows) into its own module; pull-request choices into another. `SessionSidebar.svelte` loses the task list into a `TaskList.svelte` component.

**Tests:** a message appended to one session leaves every other row's model object identical (`toBe`), and does not change the list's order key. The pickers still rank by urgency, then activity.

### Step 2 — status

Done:

- `SidebarTask.activityAt` is gone. `sortTasks` and `buildProjectSummaries` take a `RowActivity` function; the store answers it with `activityAtFor`, which the breadcrumb pickers call, and which the phone list passes to each `MobileTaskRow` as its own `activityAt` prop for the row's timestamp.
- `contexts/workspace/session-activity.ts` holds the column's session reads. `firstActivityAt` walks indices and never reads `length`. `sessionTitle` does the same. (`for…of`, `find`, and `at(-1)` all read `length`, which subscribes the reader to every streamed message.)
- A child session's `lastActivityAt` is a lazy getter (`withLazyActivity`), so building `sessionsByTaskId` never reads a transcript; only a picker or a selection that asks depends on it.
- `onScreenTaskId` is one derived value; each row compares against it instead of scanning the column twice.
- `tests/unit/session-activity.test.ts` asserts, through a recording proxy, that these reads never touch `length`.

Not done:

- **Pull-request choices are not cached.** Not needed for this goal: an unchanged row keeps its model object (`reconcileSidebarTasks`), so its snippet does not re-run.
- **The files are not split.** Another session edits `session-sidebar.store.svelte.ts` at the same time; a large move now would conflict with that work. Split it when that work lands.
- **No measurement.** Step 0 is still open; the change is proven by the read-tracking test, not by a trace.
- `turnStartedAt` still scans the transcript for a running session whose turn start was never recorded. That is rare (the reducer and prompt dispatch set `currentTurnStartedAt`).

## Step 3 — One list

**Change:** drafts, active, Snoozed, and Completed render as one list under one motion container, with section headers as list items (T3 Code's marker items).

- The order key includes each row's section, so a move from active to Completed is an order change and slides.
- A collapsed section renders its header and no rows. The row you are reading stays visible even inside a collapsed section, as today.
- Drafts join the list as their own section at the top. A draft appearing or leaving is then an order change.
- Keyboard: the tree navigation already walks `[role="treeitem"]`; headers are not tree items.
- Add `content-visibility: auto` with `contain-intrinsic-size` equal to each row variant's fixed height.

**Tests:** the order key changes when a row changes section and when a draft appears; a collapsed section contributes its header only.

### Step 3 — status

Done on every client: desktop and web (`SessionSidebar.svelte`) and the phone (`apps/client/src/shell/mobile/MobileSessionList.svelte`).

- `lib/sidebar-list-items.ts` builds the one list: drafts, a divider, the active column, then each shelf's header and rows. A task's element key is `listKey` plus its variant (`card` for active, `slim` for a shelf), as T3 Code keys `thread:variant`: a row that changes shape cross-fades, and a slim row moving between Snoozed and Completed keeps its element and slides. `sidebarListOrderKey` adds each row's section, so a section change is an order change.
- A collapsed shelf shows its header and the row on screen, if it is on that shelf (T3 Code keeps the open thread visible the same way).
- Drafts are tree items now (`DraftRow` `role="treeitem"`), so the arrow keys walk drafts and tasks as one list.
- `sidebarListMotion` takes the order key; one motion container holds every entry.
- **The timing is a setting.** Settings → General → Behavior → "Sidebar animation" sets `sidebarMotionMs`, a host-config key (0–600 ms, default 150, T3 Code's timing; 0 turns the motion off). Both the desktop sidebar and the phone list read it; the motion reads it at each change of order, so a change applies at once. Reduced motion still turns the motion off whatever the setting says.
- Tests: `tests/unit/sidebar-list-items.test.ts`.

- The phone builds its list with `apps/client/src/shell/mobile/lib/mobile-list-items.ts`: the same task entries, led by the entries only the phone shows here — labelled drafts, pinned sessions (as T3 Code lists pins in its one list), and presence. A search lists tasks only. Snoozed is always open on the phone, which has no control to collapse it. A task and the runs listed under it move as one entry. Completed no longer opens with its own `slide`; its rows fade in as a change of order. Tests: `tests/unit/mobile-list-items.test.ts`.

Not done:

- **Row height changes are not animated.** On the phone, an active row grows when it lists its runs, and the rows below it move without motion, as before. T3 Code does the same: its motion runs on changes of order only.
- **`content-visibility: auto` is left out.** Its paint containment would clip a row's hover wash, which is painted outside the row's box (`-mx-2`). The column is short enough that skipping off-screen paint buys little.

## Surfaces

- **Clients:** desktop, web, and mobile render the same `SessionSidebar`; every step applies to all three.
- **Entry points:** the command palette and pickers read `sortTasks`; step 2 moves activity into them and must keep their ranking.
- **Reverse states:** collapsing a section must be undone by expanding it; a draft discarded must leave with motion.
- **Docs:** update `docs/plans/project-model.md` §5 when step 3 changes the section layout.

## Decisions to make before step 1

1. **Subtasks.** A fork mints its subtask after its first turn (`parentTaskId`). Should a subtask also take a client-minted id? Recommended: yes, the same rule, so a fork's row never changes identity either.
2. **Retry semantics.** An id that exists for a *different* session: reject, or return the task? Recommended: reject; a collision there is a bug, not a retry.

## Order of work

Step 1 and step 2 are independent. Step 2 stays in the renderer and needs no contract change, so it can land first. Step 3 depends on step 1 (one identity per row) and step 2 (a cheap order key).
