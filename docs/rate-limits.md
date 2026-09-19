# Rate-limit decisions

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
