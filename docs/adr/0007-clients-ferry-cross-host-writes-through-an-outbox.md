# ADR-0007 — Clients ferry cross-host writes through an outbox

**Status**: accepted
**Related**: [ADR-0005](./0005-publish-typed-host-events-to-explicit-clients.md),
[ADR-0006](./0006-the-task-host-is-the-projects-host.md)

## Context

Hosts never talk to each other. A Solus host may sit behind NAT, a laptop lid, or a
network the dispatch target cannot see; the only party that ever holds connections to
two hosts at once is a client. Every cross-host behavior we have already leans on
that fact: the client mints a dispatched session's task on the task host
(ADR-0006), writes the session link there at `session_init`, and exports a GitHub
credential to the dispatch target so it can clone.

A dispatched agent now needs to *write* across that boundary — comment on its task,
move its status — and the write must succeed while no client is watching, because
"send the work to another machine and walk away" is the point of dispatch. A live
relay through a watching client fails exactly then. Host-to-host transport would
solve it and is rejected: it adds a reachability requirement most home machines
cannot meet, and it gives hosts knowledge of hosts, which nothing in `src/main/`
has today — host identity is a client-side concept.

## Decision

**A host that cannot deliver a write records it; a client delivers it later.**

- **Every host keeps an outbox**: a durable queue of *ops*. An op is
  `{ id, domain, resourceId, name, payload }` — a ULID minted at record time, the
  owning domain (`tasks` first), the id of the resource it targets, a domain verb,
  and a domain-shaped payload. An op is addressed to a **resource**, never to a
  host. Hosts stay host-ignorant.
- **Any connected client drains any outbox.** On the outbox-changed event and on
  every (re)connect, a client lists pending ops, resolves each `resourceId` to its
  owner host the way its domain store already routes writes (for tasks:
  `hostByTaskId`), delivers the op to that host, and acks on success. Acked ops are
  deleted.
- **The op id is the consistency story.** The owner host applies ops through one
  generic entry point that consults an applied-ops guard keyed by op id: a
  redelivered op is a no-op, so lost acks and concurrently draining clients are
  harmless and no drainer election exists. Ops for one resource apply in op-id
  order; ULIDs are time-ordered, so that is record order. No ordering is promised
  across resources.
- **Domains plug in at both ends, not in the middle.** The recording host decides
  when a write becomes an op; the owner host registers an applier per domain. The
  client is a pure courier plus one owner-resolution hook per domain — it never
  interprets payloads, so a new domain touches no courier logic.

## Consequences

- **Delivery is eventual, so pending is a visible state.** An op that has not
  drained must be shown wherever the resource is shown ("N updates waiting to sync
  from «host»"). A silent outbox makes every board a lie; this is the same rule as
  loading and stale states.
- **Latency is the client set.** A watching client drains sub-second, matching a
  live relay. No connected client means no delivery, and that is reported, not
  worked around.
- **Resource ids must be globally unique** — the op carries no host. ULIDs give
  this for free (same constraint ADR-0006 already locked for tasks); a per-host
  sequential id scheme can never join a domain to the outbox.
- **Failed ops dead-letter visibly.** An op whose apply fails permanently (the
  resource was deleted) is kept and flagged, not retried forever and not silently
  dropped.
- **Recording is optimistic.** The writer sees success at record time and reads its
  own writes through a local overlay until delivery catches up. A domain whose
  writes cannot tolerate that (a write that must be rejected by the owner
  synchronously) does not belong on the outbox.
