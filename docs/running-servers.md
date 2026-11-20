# Running servers

The Running servers card sits below Git in the desktop and web project panel.
It lists the selected checkout's servers. **All on host** includes other
checkouts and unassigned servers. The card has its own collapse and visibility
controls. It is visible only when the selected scope has server rows. Loading, disconnected,
and failed scans with no rows do not show a card. Discovery stays subscribed, so
the card returns when a server appears. The mobile server screen keeps its status
and retry controls available. Stop is red.

Native mobile exposes the same list and Stop action from the session header's
server button. Both clients start with four endpoint rows and offer **Show more**.
Each row shows Agent, Terminal, or Configured as its source. The starting session
is separate from the server's checkout. Solus resolves the active checkout root
on the host. A session in a subfolder sees that checkout's servers, without
including a main checkout or a nested or sibling worktree.

## Discovery and explicit URLs

Automatic discovery lists local and wildcard TCP listeners owned by a Solus
agent or a terminal opened from Solus. It excludes Solus, provider CLIs,
interactive shells, unowned processes, LAN-only listeners, and ports held by
multiple processes. IPv4 and IPv6 rows for the same process and port are combined.
**Automatic discovery sends no HTTP or TLS probes.** An unprobed row says TCP;
its default browser address uses HTTP.

For HTTPS, a specific path, or a server started outside Solus, use **Server URLs**
in the project panel menu. On mobile, use **Server URLs** on the server screen.
These controls stay available with an empty list. They save `serverUrls` in the
project's `.solus/config.json`:

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

The desktop shell can forward an endpoint to an unused loopback TCP port on this
computer. The card shows the local port and a control to stop forwarding. Copy
then uses the forwarded URL. A modified or middle click forwards the endpoint
and opens it in the system browser. HTTP paths and WebSockets work through the
same TCP channel. HTTPS keeps its scheme and certificate behavior.

The host issues a short-lived capability for one listed endpoint. The WebSocket
upgrade checks its expiry, the current endpoint, and process identity. It connects
only to loopback. Traffic uses stream backpressure and connection limits. The
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
store exposes `servers`, `status`, `error`, and checkout rows. Neither `Host` nor
`SolusApp` owns this collection. Native mobile has a feature-owned registry scoped
to its host connections and uses the same framework-neutral collection owner.

Each entry is a stable `Server` instance. It owns its process identity, endpoint
labels, checkout matching, Stop, forwarded ports, renewal, and system-browser
opening. Removing a server disposes its forwards and invalidates commands held
by old callers. A refresh updates the same instance when its identity is unchanged.
The collection owns subscriptions, reconnect guards, configured URLs, and checkout
roots. It sends its change notifications through a small Svelte adapter on
desktop/web and React's external-store interface on mobile.

On the host, `ServerDiscovery.discover(paths)` returns serializable server records.
It encapsulates operating-system reads, ownership rules, configured probes, caches,
and identity checks. Private operating-system adapters and stateless parsers stay
separate implementation details. Records cross the typed RPC transport; client
class instances and Svelte state do not cross that transport.

`RunningServerRegistry` on the host owns scan sharing and connection leases. It
is a Node owner, separate from the reactive client registry. It does not depend on
Svelte. Its discovery operations run in the host's acting scope, including tunnel
upgrades that start outside an RPC.
The host scans every three seconds while a client holds a lease. Clients renew
every eight seconds. Readers and active forwards retain that lease. The last
holder releases it, disconnection removes it, and an abandoned lease expires
after 20 seconds. Changes go through `runningServers.changed`; equal lists do
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
match. A reused PID or a new group member prevents escalation. Windows verifies
the target tree before using `taskkill`. **Stopped means the verified members
have exited**, not that a signal was sent. The registry refreshes the list before
returning.

Before signalling a Codex command group, Solus uses `CODEX_TOOL_CALL_ID` at the
group leader to mark that exact command as user-stopped. Its completion does not
wake the agent. An inherited ID in a separately detached child does not mark the
parent command as stopped. Failed signalling undoes the notice. Claude has no
equivalent per-command environment ID; Solus does not guess a task from command
text or stop unrelated tasks in that session.
