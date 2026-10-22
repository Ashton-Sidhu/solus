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
