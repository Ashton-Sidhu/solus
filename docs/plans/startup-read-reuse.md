# Startup read reuse

A client must reuse a successful read when its owner and input have not changed.
A failed read must remain retryable. A state change, reconnect, or explicit refresh
can require another read.

## Slash commands

Desktop and web share the workspace lifecycle store. Each session retains the
host, provider, and directory of its loaded commands. An empty composer retains
its commands and the same source fields. Ordinary calls reuse those results and
join identical requests still in progress. A skill edit explicitly bypasses the
stored result. The desktop and web shells do not start command reads from a
reactive effect; boot and provider/directory commands own them. Built-in commands belong to a provider session, so two different
sessions can each need a read even when their directories match.

## Checkout identity

An empty path list requests all checkouts known to the host. It is a useful
startup snapshot. A later request can include a newly selected path. Concurrent
readers of the same new path already share its request. Host events and reconnect
recovery keep checkout state current.

## Notifications

Desktop and web wait for the account store's first answer before starting a feed.
The initial signed-out value is provisional and must not start a device feed that
is immediately replaced by an account feed. Mobile already loads the account and
host registry before restoring a route or connecting to a host.

## Reads that must remain separate

Git watcher summaries remain cheap; visible file details have a separate owner. A PR link change
for one session must refresh that session. Network discovery and connection wake
checks can repeat. A function name alone does not identify a duplicate request.

## Run on and discovery

The Run on menu reads clone-source identities and probes host reachability when
its content opens. Mounting a closed picker does not start these reads. Destination
choices wait while the source host's identities load. The project catalog still
loads at connection time: grouping by a primary remote and cloning from `origin`
are different operations, particularly for forks.

Automatic discovery keeps one timer while the window is active. Focus, visibility,
and connection events do not restart that timer. After a successful scan, automatic
requests reuse its result for 30 seconds. A user scan and a scan after forgetting a
host bypass that age check. A failed scan remains retryable.

## Git reads

An explicit details or full refresh requests summary and details together. A full
refresh includes project refs in that request. Older hosts that omit refs retain
the separate refs fallback. A forced refresh waits for earlier scans before it
starts, so a read before a Git mutation cannot replace the result after it.

Desktop and web restore a selected conversation with summary and file details
in one read. Later file detail subscriptions run only while the Git section is active. The
Environment section uses summary fields and does not subscribe to details.
Subscriptions track the selected host and checkout, not cache writes or changes
to unrelated tabs. Closing the panel or hiding the tab releases its subscription.
Repository setup and PR reads also wait for an active Git section. The native mobile client does not call these Git read methods. This change does
not alter the shared host RPC contract.

Repository status is distinct from branch identity: it can describe an initialized
repository with no commit or remote. Checkout snapshots carry canonical identity
and revision state. These reads cannot be removed based on their names alone.

## History and session PR changes

Startup prefetch and restoration use the saved Solus session id. A provider thread
id remains the fallback for an old snapshot. Both paths use the same cache key,
so the prefetched page supplies first paint and normal hydration without a second
read. Reconnect and later visits still read current history.

Session PR change events share a fixed 50 ms batching window per host API,
including events delivered in separate transport tasks.
Desktop, web, and native mobile use the same batch reader. An event after a read
starts queues a later read, and reads run in order. A failed batch does not retain
an answer. A reply from a replaced connection does not update the current store.
The initial full snapshot remains separate from later change reads.

The initial checkout snapshot includes the directories of visible restored tabs, even
when the host has not loaded them yet. A selected checkout waits for a host
recovery snapshot already in progress. If
that snapshot contains the path, it supplies the identity. A missing path or failed
recovery still permits the selected path's own read.

## Effect ownership

Shell lifetime subscriptions use mount hooks, which install once and release on
unmount. Reactive effects remain for selected host or project changes and for
subscriptions whose active state can change. Their request and cache operations
run outside dependency tracking. Usage cache writes, favicon request context,
sharing cache writes, and host setup state must not reinstall their own readers.

The Git menu reads when its content opens. Hidden Git rows and setup cards do not
start repository, PR, or review metadata reads. Draft preflight tracks its selected
run; construction of RPC context and cache operations do not add unrelated tab or
settings dependencies.

## Typing presence

A keystroke starts a typing report. Continued typing can report again after three
seconds, and the host expires the mark after five seconds without a report. Send,
clear, and leaving the bar report a stop only if typing started. Idle time sends
nothing. These are input events, not startup loads or an effect that sends a
request on each keystroke. Work editing uses the same rule. Repeats are required
to keep the mark visible during continued typing.

## Session shelf and queue reads

Settle and snooze commands subscribe before sending the mutation. The host change
event owns the shelf read on desktop, web, and mobile; the command does not issue
a second read. If that event read is still pending, the command waits for it.

Mounted queue views share one initial read per session and host API. Cache writes
and remounts do not read again. A reconnect or an explicit recovery command reads
fresh state. A newer live queue event or a later read supersedes an older reply.

The typing cleanup tracks derived host and session IDs rather than the session
object. Metadata replacement in the same room cannot send a false stop. Clear,
visibility changes, room changes, and unmount still stop typing.

## Startup read audit

The 2026-10-08 run had 42 initial calls before selecting another conversation.
The remaining host facts have these owners:

| Read | Startup owner | Loading rule |
| --- | --- | --- |
| `detectEditors` | Installed editor capability advertisement | Join the async boot PATH probe; inspect that PATH without launching `which` for each app. Keep installed GUI bundle detection. |
| `resolveTerminal` | Terminal action details | Load when the row gets pointer input or focus, in Tools settings, or after a terminal action. The logo only displays cached state and is generic before a read. |
| `hostUpdateStatus` | Update notices, Settings badge, and active installation progress | Read on connection and follow host events. Deferring this would hide an available update or an active installation. |
| `modelProfilesStatus` | Model picker, model names, and reasoning options | Read on connection and follow model-profile events. The bundled list can be older than the host's list. |
| `voiceModelStatus` | Visible microphone readiness and download progress | Read from the transcription host. Voice settings reuse the same host fact. |
| `usageLimits` | Visible Environment quota meters | Read while the section is active. Hidden sections release their clock subscription. |
| `deviceProjectDetect`, `deviceState` | Environment's Devices row and build count | Project detection runs for an active section. Device state loads when this is a mobile app or a session already has a preview. |

Capabilities, configuration, connection roles, session history, queue, focus,
sidebar state, and the selected checkout are needed by the visible workspace.
Settings-only tool choices are loaded through `Host.tools` when Tools settings
opens. Hidden Git and setup sections keep their existing active guards. No new
RPC batch or second cache was added in this audit. Desktop and web share the
terminal-row change; mobile has no desktop terminal launcher. The editor probe
remains a host capability with the same contract for all clients.
