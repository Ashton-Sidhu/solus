# Session digests: what a session did, attached to the session

Status: proposed (2026-11-21). Extends `docs/plans/session-artifacts.md`.

## Problem

The Threads surface (the session's Artifacts surface; the Threads screen on the
phone) shows a session's head, its recent row, its turn timeline, and its
Changes, Agents, Pull requests, and Works and files cards. Only some of that is
attached to the session:

| Card | Source now | Attached to the session? |
| --- | --- | --- |
| Head (name, status, branch) | `SessionRecord` | Yes |
| Recent row, Pull requests, Works and files | `sessionArtifactsList` (`resource_links` rows) | Yes, with one group per child |
| Turn timeline, turn scope | the transcript, scanned on the client (`scanSessionActivity`) | No |
| Changes | `diffStats` and `listTurnSnapshots`, which need an open tab's `IpcContext` | No |
| Agents: sub-agents | the transcript, scanned on the client | No |
| Agents: started sessions | the parent's transcript cards, then `getSessionInfos` | Partly |

So a parent cannot show what its children did, and a session whose
conversation is not open shows only its artifacts (session-artifacts decision
16). A child's changes are not visible from the parent at all.

## Goal

Everything the Threads surface shows is attached to the session that made it.
A parent shows its own section, then one section for each session below it.
Each section reads that session's own data, by its session id. No section
needs an open conversation, a checkout on the client, or a call to git.

## Vocabulary

- **digest** — the durable, bounded account of what one session did: its
  turns, its tool call counts over time, its change summary, and its
  sub-agents. One digest for each session. Do not call it a summary (Insights
  owns `sessionSummary`), an overview (that is the client view model,
  `SessionOverview`), or a report (that is a child's message to its parent).
- **change summary** — the part of a digest that holds the session's net
  change: files with line counts and totals. It holds no patch.
- **digest tree** — a session's digest and record, then those of every session
  below it through `parentSessionId`.
- **section** — the part of the Threads surface that shows one node of the
  digest tree.

## Decisions

1. **One digest for each session, in its own row.** Table `session_digests`:
   `session_id` (key), `organization_id`, `digest` (JSON), `updated_at`. It is
   not a column of `session_records`, because session lists (sidebar, picker,
   search) read records in bulk. A digest of a large session can be 100 KB; on
   a record it would go into every list payload, over IPC and WebSockets. A
   session delete removes its digest.

2. **Only the host that runs the session writes its digest.** A focused owner,
   `packages/server/src/execution/sessions/session-digests.ts`, keeps the
   digest of each live session in memory and builds it from the normalized
   provider events, not from a parse of the transcript. It writes the row when a
   turn starts, at most once every 5 seconds while a turn runs, and when a turn
   ends. It does not write for a streamed token.

3. **The shape.**

   ```ts
   // packages/contracts/src/session-digest.ts
   export interface SessionDigest {
     sessionId: string
     /** Oldest first, at most DIGEST_TURNS (500), the newest kept. */
     turns: DigestTurn[]
     /** Null before the first checkpoint and for a session with no git checkout: unknown, not zero. */
     changes: SessionChangeSummary | null
     /** The provider's in-process sub-agents. Started sessions are nodes of the tree, not rows here. */
     subagents: DigestSubagent[]
     /** The last thing the session said at the end of a turn, one line, at most 240 characters. */
     lastReply: string | null
     updatedAt: number
   }

   export interface DigestTurn {
     /** The prompt's message id, as `TimelineTurn.id`. */
     id: string
     startedAt: number
     /** The last activity; the turn is open while the session's status is running. */
     endedAt: number
     /** The prompt as one line, at most 240 characters. */
     prompt: string
     /** Tool calls started, counted in 15-second buckets: [bucketStart, count] pairs, oldest first. */
     toolCalls: [number, number][]
     /** The checkpoint totals of this turn. Null for a turn with no checkpoint. */
     changes: { filesChanged: number; additions: number; deletions: number } | null
   }

   export interface DigestSubagent {
     /** The tool call's id, stable across reads. */
     id: string
     title: string
     status: 'running' | 'completed' | 'failed' | 'stopped'
     startedAt: number
     endedAt: number | null
     /** What it is on or came back with, one line. Empty when nothing is known yet. */
     detail: string
   }

   // packages/contracts/src/git-types.ts
   export const SESSION_CHANGE_SUMMARY_FILES = 500
   export interface SessionChangeSummary {
     /** Largest change first, at most SESSION_CHANGE_SUMMARY_FILES. */
     files: ChangedFileStat[]
     /** Totals of the whole change, also past the file limit. */
     filesChanged: number
     additions: number
     deletions: number
     /** The checkpoint this summary describes (`TurnSnapshot.index`). */
     turnIndex: number
     updatedAt: number
   }
   ```

   The 15-second bucket is the finest span the timeline draws (session-artifacts
   decision 11), so the buckets lose nothing the plot shows. A one-hour turn is
   at most 240 pairs. The file kind (Code, Tests, Docs) comes from the path on
   the client (`changedFileKind`), so the digest does not store it.

4. **The change summary is written at each turn checkpoint.** After
   `session-snapshots.ts` writes a checkpoint, `turn-checkpoints.ts` hands the
   base-to-checkpoint stats to the digest owner. The summary holds only the
   session's own writes:
   - In a checkout that the session shares, the existing rules apply
     (`keepOwnPaths`, `pathsOfOtherSessions`).
   - **Fix:** in the session's own linked worktree, the whole-session diff
     (`diffSessionCheckout`) now also leaves out the writes of another session
     that had a turn in that worktree at the same time, as the turn checkpoints
     already do. Without the fix, a child that shares its parent's worktree
     counts its lines twice.
   - The patch stays in git. An edit between turns (by a person, or by a
     background shell) shows in the live diff, and in the summary after the
     next checkpoint.

5. **One read for the tree.**

   ```ts
   // packages/contracts/src/host-api.ts
   sessionDigestTree(sessionId: string): Promise<SessionDigestTree>

   export interface SessionDigestTree {
     /** The session first, then the sessions below it, level by level, oldest started first, at most 200. */
     nodes: SessionDigestNode[]
   }
   export interface SessionDigestNode {
     record: SessionRecord
     /** Null for a session whose host has not written one yet. */
     digest: SessionDigest | null
   }
   ```

   It is `read` on the session resource and answered by the execution host. It
   walks `parentSessionId` with the same walk and limits as
   `readSessionArtifacts` (a cycle ends the walk). The artifacts stay in
   `sessionArtifactsList`, their owner, which already returns one group for
   each child. A child that runs on another host is read from the
   organization mirror (decision 8).

6. **One event.** `session.digestChanged { sessionId, parentSessionId, digest }`,
   category `delta`, owner `sessions`. It carries the digest, so a client
   applies it with no new read. A client that holds a tree that contains
   `sessionId` replaces that node's digest. A client that holds a tree that
   contains `parentSessionId` but not `sessionId` reads the tree again: a child
   started.

7. **Old sessions get a digest on first read.** When `sessionDigestTree` finds
   no row for a session on this host, it builds the digest once from the
   host's transcript index and the snapshot sidecar, stores it, and returns
   it. A session that this host cannot build (no transcript here) returns
   `digest: null`, and its section says so.

8. **The digest goes where the record goes.** A session of organization work
   sends its digest through the same mirror as its record, so an organization
   reader and another host see it. A local session keeps it on its host.

9. **Providers.** The owner reads normalized events, so Claude, Codex, and
   Replay fill the digest from the same code. Claude fills `subagents` from its
   Task tool calls (a tool call with a nested transcript, the rule
   `sessionAgentMessages` uses). Codex emits no in-process sub-agents now, so
   its list is empty; that is a fact of the provider, not a gap. Each child
   session is its own node on either provider.

10. **The Threads surface reads only the digest tree.**
    - The session's own section is node 0. The timeline, the turn scope, and
      Changes read its digest. Agents reads its `subagents` and the nodes one
      level below it.
    - Each child is a row in the Agents card. The row shows the child's
      record (title, provider, status) and its digest (time worked from its
      turns, `lastReply`, and the change totals). It unfolds to show the
      child's change tree and its artifact chips. A file row opens that file
      in the child session's review surface. A row with children of its own
      shows them under it.
    - The client transcript scan (`scanSessionActivity`) and the transcript
      fallbacks of the Changes card are deleted. Decision 16 of
      session-artifacts ("needs the conversation open") is removed.
    - One turn's file list (the turn scope of Changes) is still a git read,
      and only for a session that has a tab on this client. A section of a
      session with no tab shows the turn's totals only.

11. **Every client.** Desktop and web read the tree through one store,
    `session-digests.store.svelte.ts`, beside `SessionOverview`. Mobile reads
    it through `packages/client-core/` and its Threads screen shows the same
    sections and the Changes card. The shared model that orders and scopes the
    rows stays in `packages/client-core/src/session-overview.ts`.

## Stages

1. Contracts, the `session_digests` table, and the digest owner with turns and
   tool call buckets, on Claude, Codex, and Replay. Tests.
2. The change summary at each checkpoint, and the own-worktree fix
   (decision 4). Tests.
3. Sub-agents in the digest.
4. `sessionDigestTree`, `session.digestChanged`, and the client-core model.
5. Desktop and web: `SessionOverview` reads the tree; delete the transcript
   scan.
6. Mobile: sections and the Changes card on the Threads screen.
7. Digests built on first read; the organization mirror.
8. Docs: update session-artifacts decisions 10, 14, 15, and 16, and
   `docs/session-orchestration.md`.

## Verification

- Unit (`session-digests`): a turn's tool calls fall into 15-second buckets;
  limits cut the oldest turns and the smallest files and keep the totals; a
  digest is written at turn start, at most once every 5 seconds while a turn
  runs, and at turn end; the event fires with the parent id.
- Unit (`session-snapshots`): a child that writes in its parent's own linked
  worktree during the parent's turn is in the child's summary and not in the
  parent's; in a shared checkout, the existing tests still pass.
- Unit (`session-digest-tree`): the walk returns the session first, then each
  level oldest first, stops at 200, and ends a cycle.
- Unit (client-core): the sections order and scope from the tree alone, with
  no transcript.
- Replay provider (`showcase`) for a turn that renders; no real provider turn.

## Open questions

1. Does the parent also show a total for "this session and the sessions below
   it", or only the separate sections?
2. When a parent and a child change the same file, the last write decides who
   owns it. Is that acceptable, or does the file show in both sections?
3. Mobile has no turn timeline today. Does stage 6 add it, or only the
   sections and the Changes card?
