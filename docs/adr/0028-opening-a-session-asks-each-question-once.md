# 0028. Opening a session asks each question once

## Status

Accepted, 2026-09-05.

## Context

Resuming a saved session made about twenty RPC calls. Some of them were the
same question asked twice. The tab the resume created ran its own environment
refresh, then the resume path read Git identity and registered the checkout
again. Two plugin-command reads landed for one directory, and every tab switch
added a third. A full environment refresh made a details scan and then two more
calls for worktrees and branches. Opening a live session was a watch followed by
a bind, two round trips for one answer. A worktree restore call repeated what
the identity read had already established.

Over a WebSocket to a remote host, each of those is a round trip the user waits
on. The client is also expected to connect to hosts that run older builds, so a
fold on one side must not strand the other.

## Decision

- **One host read describes a saved session.** `describeSession` returns the
  lineage and the metadata of the member that answers for it today. The client
  no longer resolves the lineage and then reads the member's metadata in turn.
  `resolveSessionLineage` and `getSessionInfo` remain for callers that want only
  one of them.
- **A watch can attach.** `watchSession` takes `attachRuntime`. When set with a
  provider thread, the answer also carries what `bindRuntimeSession` would have
  returned: run config, status, queue, and rate-limit state. The host does the
  same work in the same order as a separate bind: drain, join, replay. The
  runtime field is `null` when nothing is running and absent when the watch did
  not ask. Reconnect, boot hydration, and resume all use this.
  `bindRuntimeSession` remains for a client that is already watching.
- **Refs ride the status scan.** `gitRefreshState` takes `includeRefs`. With it,
  the details answer carries the project's worktrees and branches. The renderer
  store strips them off the status record and files them under the project
  root, as the two separate calls did. A host that predates the option answers
  without refs, and the store falls back to the two calls.
- **A tab created for a resume does not resolve its own environment.**
  `createTab` takes `gitInitialization: 'skip'` and `skipPluginCommands`. The
  resume path reads identity, registers the checkout, and reads the directory's
  commands itself, and it does each once.
- **Registration goes through the environment store.** The resume registers the
  checkout with `registerEnvironment`, which records it in the same map the
  refresh consults. The full refresh that follows finds the checkout known and
  does not register it again.
- **Identity answers whether a worktree is still there.** The resume already
  reads identity on the worktree path. A checkout means the worktree exists;
  `null` means its branch is gone and the session is read-only. The separate
  `worktreeRestore` call is not made on this path. The RPC remains for the
  worktree picker.
- **Agent cards hydrate through one batched read.** A transcript mounts every
  agent-conversation card in the same frame, and each one asked
  `getSessionInfo` for its own metadata: about ninety calls per boot on a
  workspace with several long transcripts. The card status store now reads
  through the client's batching meta reader, so one `getSessionInfos` per host
  per frame answers all of them.
- **A tab switch does not re-read plugin commands.** `refreshPluginCommands`
  takes `onlyIfStale`. A session whose commands were read for the same provider
  and directory keeps them. Skill edits, agent switches, and directory changes
  refresh without the flag and always read.

## Consequences

Opening a saved session on a repository costs about seven calls on the critical
path and three or four after the transcript paints, down from about twenty. A
plain tab switch costs none. Closing a tab still costs one, `unwatchSession`,
only when the last view of that session closes.

Every fold is additive on the wire. A new client against an old host still works:
`describeSession` is the only new method, and when a host rejects it the resume
path falls back to the two reads it replaced. `attachRuntime` and `includeRefs`
are ignored by an old host, and the client reads their absence as "not
answered": the bootstrap treats a missing runtime as no live runtime, and the
store scans refs separately.

The demo backend answers all three shapes so the marketing replay follows the
same path as a live host.
