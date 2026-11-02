# Task snooze

A snooze hides a task until a chosen time. It is an attention control, not an
execution control: the task keeps its status, and its agents keep working.

## Behavior

- **Snooze.** Snoozing a task hides it only for you. Use the **Snooze**
  submenu of the task context menu on the Tasks page. The choices are the
  shared snooze presets (15 minutes to next week). The task page has no snooze
  control.
- **Where it goes.** The Tasks page list and board leave a snoozed task out.
  The **Snoozed** filter shows only snoozed tasks, each with a "wakes in" chip.
  Tasks have no sidebar rows, so a task snooze moves nothing in the session
  sidebar.
- **Wake early.** Use **Wake now** in the context menu.
- **Expiry.** A task returns on its own at the wake time. Each list sets a
  timer for the next wake time, so the task comes back on time without a
  reload.
- **Independent of status.** A status change does not clear the snooze, and a
  snooze does not change the status or `updatedAt`.

## Ownership

A snooze is personal. It hides the task only for the person who snoozed it,
on every client that person uses. Other people who can see a shared task keep
it in their lists and are not told about the snooze.

- The host keeps snoozes as `personal_resource_state` rows of kind `task`
  (plans/029 §3.4), keyed by the task and the person (`created_by`, the user
  key `ownerKeyOf` gives the connection). The task record has no snooze, so
  task lists, task events, activity, sync, and publication never carry one.
  Waking deletes the row; deleting the task deletes every snooze of it in the
  same transaction.
- `tasksSnooze(id, until | null, note?)` writes the caller's own snooze. The
  person comes from the connection, never from the request. The caller must be
  able to read the task (viewer); the host itself and a runner are no person
  and cannot snooze.
- `tasksSnoozes()` answers the caller's own snoozes in their scope.
- `tasks.snoozesChanged` names nothing and goes only to the snoozing person's
  connections in the task's organization. Their clients read `tasksSnoozes`
  again, and they also read it on each reconnect.
- A snooze whose time has passed stays until the person wakes it or opens the
  task, so a client can show that the task woke. Deleting a task deletes every
  snooze of it.

## Limits

- Only Solus tasks can be snoozed. A provider-owned GitHub or Jira ticket has
  no Solus record to hold the wake time.
- The Solus API has no snooze, so the cloud console neither shows nor sets one.
- The native mobile app (`apps/mobile`) has no task list or task page yet
  (its README parity table lists Tasks as missing), so it cannot show or set a
  snooze. Desktop and web share the Svelte surfaces above.

## Schema

`personal_resource_state` is declared in `packages/server/src/data/personal-state/schema.ts`
and generated into the one baseline of each engine (docs/database-schema.md).
