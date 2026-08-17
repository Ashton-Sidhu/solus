# Session handoff lineage

## Decision

Provider transcript files remain the source of transcript content. Solus stores
only the ordered relationship created by a new cross-provider handoff.

`session_handoff_members` contains one row for each provider transcript in a
handoff chain. `handoff_id` is the stable Solus session ID. `position` defines
the transcript order. The last row is the active runtime endpoint. A null
`provider_session_id` means the target provider has not started yet.

The partial unique index on `(provider, provider_session_id)` is the reverse
lookup. It lets any provider transcript in a chain resolve to the same stable
Solus session. Resolution uses two indexed reads: find the handoff ID, then read
its members in position order. It does not use a self-join.

## Load behavior

- If a provider transcript does not match the lookup, use the existing direct
  provider load and resume behavior.
- If it matches, load each member from its provider transcript file, insert a
  deterministic divider at each boundary, and return one composite transcript.
- Opening any member resumes the provider and provider session in the last row.
- A missing member file does not alter the stored lineage.

## Lifecycle

The first handoff inserts the source member and a provisional target member in
one transaction. `session_init` fills the target provider session ID. A later
handoff appends another provisional member. Switching back before the target
starts removes that provisional member and reopens the previous endpoint.

Tabs, routes, sidebar selection, hydration, and task attempts use the stable
Solus session ID. Provider session IDs remain adapter and transcript-reader
metadata.

## Compatibility

This model applies only to handoffs created after this table exists. Solus does
not infer, import, or rebuild older handoff relationships. Ordinary unmatched
provider transcripts remain independent sessions.
