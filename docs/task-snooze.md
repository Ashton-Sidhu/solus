# Task snooze

A snooze hides a task until a chosen time. It is an attention control, not an
execution control: the task keeps its status, and its agents keep working.

## Behavior

- **Snooze.** Snoozing a task hides it only for you. Use the **Snooze**
  submenu of the task context menu (Tasks page and sidebar), or the snooze
  button on the task's sidebar row. The choices are the shared snooze presets
  (15 minutes to next week). The sidebar snooze menu also has **Pick date and
  time…**, which uses the shared date and time picker, and an optional
  reminder note. The task page has no snooze control.
- **Where it goes.** The Tasks page list and board leave a snoozed task out.
  The **Snoozed** filter shows only snoozed tasks, each with a "wakes in" chip.
  An open task's sidebar row moves to the Snoozed shelf.
- **Wake early.** Use **Wake now** in the context menu, or the sun button on
  the sidebar row.
- **Expiry.** A task returns on its own at the wake time. Each list sets a
  timer for the next wake time, so the task comes back on time without a
  reload.
- **Independent of status.** A status change does not clear the snooze, and a
  snooze does not change the status or `updatedAt`.

## Ownership

A snooze is personal. It hides the task only for the person who snoozed it,
on every client that person uses. Other people who can see a shared task keep
it in their lists and are not told about the snooze.

- The host keeps snoozes in their own table, `task_snoozes`, keyed by task and
  person (`person_key`, the user key `ownerKeyOf` gives the connection, as
  notifications use). The task record has no snooze, so task lists, task
  events, activity, sync, and publication never carry one.
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

## Migration

`0009_task_snooze` creates the `task_snoozes` table. It follows `0007_task_location` and
`0008_task_session_started_by`, and its snapshot is based on the `0008`
snapshot. Its journal `when` is later than theirs, so a host that already ran
`0007` and `0008` applies only `0009`.
