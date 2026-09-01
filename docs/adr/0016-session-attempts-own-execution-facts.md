# ADR-0016 — Session attempts own execution facts

**Status**: accepted

## Context

`task_session_links` stored the branch and execution host beside the task and
session identifiers. Runtime `session_init` and `git_context` events used the
same upsert to fill those fields. A resumed session therefore rewrote
`linked_at`, changed attempt order, and could recreate a relationship that an
explicit unlink had removed.

Branch and execution host do not describe the relationship. They describe the
session attempt. One session can be linked to several tasks without changing
where it runs or which checkout it uses.

## Decision

- A task/session relationship changes only through an explicit link, unlink, or
  role change.
- `task_session_links.linked_at` is the time the relationship was first created.
  Idempotent retries do not change it.
- Session records own branch and execution host.
- `session_init` creates a task relationship only for a fresh dispatched
  session whose task lives on another host. A resumed session does not write the
  relationship.
- `git_context` updates session metadata only.
- Task reads join linked session records and project the session branch and host
  for display and PR discovery.
- PR discovery follows task → linked sessions → session branches → PR head ref.
  After discovery, the durable task/PR link is authoritative.

## Consequences

- Starting, stopping, or resuming a session does not reorder task attempts.
- Unlinking a session removes that session's branch from the task's PR candidate
  set without deleting session history.
- A session linked to several tasks stores its execution facts once.
- Remote task hosts keep a session stub for dispatched attempts. The stub owns
  the execution host and receives late branch metadata through the session RPC.
