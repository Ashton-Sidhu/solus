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
| System alert | Background | An OS notification (desktop) or a browser notification (web) |

"In front" is `document.visibilityState === 'visible' && document.hasFocus()`
(`isSolusInFront` in the store). The sound additionally asks the shell
whether the window is visible, which is how a window hidden to the tray counts
as the background.

On web, the open Solus tab shows the system alert. The browser shows it only
while a Solus tab is open; when no tab is open, no alert comes. The switch is a
host setting that every client shares, but the browser grant is per device. When the switch
is on and this browser has not answered, the row offers Allow; when the browser
has blocked notifications, the row says so. Turning the switch on asks too.
Settings is the only place to change it; the input bar has no notifications
control.

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

A session toast shows the same status glyph and color as the session's sidebar
row (`attentionStateForKind` into `SessionStatusGlyph`): the needs-input glyph
for an approval or a question, the error glyph for a failure, and the finished
check for a finished turn. System alerts keep the platform's own icon.

## App notices

| Event | Sources |
|---|---|
| Review guide ready | `reviewGuideStore.onReady` in `app-core.ts` (PR and session guides); the PR row in the project panel when the guide finishes after the row is gone |
| Review lens ready | `reviewLensStore.onReady` in `app-core.ts`, for a lens run this client saw start or run. A PR lens toast has **Open lens** |
| Software updates | Desktop: the download and restart prompts for the app itself (`desktop-updates.svelte.ts`). Any client: one notice for every Solus release on every connected host, with **Update all** (`host-update-notices.svelte.ts`). Claude Code and Codex releases are not announced; Settings, the header update button, and the palette offer them. See "Host updates" below |
| Teammates | "X joined" and "X left" in `presence.store` |
| Sharing | "Access removed by X" in `shares.store` |

A notice held back by its switch is not marked as shown: an update prompt
appears once the switch is turned on. A switched-off notice is still visible
where it lives — the Connections page lists updates, and the PR keeps its guide.

A host found on the local network has no toast. The Nearby list in the
Connections page shows it.

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

## Host updates

Host updates use one toast, however many hosts and Solus releases are pending.
One release reads "Solus 2.0.0 on Mac is available" with **Update**; more read
"3 updates available", list each one, and offer **Update all**. The toast shows
again only when a release the user has not seen appears.

The notice leaves out:

- a Claude Code or Codex release, which Settings, the header update button, and
  the palette offer;
- a host with a busy session, until it is idle;
- a host whose Solus update is already running;
- a Solus release this client cannot install on the host;
- a cloud host, which Solus cloud keeps up to date.

`hostUpdater` (`host-updater.svelte.ts`) is the one way this client updates a
host. The notice's **Update all**, a Settings row's **Update**, the header
button, and the palette all call it, and they all report in the same toast.

- Each host has a lock. Its updates run one at a time, in the order they were
  asked for, and an update that is already queued or running is not started
  again.
- Provider CLIs update before Solus, because the Solus update restarts the
  host. While Solus updates a host, nothing more starts there.
- Different hosts update at the same time.
- A Solus update counts as done only when the host reports that the update
  finished after its restart.

Every update started before the last result was reported belongs to one batch.
The toast shows the batch's progress, then one result that counts the updates
and names each failure. While a Solus update waits for active work, the toast
offers **Cancel Solus update**.

The lock covers this client. The host also runs one install at a time for each
provider, and one Solus update at a time, so two clients cannot install the same
thing at once either. A Solus update started from another client shows only in
Settings on this client.

The desktop app's own update stays separate, and so does mobile, which shows
host updates in Settings only. The Settings header button and the command
palette ("Install N host updates") start the same run.

## Mark a session unread

Choose **Mark Unread** from a session context menu on desktop or web, or from
the session row menu on mobile. The action marks only that session unread.
Task context menus do not offer this action. The host stores the read state
and sends changes to connected clients. Open the session to mark it read again.
