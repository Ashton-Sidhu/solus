# Notifications

Delivery turns on one condition: whether Solus is in front. Settings →
Notifications states it once per group, so each row is only a channel:

- **While Solus is in front** — the window has focus and a session that is
  not on screen needs you. Channel: **Toast**.
- **While Solus is in the background** — the window is hidden, minimized, or
  another app has focus. Channels: **Sound**, **System alert**.
- **Session events** — what an agent did. A session event is delivered only
  when the event is on and the channel for the current situation is on; every
  channel off is "none".
- **App notices** — what happened around the workspace. Always an in-app toast
  in either situation; the event switch is the only gate.

## Channels

| Channel | Situation | What it does |
|---|---|---|
| Toast | In front | An in-app toast with **Open session** |
| Sound | Background | Plays `resources/notification.mp3` |
| System alert | Background | An OS notification (desktop), a browser notification (web), or a web push to a device that is away |

"In front" is `document.visibilityState === 'visible' && document.hasFocus()`
(`isSolusInFront` in the store). The sound additionally asks the shell
whether the window is visible, which is how a window hidden to the tray counts
as the background.

On web and mobile, the system-alert switch also owns the web-push subscription:
on subscribes this device, off unsubscribes it. The bell in the mobile session
list is the same switch.

## Session events

| Event | Sources |
|---|---|
| Needs approval | `permission_request` event; `needs_approval` attention entry |
| Question | `question_request` event; `question` attention entry |
| Turn finished | `turn_settled` event; `finished` attention entry. A turn that ends with background work still running (`background` status) does not count; it notifies when the agent's real end arrives |
| Session failed | `failed` attention entry |
| Plan ready | `plan` event |
| Work created | `work_created` and `artifact_created` events |
| Task created | `task_created` event |
| Automation saved | `automation_saved` event |
| Agent conversation | A sub-agent posts a new card or needs attention |

The sound covers every event. Toasts and system alerts are driven by attention
entries, so they cover approvals, questions, failures, and finished turns; the
page says so in the Delivery section.

## App notices

| Event | Sources |
|---|---|
| Review guide ready | `reviewGuideStore.onReady` in `app-core.ts` (PR and session guides); the PR row in the project panel when the guide finishes after the row is gone |
| Software updates | Desktop: the download and restart prompts (`desktop-updates.svelte.ts`). Any client: "Solus / Claude Code / Codex X is available on host" (`host-update-notices.svelte.ts`) |
| Host found nearby | LAN discovery in `servers.store` |
| Teammates | "X joined" and "X left" in `presence.store` |
| Sharing | "Access removed by X" in `shares.store` |

A notice held back by its switch is not marked as shown: an update prompt or a
discovered host appears once the switch is turned on. A switched-off notice is
still visible where it lives — the Connections page lists updates and nearby
hosts, and the PR keeps its guide.

Toasts that answer an action the user just took — "Copied", "Saved", "Task
created", "Started generating the review guide", a manual update check's
"up to date", the "Following X" banner — are feedback, not notifications, and
are not affected by these switches. Errors are never suppressed.

## Where it lives

- Contract: `NotificationPreferences` in `packages/contracts/src/notification-types.ts`,
  with the event mappings for sound triggers and attention kinds.
- Host config: the `notifications` key. It follows the user between devices;
  the host merges a partial patch so one switch does not reset the others.
  `soundEnabled` and `backgroundActivityToasts` are the flags it replaced; a
  stored config that still carries them is read once and migrated.
- Store: `notificationsStore` in `packages/workspace-ui/src/contexts/notifications/`
  is the one place a session notification is decided. It reads the preferences
  on every delivery and owns the sound, the toast, and the system alert. App
  notices ask it `wants(event)` before raising their toast; singleton stores
  have no settings context of their own, and before the shell starts the store
  the defaults answer.
- Server: web push applies the event switches before sending to a device that
  is away; the channel switch is applied by the device through its subscription.
- Page: `SettingsTabNotifications.svelte`, with the row catalog in
  `components/settings/lib/notification-settings.ts`. A test asserts the catalog
  covers every channel and event in the contract.
