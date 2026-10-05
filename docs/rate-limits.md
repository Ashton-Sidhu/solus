# Rate-limit decisions

Settings → General → Rate limit behavior applies to the selected host. All
clients connected to that host share the choice; other hosts keep their own
choice. Existing host settings are kept. A new host defaults to Ask and does not
import a client’s saved rate-limit preference.

The host owns the state of a rate-limited run. User-started runs read the current
host rate-limit setting when the limit arrives, including retries started before
that setting changed. Agent and automation runs keep their explicit retry policy.
A client's stale setting does not control how it displays the host state.

Desktop, web, and mobile show the decision card when the host reports a rate limit
and no retry is queued. The card offers Queue prompt, Send now, and Stop & discard.
After the host confirms a queued retry, the queue shows its state instead of the
decision card. A failed queue request must leave the decision available.

Reloads and reconnects use the host’s rate-limit details and queued prompts to
restore the same view. This rule applies to both Claude and Codex, over local IPC
and remote connections. An unknown reset time does not trigger an automatic retry.

A structured rejection can be followed by a terminal error with no window or reset.
That error must not erase the reset already known for the held run. The host sends
queue confirmation before the rate-limited status to prevent a decision-card flash
when it automatically queues a retry.

## Limited status

A rate-limited session has its own status: **limited**. It is not the same as a
queued prompt. The session row, the session tooltip, the breadcrumb, the task
page, and the mobile list show it with an amber hourglass. When the provider
gives a reset time, the label adds it, for example "rate limited, resets 3:40
PM". When the provider does not give a reset time, the label does not show one.
A limited session does no work, so its row does not show a working timer.

## Snooze until the limit resets

When a session is limited and its reset time is known and still ahead, the
decision card and the session snooze menu show **Snooze until limit resets**. It
uses the usual session snooze (`sessionSnooze`) with the reset time as the wake
time. When the reset time is unknown or has passed, the option does not show.
Only a session row can be snoozed; a task row cannot, so the decision card hides
the option for a session that a task row stands for.
