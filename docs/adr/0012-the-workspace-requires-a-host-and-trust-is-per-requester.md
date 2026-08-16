# ADR-0012 — The workspace requires a host, and trust is per-requester

**Status**: accepted
**Related**: [ADR-0008](./0008-the-renderer-addresses-hosts-not-an-ambient-api.md),
[ADR-0011](./0011-dispatch-checkouts-belong-to-paired-devices.md)

## Context

The web client used to gate boot behind a "choose a server" screen, which
incidentally enforced the workspace renderer's founding invariant: a primary
host connection exists before the workspace mounts. Removing that gate — the
right product call; the ceremony was hostile to first use — created a third
connection mode, *mounted hostless*, that the renderer was never written for.
Supporting it meant a never-resolving stub API plus per-file patches wherever a
host lookup crashed at mount. The invariant violation was ambient: every store
and render path that resolves a host was a latent mount-time crash or a silent
forever-hang, and nothing enforced otherwise. Three crashes shipped in a week.

Separately, connection auth was decided by the *bind*: any non-loopback bind
forces `requireAuth` for every caller. A user opening their own server over
their tailnet — or over `localhost` while remote access is enabled — was asked
for a 6-digit pairing code that protects nothing they don't already have.

## Decision

**1. The workspace mounts only when a primary host is connected.**

The hostless state is a dedicated scene (`client/src/routes/HostlessHome.svelte`)
in the small entry chunk: the home headline, saved hosts, the serving-origin
offer, and the pairing form. It hands off through `activateServer()`, which
reloads into the connect path. The workspace bundle never loads without a host,
so no workspace code needs a "no host" branch, and `serverConnections` throws
loudly — on every surface — when a primary is missing. Hostless state is
throwaway by construction (connecting reloads), so duplicating one screen of
markup is cheaper than a permanent, diffuse nullability obligation.

**2. Auth is demanded per requester, not per bind.**

The bind policy still decides the default, but two requester classes skip
pairing on a require-auth bind (`src/main/server/trusted-requesters.ts`):

- **Loopback** — a caller on the machine itself already owns the data
  directory; a pairing code adds ceremony, not protection.
- **The host's own tailnet** — tailscale has already identity-checked every
  member device, which is the same trust the 6-digit code establishes.
- **The local network, opt-in** — private-range (RFC1918 / link-local /
  IPv6-local) callers, only while the owner has enabled the "Trust my local
  network" server setting (Settings → Connections, off by default). A shared
  network is not an identity, so the owner has to say the network is theirs;
  Solus's LAN discovery and one-tap connect flows assume home-lab use, and
  this setting is how that assumption becomes explicit.

`/health` advertises the verdict per caller (`requireAuth`), the WebSocket
transport and the token-gated HTTP endpoints (`/upload`, `/voice/transcribe`,
`/artifact`) enforce the same relaxation, and the web client auto-connects to
its serving origin only on an explicit `requireAuth: false` — an older server
that omits the field reads as locked.

## Consequences

- First visit from a trusted network is zero-ceremony: open the URL, land in
  the workspace. Everyone else lands on the hostless home and pairs once; the
  saved token reconnects silently afterwards.
- A tailnet shared with other people shares Solus access with them, and a
  trusted LAN shares it with everyone on that network. Both are the owner's
  posture to hold; the LAN half already has its switch in server settings.
- The `requireAuth` field in `/health` is load-bearing for auto-connect;
  removing or renaming it downgrades every client to code-first pairing.
