# ADR-0009 — Every domain declares its host ownership

**Status**: accepted
**Related**: [ADR-0006](./0006-the-task-host-is-the-projects-host.md),
[ADR-0007](./0007-clients-ferry-cross-host-writes-through-an-outbox.md),
[ADR-0008](./0008-the-renderer-addresses-hosts-not-an-ambient-api.md)
**Implements**: [docs/plans/multi-host-parity.md](../plans/multi-host-parity.md) WP0, WP3–WP7

## Context

Every Solus host keeps its own SQLite and data directory, and there is no
federation service — a deliberate choice this ADR keeps. But no domain ever
declared what that means for it. In practice each domain silently became
"primary-only": works created by a remote agent vanish when the gallery syncs
against the primary's database; plan comments land where the reviewing agent can
never read them; automations schedule on machines no client is watching; the
project-config editor edits a row the runtime never reads.

Tasks alone answered the question, in ADR-0006: the task lives on the project's
host, the store fans out reads and routes writes back to the owner. That answer
was correct and stayed local to one domain. The question is domain-shaped, so
the answer must be given per domain — once, here, instead of re-argued per PR.

## Decision

Every domain is classified exactly one of three ways, and the classification is
part of its contract:

- **host-scoped** — records live on an owner host. Writes route to the owner;
  cross-host views are client-side fan-out unions over connected hosts (the
  tasks pattern). The owner rule is stated per domain below.
- **client-global** — the record belongs to the user's device. It may *contain*
  scoped refs to host data, but its store reads and writes locally (or via
  `primaryApi()` where the primary hosts client-global state).
- **gated-local** — the capability is only meaningful on the client's machine.
  The UI hides or disables it for remote sessions with a visible reason
  (the `ActionOrb` terminal pattern); it never silently runs against the wrong
  machine.

### The table

| Domain | Class | Owner host / rule |
|---|---|---|
| Sessions, transcripts, turns | host-scoped | `run.serverId` (already correct) |
| Tasks | host-scoped | `taskServerId`, per ADR-0006 (already correct) |
| Git state, diffs, worktrees, snapshots | host-scoped | the session's host (already correct) |
| Review guides, ledger, review drafts | host-scoped | the session's host |
| PRs, stacks, PR review | host-scoped | the host holding the checkout the PR context refers to |
| Works + work annotations | host-scoped | the creating session's host; primary when created outside a session. Fan-out union reads; owner-host writes |
| Plans + plan annotations | host-scoped | the session's host — user comments must land where the agent's `read_plan` reads |
| Automations | host-scoped | the host that stores, schedules, and runs it; the builder names the host explicitly |
| Run (dev processes, ports) | host-scoped | the session's host; port links open against that host's origin or gate |
| Project config | host-scoped | the project's host — the row the runtime reads is the row the editor edits |
| Attachments, artifacts, asset URLs | host-scoped | the session's host; bytes cross the boundary, paths do not |
| Skills, tools/editors, voice model, project list, provider connections | host-scoped | per host, and the UI says which host it is showing (the Connections-tab framing) |
| Saved prompts, pinned-session manifest, keybindings, UI preferences, custom instructions | client-global | device-local; pinned entries and saved refs hold `(serverId, id)` pairs |
| Terminal, reveal-in-Finder, open-in-editor | gated-local | shown only when the session's host is the client's machine |
| `openExternal`, dialogs, clipboard | client-local by design | `localApi`, per ADR-0008 |

### Credentials

Provider credentials are **per host and never forwarded**. The existing git
credential delegation for dispatch (ADR-0001/0002) is the only cross-host
credential mechanism and stays git-only. When an operation needs a host-side
provider API (GitHub PRs, task upstream sync) on a host that has no token, the
UI surfaces an inline **"Connect GitHub on \<host\>"** step where the operation
bites — it does not fail silently and it does not export the primary's token.
Google stays primary-only (exports operate on in-memory content).

### Rules that follow

- **Owner-host writes.** A write for a host-scoped record goes to its owner or
  fails visibly. When the owner is offline, the write queues through the outbox
  (ADR-0007) where a domain has registered an applier, or errors — it never
  lands on a bystander host.
- **Fan-out reads are unions, not races.** A host that cannot answer contributes
  nothing; it must not evict another host's records from a store (the works
  `loadAll` eviction was this bug).
- **Ids stay bare strings; refs carry the host.** Per ADR-0006, ids do not embed
  host identity. Any id that crosses a feature boundary travels as a scoped ref
  `(serverId, id)`. Each host-scoped domain implicitly asserts its ids are
  unique enough to union; host-minted ULIDs satisfy this everywhere today.
- **Paths are never identity.** Same-path records on two hosts are two records;
  every path-keyed structure uses `hostKey(serverId, path)` (ADR-0008).

## Consequences

- "Which host owns this?" has a written answer before a feature ships;
  reviewers point at a row instead of re-litigating the model.
- New domains must add a row here — a one-line decision made at design time,
  which is the cheapest moment it will ever have.
- Notifications remain per-host and client-dormant; they need their own plan
  (a client that subscribes on every retained host, or a relay) and are out of
  scope here.
- Nothing federates server-side, so an offline host's records are simply absent
  from unions. That is the accepted trade: absence is honest and visible where
  a silent primary-fallback was neither.
