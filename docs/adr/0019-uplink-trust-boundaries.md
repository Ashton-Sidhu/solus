# ADR-0019 — Personal Uplink trust boundaries

**Status**: accepted
**Related**: [ADR-0012](./0012-the-workspace-requires-a-host-and-trust-is-per-requester.md), [ADR-0017](./0017-cloud-identity-is-a-client-shell-concern.md), `docs/plans/personal-uplink.md`

## Context

Personal Uplink lets one person reach their own Solus host from anywhere through the
Solus account (`app.solus.sh`): the host links itself to the account, the control plane
provisions a Cloudflare Tunnel to it, and a signed-in client dials the host with a
short-lived grant. Four boundaries decide whether that is safe, and each had a cheaper
and a stricter option. This ADR records the choices for the single-account slice (S6).

## Decisions

1. **Bearer grants with one-use tickets, not proof-bound tokens.** A grant is an ES256
   JWT (`iss` = account origin, `aud` = host id, `sub` = owner, `deviceId` = the account
   session, `exp ≤ iat + 600`). The host verifies it against the account's JWKS and
   consumes its `jti`; the ticket it mints for the socket handshake is itself one-use
   (`consumeWsTicket`). Consumed ids live in memory, so a grant or ticket issued before
   the process (or the verifier) started is refused outright. A client therefore mints
   one grant per dial and keeps none. A captured grant or ticket cannot open a second
   socket, and a grant is worthless ten minutes after issue: the transport closes a
   grant-admitted socket at the grant's expiry. T3 Connect ships both bearer and DPoP
   variants of this flow; proof binding is the recorded escalation if replay of an
   in-flight grant ever becomes the threat that matters, not the default.

2. **The control plane is the sole grant authority.** The host holds no signing key of
   its own; it only verifies. A compromised control plane could therefore mint grants
   for any host. The escalation — the host co-signing the credential it admits, as T3's
   environment key does — is noted and not built: it doubles the key material on every
   host for a threat the single-owner slice does not carry.

3. **Cloudflare is a named data processor for tunnel traffic.** Cloudflare terminates
   TLS at its edge and re-encrypts to `cloudflared` on the host, so it can see workspace
   traffic in flight. This is accepted for Uplink and must be stated to users; the
   self-operated gateway remains the recorded alternative for customers who cannot
   accept it. Nothing the control plane stores is sensitive beyond the hashed host
   token and hashed enrollment tickets; grants are never stored.

4. **The proxied-listener rule.** `cloudflared` forwards to loopback, and loopback is a
   trusted requester (`server/trusted-requesters.ts`), so tunnel traffic must never
   land on the ordinary listener. The host binds a second, loopback-only listener (the
   *proxied listener*, default port 34118) that is tagged by the listener it arrived on
   — never by an address or a client-sent header. It is a public URL, so only what a
   grant-holding client needs exists on it: `/health` (without the host's name, OS, or
   addresses), `/auth/ws-ticket`, `/ws`, and signed assets; everything else, pairing
   included, is 404. `requireAuth` is always true there, trusted-requester status never
   applies, and a socket is admitted only with a ticket — a paired device's ticket
   admits it as the local owner it already is, wherever it dials from. Everything that
   is loopback-and-therefore-trusted today keeps working on the ordinary listener.

5. **Locally authorized enrollment, no host PKI.** A host links only when a caller on
   an already-trusted local connection (`local-owner`) hands it a one-use ticket the
   owner's account issued. The host receives two opaque credentials once: the
   `cloudflared` run token (tunnel only) and a host token that reads, reports on, and
   deletes its own link record. Both live in the secret store; the link record on disk
   holds neither. Only the current `connectionGeneration`'s host token is accepted, so
   a restored copy of a host discovers it was superseded on its first link read and
   stops its connector.

6. **Principals, not addresses, gate what a caller may do.** Every RPC carries a
   `Principal`: `local-owner` (desktop renderer, paired device, trusted requester),
   `remote-owner` (the owner through a grant, carrying the account's `userId` and
   session `deviceId` — the seed of a team host's attribution), or `system`. A call with
   no principal is refused. `LOCAL_ONLY_RPC_METHODS` — reachability settings, pairing,
   SSH bootstrap, window control, and linking/unlinking — take a `local-owner`; a grant
   proves identity, not presence at the machine. This guard keeps a client from changing
   how the host is reached by accident or by a confused UI. It is not a containment
   boundary: a remote owner drives a coding agent with a shell on the host, so a stolen
   account already has what the owner has. Containing a compromised account is the
   team-host access map's job, together with agent isolation.

## Consequences

- Revocation is expiry plus "revoke the device" on the website, which stops the next
  grant; the socket ends at expiry and the re-dial fails. The host also has its own kill
  switch: revoking a "Solus cloud" session on the Access tab refuses that account
  session's grants here, whatever the control plane still signs. There is no push to the
  host; the plan accepts a ≤10-minute window.
- The host's grant verifier caches JWKS and keeps verifying through a control-plane
  outage; only hosts that never fetched a key set refuse everything.
- Direct/LAN/tailnet/SSH pairing is unchanged and account-free. The tunnel is one more
  route, dialed last (`dialableRoutes` in `client-core/server-registry.ts`).
- Team hosts will add `team-user` principals and the exhaustive access map; nothing here
  needs to be undone for that.
