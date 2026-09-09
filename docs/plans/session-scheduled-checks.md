# Scheduled checks in a session

Conversational follow-ups use `create_automation` with `run_in_session: true`.
Both Claude and Codex receive this instruction. “In 30 minutes” means one check;
“every 30 minutes” means a recurring check. Scheduling does not also run the
check immediately unless the user asks. Separate background work still uses
an unbound automation.

The scheduler resumes the existing conversation with its saved context. A busy
session queues the check, and the automation remains active until that turn
settles, which prevents overlapping runs of the same schedule. The host must
be running for checks to fire. After a restart it catches up one missed check,
not every missed interval. Closing a client does not stop a running remote host.

The conversation card reads live state from the automation store. All shared
client surfaces use the same card and host RPCs. One subscription per watched
host handles schedule changes and reloads after reconnect. An old list response
cannot overwrite a more recent event or restore a deleted schedule.

- Pause disables future checks and retains the trigger. Resume arms it again.
- Change opens the existing automation editor.
- Stop disables future checks and archives the automation, preserving its
  cadence and run history. If a check is running, archiving waits for it to
  finish. A failure leaves the automation visible for review.
- A queued or running check can finish after Pause or Stop.
- A successful one-time session check archives automatically after its turn
  finishes. Failed checks and paused schedules remain in the main list.

Each scheduled turn includes the schedule ID, the original prompt (including
any requested stop condition), and instructions to stop that specific schedule
when the condition is met. The agent evaluates the condition; Solus does not
try to parse or verify arbitrary external conditions itself. Stop preserves
history rather than deleting the automation. Stopped state does not assert that
the user's condition succeeded; the agent's reply records the result.

This uses the existing automation persistence, event contract, scheduler, and
session dispatch path. It adds no new scheduler or long-running agent process.

## Archive retention

The Automations page excludes archived records from All, Active, and Paused.
The Archived filter opens their saved prompts and run history. Schedule again
opens the existing editor; set a new schedule and enable it to restore it.
Restoring with `archived: false` keeps the automation paused. Permanent deletion
remains available. Standalone automations are not automatically archived.

Settings → General → Delete archived automations after controls the selected
host's `archivedAutomationRetentionDays`. The default is 30 days; accepted values
are whole numbers from 1 to 3650. Changes are persisted on the host and sent to
all connected clients. Agents cannot edit this retention policy.

The existing scheduler deletes expired archives on startup and hourly while the
host is running. A changed retention period is picked up on its next tick
(within about 30 seconds). Age starts at `archivedAt`, not creation or last-run
time. A shorter policy applies to existing archives. Running checks are never
pruned. Deleting an automation also deletes its automation run history through
the database foreign key. Session conversations and their messages remain.

Archive timestamps and pending stop requests use the existing JSON metadata in
SQLite; no database migration is required. These lifecycle rules apply to new
completions and archive requests; existing paused records are not reclassified.
