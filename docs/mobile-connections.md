# Mobile connection and thread status

The Hosts screen shows the connection to each host. A connected host can
still fail to answer a request for projects and threads.

On iOS and Android, the workspace header shows a warning icon and “Could
not load threads” when that request fails. The crossed-out Wi-Fi icon is
used when no host is connected. A spinner shows a connection or list load
in progress. The normal title returns after recovery.

When no threads are available, a failed request shows the error and a
“Try again” action. It must not show “No threads yet” or “No projects
found”. “Try again” reloads the lists. It also retries hosts that are not
connected, without reconnecting hosts that are already connected.

The native title has a defined width within the space left by its actions.
Long error details belong in the screen content, outside the title.

This fixes the native mobile presentation and retry action. Desktop and
web use separate workspace components; the host protocol is unchanged.

## When a host freezes

A host whose event loop stops (its CPU is overloaded, or Solus does long
work) cannot answer pings. After 25 s each client drops it. A tunnel shows
this the same as a network drop, so only the host can tell why.

The host always watches for stalls with a one-second timer. It writes each
stall of 2 s or more to its log as `event_loop_stalled`, with the load
average and the CPU count. It keeps the last stall of 5 s or more. For
5 minutes, `connectionsGetServerInfo` returns it as `recentEventLoopStall`.
An older host does not send the field, and a client then shows nothing.

When a client reads that stall after it connects again, it shows one
notice, for example “leftbook stopped answering for 12 s. Solus on leftbook
was too busy to answer.” When the load average is more than the CPU count,
the notice says the computer was overloaded. Desktop and web show a toast
one time for each stall. On iOS and Android, the host's row on the Hosts
screen shows the same text while the connection that read it stays open.

## Settings on a connected phone

The filter at the top of Settings selects connected Solus hosts and their projects. Source control and issue tracker connections, maintenance, and scheduled tasks use that selection. The Worktrees page changes the person's branch naming defaults. The Projects page manages a selected checkout and shows name and default branch controls for a matching workspace project the person can edit.

Scheduled tasks are Solus automations. The phone can create, edit, pause, resume, run, and delete them. Fixed-time schedules keep their time zone. Custom cron schedules and existing end dates survive edits on the phone. A new run can use the project folder or a new worktree.

## Opening sessions on a phone

The phone applies title and status events to the session list. When the host names a changed session, the phone reads that record. A new connection with no event history, or a large set of changed records, starts a new list read.

The three most recently closed conversations keep their live watches until the phone needs the memory. A recovered connection replays missed events. A connection reset, a change in access, or a change to a mirrored transcript releases the affected saved watch.

After an app restart, the phone can show the first page saved for the current account and host. It sends the hashes of saved groups of messages with its history request. The host checks access and returns the current order, older-page cursor and changed groups. A host that does not support the hashes sends a complete page. Older messages still load when the reader scrolls back.
