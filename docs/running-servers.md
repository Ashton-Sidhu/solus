# Running servers

The Running servers card sits below Git in the desktop and web project panel.
It lists servers in the working folder and the session's attached and codebase
folders on the run host. It also lists servers that the session started outside
those folders. Each row names its project or folder when Solus has that path.
Select **2 in other checkouts** to see the other servers on the run host,
including servers with no assigned folder. The link is available even if the
session has no servers. Select **Session folders** to return.

The card has collapse and visibility controls. It stays hidden when the host
has no server rows and returns when discovery finds a server. The mobile
server screen shows loading, connection, and retry status. On desktop and web,
a row shows its copy, forward,
and stop buttons when the pointer is on it or keyboard focus is in it. Stop turns
red on hover. On a touch screen, the buttons always show.

Native mobile exposes the same list and Stop action from **Running servers** in
the session header. The lists limit the number of rows initially and offer **Show more**.
Each row shows Agent, Terminal, or Configured as its source. On desktop and web, a row is one line: its icon shows the source (the Claude or Codex mark of the agent's session, a terminal, or a globe for a configured URL), and its tooltip names it. The starting session
is separate from the server's checkout. Solus resolves each folder's checkout
root on the host. A task folder uses its member worktrees. Servers in the main
checkout and sibling worktrees appear under other checkouts unless the session
started them.

## Discovery and explicit URLs

Automatic discovery lists local and wildcard TCP listeners owned by a Solus
agent or a terminal opened from Solus. It excludes Solus, provider CLIs,
interactive shells, unowned processes, LAN-only listeners, and ports held by
multiple processes. IPv4 and IPv6 rows for the same process and port are combined.
**Automatic discovery sends no HTTP or TLS probes.** An unprobed row says TCP;
its default browser address uses HTTP. The MCP owner on the host, not this
feature, sends one `server/discover` request to a loopback TCP row of a Solus
process (`docs/integrations.md`, "MCP servers that run on the host").

For HTTPS, a specific path, or a server started outside Solus, use **Server URLs**
in the project panel menu. On mobile, use **Server URLs** on the server screen.
Choose the folder when the session has several. These controls stay available
with an empty list. They save `serverUrls` in that project's
`.solus/config.json`:

```json
{
  "version": 1,
  "serverUrls": ["https://localhost:3000/admin?api=v1#health"]
}
```

URLs must use HTTP or HTTPS and a loopback or wildcard host, with no credentials.
The scheme, path, query, and fragment are kept. Only configured URLs are probed.
Any HTTP response counts, including JSON, empty responses, redirects, and 401,
404, or 500 responses. Redirects are not followed. HTML responses can supply a
page title. Requests use a timeout, at most eight concurrent probes, and a bounded
title read. Self-signed local development certificates are accepted for these
checks. Positive and negative verdicts expire after 15 seconds, so a server that
is still starting can appear on a later scan.

Linux reads `/proc/net/tcp`, `/proc/net/tcp6`, process socket ownership, and process
working directories. It falls back to `lsof` when `/proc` is unavailable. macOS
uses `lsof` and `ps`. Windows uses `netstat` and CIM process names and creation
identities. Windows can identify descendants of a Solus provider and tagged
Solus terminals. A terminal's launch folder supplies a folder hint on Windows;
a provider descendant without readable folder information stays unassigned.
Explicit URLs supply a checkout for configured endpoints on every host.

## Open, copy, and forward

Open uses the Browser pane on the selected host, including for APIs. Copy host
URL copies that host's address: `127.0.0.1` refers to the host.

The desktop shell can forward an endpoint to a loopback TCP port on this
computer. It tries the remote port number first and uses a free port if that
number is taken or the operating system refuses the bind. The forward control
shows only for a host on another machine: the
desktop's own local server is already on this computer. The card shows the local port and a control to stop forwarding. Copy
then uses the forwarded URL. A modified or middle click forwards the endpoint
and opens it in the system browser. For the desktop's own local server, it opens
the endpoint URL without a forward. HTTP paths and WebSockets work through the
same TCP channel. HTTPS keeps its scheme and certificate behavior.

Use **Forwarded ports** in the desktop command palette to enter a TCP port on
a remote host you administer. The remote service can be absent from discovery.
The dialog shows the local address and can stop either kind of forward. Manual
forwards target the host's loopback even when another service uses that port on
the desktop. Both kinds of forward exclude Solus connection ports. Only users
with host access can forward from a discovered row. Entering a port manually
requires host administration.

The **Preview tunnel** is on by default. A host administrator can turn it off
in Host settings on desktop, web, or mobile. Device management or a host policy can lock the setting
with `host.previewTunnelEnabled`. When off, the host refuses new tunnels and
closes active ones. The Browser pane still opens loopback pages on the selected
host and streams them to the client. Desktop keeps its annotation and screenshot
controls for those streamed pages.

The connected host issues a short-lived capability for one endpoint to the authorized client. The WebSocket
upgrade checks its expiry. Forwards started from a server row also check the
current endpoint and process identity. The tunnel connects only to loopback.
Traffic uses stream backpressure and connection limits. Processes on the desktop
can reach its forwarded loopback port while it is active. The
client renews the ticket while forwarding is active, including when the card is
not mounted. Stop forwarding, host disconnection, ticket expiry, and desktop
shutdown close the relevant local listener and channels. A renderer reload
reconciles the desktop's held ports.

Port binding is a native desktop shell capability. Web and native mobile use
the host Browser pane; they do not substitute the client device's localhost for
the host's address.

## State and Stop

The running-server feature owns its collection stores. `runningServers.forHost(hostId)`
returns the desktop/web Svelte store. Its registry uses `SvelteMap`, and each
store owns `servers`, `status`, and `error` through Svelte runes and exposes
checkout rows. Neither `Host` nor `SolusApp` owns this collection. Native mobile
has a feature-owned registry scoped to its host connections and shares the same
connection and lifecycle controller.

Each entry is a stable `RunningServers` instance. It owns its process identity, endpoint
labels, checkout matching, Stop, forwarded ports, renewal, and system-browser
opening. Removing a server disposes its forwards and invalidates commands held
by old callers. A refresh updates the same instance when its identity is unchanged.
A shared controller owns subscriptions, reconnect guards, configured URLs, and checkout
roots. It writes directly into the Svelte store's state on desktop/web and uses React's
external-store interface on mobile. Per-entry state is reactive too, so a held
`RunningServers` instance updates without replacing its identity. There is no
`createSubscriber` bridge or lazy loading from property getters.

On the host, `ServerDiscovery.discover(paths)` returns serializable server records.
It encapsulates operating-system reads, ownership rules, configured probes, caches,
and identity checks. Private operating-system adapters and stateless parsers stay
separate implementation details. Records cross the typed RPC transport; client
class instances and Svelte state do not cross that transport.

`RunningServerRegistry` on the host owns scan sharing and client watches. It
is a Node owner, separate from the reactive client registry. It does not depend on
Svelte. Its discovery operations run in the host's acting scope, including tunnel
upgrades that start outside an RPC.

The host scans every three seconds while a client watches. A client sends one
watch when its first reader starts and one more each time the set of watched
checkouts changes; checkouts that change in the same tick share one call. It
sends no renewal. Readers and active forwards retain the watch. The last holder
releases it at the end of its tick, so a tab switch, which unmounts one Git
section and mounts the next in one tick, moves the watch with one call. A
checkout root read once is kept. Disconnection removes the watch. Active forwards renew their tunnel
tickets every minute. Changes go through `runningServers.changed`; equal lists do
not invalidate readers. Disconnect clears running claims. Reconnect reads again.
Running state is not persisted.

Claude and Codex commands inherit `SOLUS_SESSION_ID`. Terminals opened by Solus
also inherit `SOLUS_TERMINAL_ID`. Only these attribution tags and Codex's exact
`CODEX_TOOL_CALL_ID` are retained from process environments. Environment contents
and command lines are not sent to clients.

Stop requires `host.admin` and an opaque server ID. The host refreshes ownership
and verifies the process start identity. On POSIX, it refuses a group that holds
a protected process or a different owner, signals the isolated job with SIGTERM,
waits for its original members, and uses SIGKILL only if their identities still
match. A reused PID or a new group member prevents escalation. A server that an
agent starts in the background often outlives its shell, the group leader. Solus
then stops it only when every member carries the server's own session or
terminal tag, and it signals each verified member PID, never the group ID. Windows verifies
the target tree before using `taskkill`. A refused Stop names its reason on
every client (`stopRefusalText`). **Stopped means the verified members
have exited**, not that a signal was sent. The registry refreshes the list before
returning.

Before signalling a Codex command group, Solus uses `CODEX_TOOL_CALL_ID` at the
group leader to mark that exact command as user-stopped. Its completion does not
wake the agent. An inherited ID in a separately detached child does not mark the
parent command as stopped. Failed signalling undoes the notice. Claude has no
equivalent per-command environment ID; Solus does not guess a task from command
text or stop unrelated tasks in that session.
