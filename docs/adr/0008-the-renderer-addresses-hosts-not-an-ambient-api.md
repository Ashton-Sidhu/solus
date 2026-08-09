# ADR-0008 — The renderer addresses hosts, not an ambient API

**Status**: accepted
**Related**: [ADR-0005](./0005-publish-typed-host-events-to-explicit-clients.md),
[ADR-0006](./0006-the-task-host-is-the-projects-host.md),
[ADR-0007](./0007-clients-ferry-cross-host-writes-through-an-outbox.md)
**Implements**: [docs/plans/multi-host-parity.md](../plans/multi-host-parity.md) WP0–WP1

## Context

Solus grew from one host to many, but the renderer's API surface never did.
`window.solus` is the whole RPC surface of *whichever host is primary* — it even
rebinds when the user switches hosts — and `serverConnections.apiFor()` /
`eventsFor()` treat the host argument as optional, defaulting to primary. Both
handles share one type, `SolusAPI`, so a call that reaches the wrong machine
typechecks, runs, and answers from the wrong database without an error the server
could raise (the host is deliberately host-blind; ADR-0007).

The result, measured in the multi-host audit: 186 ambient `window.solus.` call
sites against ~85 host-resolved ones; 12 of 23 event subscriptions listening to
the primary only; every store except tasks bound implicitly to the primary. Each
domain that wanted host-correctness (tasks, git, the session core) re-derived the
same retrofit by hand. Host-correctness was opt-in, and the best-documented call
path was the wrong one.

The failure is structural, not a pile of call-site bugs: the wrong default is
free, the right call requires threading a `serverId` the caller may not hold, and
nothing — type, lint, or runtime — pushes back.

## Decision

**The ambient API loses its domain surface. Every domain call names a host.**

1. **Two renderer-facing surfaces.**
   - **`localApi`** — the client shell: dialogs, `openExternal`, clipboard,
     window/tray/shortcut control, client-local settings. It is about the user's
     device and never carries session, git, file, or domain data. It must not be
     used as a proxy for "whatever host the user is targeting".
   - **`HostApi`** — a branded `SolusAPI` bound to one host. The brand is
     nominal; a raw `SolusAPI` is not assignable to it.
2. **The only producers of a `HostApi` name a host.**
   `serverConnections.apiFor(serverId)` and `eventsFor(serverId)` require their
   argument. `primaryApi()` exists for legitimately client-global or
   primary-scoped reads, so choosing the primary is visible at the call site
   rather than an omission. A missing or null host yields an empty state — never
   a fallback to another host's data.
3. **Session identity crossing a feature boundary is a scoped ref.**
   `SessionMeta.serverId` is stamped by the client edge that read it, always.
   `session://` links carry the host. Resume paths consume the ref; a legacy
   bare id is resolved by probing connected hosts, not by assuming primary.
4. **Path-indexed state is host-qualified.** One helper, `hostKey(serverId,
   path)`, keys every cwd/repo-root map. A path alone is display data, not
   identity: the same string on two hosts names two different things.
5. **A socket is verified against the host it claims to be.** On connect the
   client compares the host's self-reported `installationId` (already in
   `/health`) with the saved server record and refuses on mismatch.
6. **The cutover is hard.** No deprecation alias, no compatibility layer.
   `window.solus`'s renderer-visible type shrinks to the local surface and the
   brand lands in one coordinated series; every ambient domain call becomes a
   compile error and the series merges when the tree typechecks. The compiler is
   the migration tool. One slim lint rule remains: re-widening escapes
   (`as HostApi`, `as any`/`as SolusAPI` on api handles) are banned outside
   `serverConnections`, so the brand cannot be counterfeited.

**What does not change.** The wire stays host-blind: `RpcEnvelope` carries no
server identity, hosts never learn about each other, and `src/main/` remains
unaware of routing (ADR-0007). T3 Code ships the same wire choice safely; the
correction belongs at the client edge, where the knowledge lives.

## Consequences

- A host-wrong call stops being writable. The next feature gets multi-host
  behavior from the types, not from remembering a convention.
- The web client inherits every fix — it shares the renderer, and "primary" on
  web is just its one connection until it adds more.
- The WP1 branch does not build until all ~186 sites are resolved. Accepted:
  sites are fixed domain-by-domain inside the series so review stays
  per-concern, and sites whose domain federates later (PRs, works, plans,
  automations, run) receive mechanically correct routing now and their
  federation work in their own plan phase.
- `AGENTS.md` / `CLAUDE.md` change with the code: the documented architecture
  becomes *renderer → host api → transport*, with `localApi` as the exception,
  so agents stop being taught the ambient path.
- Boot files (`main.ts`, `native-api-overlay.ts`, the preload) and `localApi`
  internals are the only modules that touch the raw bridge object.
