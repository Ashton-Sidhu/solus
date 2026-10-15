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
