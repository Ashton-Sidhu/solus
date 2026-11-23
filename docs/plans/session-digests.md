# Session trees: what a session and the sessions below it did

Status: built for the host, client-core, desktop, and web (2026-11-22). Extends
`docs/plans/session-artifacts.md`.

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

- **session tree** — a session, then every session below it through
  `parentSessionId`. Each node holds the session's record, digest, and
  artifacts. One read: `sessionTree(sessionId)`.
- **digest** — what one session did: its turns, its tool calls over time, its
  change summary, and its sub-agents. Stored, one row for each session. Do not
  call it a summary (Insights owns `sessionSummary`), an overview (that is the
  client view model, `SessionOverview`), or a report (that is a child's
  message to its parent).
- **change summary** — the part of a digest that holds the session's net
  change: files with line counts and totals. It holds no patch.
- **artifacts** — what a session linked: pull requests, works, files, images,
  automations, and apps, as `resource_links` edges of the session
  (session-artifacts decision 1).
- **section** — the part of the Threads surface that shows one node of the
  session tree.

## Decisions

1. **Every part of a node is in the database.** The record is
   `session_records`; the artifacts are the session's `resource_links` edges
   with `works`, `apps`, and the pull request snapshots (or, for a session
   another host runs, a copy: decision 8); the digest is `session_digests`. No
   tree read touches a transcript or a checkout. The facts a digest holds are otherwise only in the
   transcript and in Insights spans, which are telemetry and are deleted after
   the retention window; reading either on every tree read was rejected.
   (A version that projected the digest from the transcript on each read was
   built and replaced on 2026-11-21.)

2. **One digest row for each session.** Table `session_digests`:
   `session_id` (key), `organization_id`, `digest` (JSON), `updated_at`. Not a
   column of `session_records`, because session lists read records in bulk and
   a digest can be large. A session delete removes it.

3. **Only the host that runs the session writes its digest.** The owner,
   `execution/sessions/session-digests.ts`, hears the session's broadcast
   events as `WorktreeOffers` does (`sessionRuntime.on('event')` in
   `boot-server.ts`) and each checkpoint (`onTurnCheckpointed`).
   - Every live `user_message` opens a turn, a child's report
     (`via: 'session-report'`) too; `turn_settled` ends it. A sub-agent's own
     events (`parentToolUseId`) are not the turn's. A prompt sent to every
     client but its sender (`except`) is live; an event sent to one client
     alone (`only`) is a replay or an echo and is not read. A steer
     (`delivery: 'steer'`) joins the running turn and opens none.
   - A sub-agent is a tool call that `isSubagentTool` names: Claude's `Task`
     and `Agent`, Codex's `spawnAgent` and `codex_subagent`. Its title is its
     description, else its prompt. A background sub-agent stays running until
     it reports. A turn that does not complete stops the sub-agents still
     running in it.
   - It writes when a turn starts, at most once every 5 seconds while a turn
     runs, when it settles, and after each checkpoint. With no turn running it
     writes at once. It never writes for a streamed token. Between turns it
     holds nothing in memory; the next change reads the row.

4. **The digest's shape** (`contracts/src/session-digest.ts`).

   ```ts
   export interface SessionDigest {
     sessionId: string
     turns: DigestTurn[]               // oldest first, at most 500
     changes: SessionChangeSummary | null  // null before the first checkpoint: unknown, not zero
     subagents: DigestSubagent[]       // oldest first, at most 200
     lastReply: string | null          // the last thing said at the end of a turn, one line
     updatedAt: number
   }
   export interface DigestTurn {
     id: string                        // the prompt's clientPromptId
     startedAt: number
     endedAt: number
     settled: boolean                  // false while the turn runs
     prompt: string                    // one line, at most 240 characters
     toolCalls: [number, number][]     // [bucketStart, count] in 15-second buckets from startedAt
     changes: DigestTurnChanges | null // the turn's checkpoint totals
   }
   export interface DigestSubagent {
     id: string; title: string
     status: 'running' | 'completed' | 'failed' | 'stopped'
     startedAt: number; endedAt: number | null
     detail: string                    // what it came back with, one line
   }
   export interface SessionChangeSummary {
     files: ChangedFileStat[]          // largest change first, at most 500
     filesChanged: number; additions: number; deletions: number
   }
   ```

   The 15-second bucket is the finest span the timeline draws (session-artifacts
   decision 11), and buckets start at the turn's start, as the bars do, so a
   bucket never falls across two bars and the buckets lose nothing the plot
   shows. The file kind
   (Code, Tests, Docs) comes from the path on the client (`changedFileKind`).

5. **The change summary comes from each checkpoint.** After a turn's snapshot
   is written, `turn-checkpoints.ts` reads the session's own change
   (`getDiffStats` with scope `session`, largest file first) and hands it to
   the owner with the turn's totals; the turn does not wait for it. The owner
   puts the totals on the turn that started last before the checkpoint.
   - In a checkout the session shares, the existing rules keep other sessions'
     writes out (`keepOwnPaths`, `pathsOfOtherSessions`).
   - **Shared worktree fix:** each snapshot sidecar records its session's
     checkout (`workTree`). In a linked worktree, the whole-session diff leaves
     out the paths that only another session in that worktree changed in its
     turns (`pathsOfSessionsSharing`). A path both changed stays with both.
     Before the fix, a child that shares its parent's worktree counted its
     lines in both sessions.

6. **One read for the tree, a fixed number of queries.**
   `sessionTree(sessionId): Promise<SessionTree>`, `read` on the session
   resource, answered by the execution host in the session's own organization
   (`readSessionTree` in `data/sessions/session-digests.ts`, registered in
   `history-handlers.ts`). Each `SessionTreeNode` is
   `{ record, digest, artifacts }`; the session first, then each level below
   it, oldest started first, at most 200.
   - One statement walks the tree and reads the records: the record read
     (`readSessionMetadataPage`) with a recursive subquery over
     `parent_session_id` as its `WHERE`. The level order is made in memory.
   - One read for the digests, the batched artifact read for the sessions this
     host runs (`readArtifactsBySession`), and one read for the artifact copies
     of the sessions another host runs. The count does not grow with the
     tree's depth or width.
   - A session with no digest row has `digest: null`.

7. **One notice, sent up the tree.** Each digest write sends
   `session.digestChanged { sessionId }` (category `invalidation`): read
   `sessionTree` again. A host event reaches only the readers of the session it
   names (`eventResource`), so it is sent once for each session in
   `ancestorsOf(sessionId)`, as `session.artifactsChanged` is. A client that
   holds a tree reads it again on either event.

8. **The parent's host keeps a copy of a delegate on another host.** When this
   host starts a delegate on host B (`startRemote`), or messages one it keeps a
   copy of (`promptThere`), `copyRemoteSessionTree`
   (`execution/orchestration/remote-session-copies.ts`) reads host B's
   `sessionTree` of it and stores every node under the local parent
   (`storeRemoteSessionTree`):
   - the record through the upsert a runner's report uses, checked with
     `sessionRecordUpsertWireSchema`, with `runnerHostId` naming host B and
     the root's `parentSessionId` naming the local parent, which host B does
     not know; it is born in the parent's organization, owned by its owner;
   - the digest in `session_digests`;
   - the artifacts as one `session_artifact_copies` row of JSON, not
     `resource_links` edges, so a copied pull request starts no PR sync or
     watch here.
   The copy is read again when host B sends `session.digestChanged` or
   `session.artifactsChanged` for the delegate, when the connection comes
   back, and once more when the exchange ends; reads never overlap. A read
   that fails keeps the last copy, which the tree shows while host B is
   offline. Between exchanges the copy is not refreshed: a change made on host
   B while no message of this host runs there shows at the next one.

9. **No digest for old sessions.** Solus has no users yet; a session from
   before digests has `digest: null` until its next turn.

10. **An agent filter scopes the Threads surface (built 2026-11-22).** When the
    session started agents, a row of chips sits under "Pinned and recent":
    All, This session, then each session it started, oldest started first,
    each with its state (`AgentFilter.svelte`, `lib/agent-filter.ts`). It is a
    radio group: one chip is in the tab order, and Left and Right step. The
    default is All. It scopes the timeline and every card, as a turn does, and
    a turn and an agent combine; picking another agent clears the turn.
    - **All:** the session's own timeline, with its agents' tool calls stacked
      on its bars (`timelineLayout`'s `agentCallTimes`, `stackedBarHeights`);
      the changes of the whole tree, each file once (`mergedFileChanges`);
      every link, each naming the session that made it.
    - **This session:** the surface as it was: its transcript and git while
      its conversation is open, else its digest.
    - **A started session:** its digest's timeline and changes, and its own
      links. A session another host runs says it is this host's copy, and how
      old. A file of a started session opens that session's Threads surface.
    - The Agents card lists this session's agents only: no chips of what they
      linked (the chip props of `AgentRow` and `AgentGroups` are removed). Under
      a started session's filter it is hidden; that session's own Threads
      surface lists its agents.
    - Each kind of link has its own card, in this order: Pull requests, Works,
      Apps, Automations, Files, Images (`linkSections`). A kind with no links
      has no card. The single "Works and files" card is gone.
    - One turn's file list is a git read for this session only; a started
      session has no files for one turn of this timeline, so under a turn its
      changes are left out.

11. **One client-core layer for every client.** Desktop, web, and the phone
    read the tree through the same plain TypeScript, so they cannot differ:
    - `SessionTreeWatch` (`client-core/src/session-tree-watch.ts`) reads
      `sessionTree` while a surface holds it, and reads it again on
      `session.digestChanged` or `session.artifactsChanged` for the session, or
      `works.changed` for a work the tree lists. Reads never overlap: a change
      heard during a read makes one more read. A failed read keeps the last
      tree and sets `stale`. Its owner calls `refresh()` on a reconnect.
    - `client-core/src/session-tree.ts` is the model: `treeTimeline` (a node's
      turns and tool-call times for `timelineLayout`; an open turn ends at the
      present moment), `turnChanges`, `changeRows`, `treeTotals` (each file
      once; a file two sessions changed counts its lines once, as the larger
      change; `complete` is false when a summary was cut at its file limit),
      `childRows` (a row for each session below another: title, provider,
      status, running, remote, time worked, last reply, change totals,
      artifact and descendant counts), `descendantsOf`, and
      `treeOwnedArtifacts` (every node's artifacts with the session that
      linked them, for the existing `scopedArtifacts`).

12. **Desktop and web only.** Product decision (2026-11-22): the phone does not
    change in this plan. Its Threads screen keeps its artifacts and agents as
    they are. The tree store (`session-tree.store.svelte.ts`) wraps the shared
    `SessionTreeWatch`, so the phone can use the same watch later.

    **The conversation's changed-files card has the same filter.** Opened, a
    turn's card offers All, This session, and the sessions this one started
    that worked in that turn (`childRowsIn`, `turnWindow`). Its default is This
    session, so a closed card shows the count it always showed and asks the
    host nothing: the tree is read only while the card is open. A started
    session's whole change counts toward the turn it worked in; a file of a
    started session opens its Threads surface, and the header's link reads
    "Open its threads".

13. **Same file in two sessions** (answer to question 2): in a shared linked
    worktree the file shows in both sections; in the main checkout, during
    overlapping turns, the last write decides. Both stay as they are.

## Stage 0: one link path, one ancestor walk

The digest adds a second thing that is attached to a session and announced up
its tree. Before it does, make the first one (links) simple, so the digest
copies a clean shape and does not add a fourth path. Trace and diagram:
[Link call stack](work://embed?workId=4a13a52d-c26d-4235-ad8c-aba455f7a946&type=artifact)

### What is wrong now

1. **Two write paths for one operation.** `operations.putLink` already
   dispatches each kind to its rule (`SESSION_RULES` in
   `data/links/api-operations.ts`: `check`, `put`, `delete` for work, file,
   automation, and pr), and it works for a local home and an organization home.
   The agent tool uses it only for an organization session
   (`linkCallerItem`, `session-link-tools.ts:50`). For a local session it does
   its own role and organization checks and calls `linkSessionItem` directly.
   Unlink already goes through `operations.deleteLink`.
2. **One record read for each ancestor, for each change.**
   `emitSessionArtifactsChanged` (`data/sessions/session-artifacts.ts:36`)
   calls `getSessionRecord` once per level to find the next `parentSessionId`.

### What stays, and why

- **The event is sent once for each ancestor.** A host event reaches only the
  readers of the session it names (`eventResource`), and the mobile Threads
  screen reads again only on an exact id (`use-session-artifacts.ts:51`). One
  event for the child alone would not reach a reader of the parent.
- **The tool resolves the target from the agent's view.** A file path is
  relative to the agent's working directory: `fileLink` keeps `realpath`, the
  `host.files.read` check, and `assertPathInScope`. A PR number becomes a URL
  through the project's code host (`namedPullRequest`).
- **A pull request of an organization session is written twice.** The runner
  keeps its own row because its PR sync watches from there. The Solus API
  holds the session's link.
- **An app is linked on its host only** (`changeCallerAppLink`). The Solus
  API has no app links, so an app stays outside `putLink`.

### Changes

1. **The link tool always calls `home.operations.putLink`** for work, file,
   automation, and pr, local or organization. Remove the `home.remote` branch
   and the checks that `putLink` already makes (session `edit`, work `edit`
   and organization, automation readable). `linkCallerItem` becomes: resolve
   the target, then `putLink`. For pr on an organization home, also write the
   runner's row with `linkSessionPullRequest`, as now.
2. **`ancestorsOf(sessionId)`** in `data/sessions/session-records.ts`, beside
   `getSessionRecord`, which owns `session_records`: one recursive query over
   `parent_session_id`, the session first, the root last.
   A cycle ends it. `emitSessionArtifactsChanged` uses it, and so does
   `session.digestChanged` (decision 7).
3. The event payloads do not change. No client changes.

### What changed when it was built

- A link row's `source` stays `agent`. Its `author` is now the one `putLink`
  writes for every home (`requestAttribution`): the agent and its session, for
  the caller's person, without the provider. An organization session's links
  were already written this way.
- `putLink` refuses a session the caller cannot edit, now also for a pull
  request on a local home, which the tool did not check before.
- A session with no record: `putLink` answers "not found", as the tool's own
  `getSession` did before.

### Tests

- Link and unlink through the agent tool on a local home and on an organization
  home write the same row as before, with the same author.
- A link in a grandchild announces the grandchild, the child, and the root, with
  one query, and a cycle in the records ends the walk.

## Stages

0. Done: one link path and one ancestor walk (above).
1. Done: contracts (`contracts/src/session-digest.ts`, `sessionTree`,
   `session.digestChanged`), the `session_digests` table and its migrations,
   the digest owner, the checkpoint summary, the tree read, and the
   shared-worktree fix.
2. Done: copies of delegates on other hosts (decision 8), and the tree read
   with a fixed number of queries (decision 6).
3. Done: the client-core model and watch (decision 11).
4. Done: desktop and web: the agent filter on the Threads surface and the
   changed-files card, the link cards, and the Agents card without chips.
5. Not planned: the phone (decision 12).
6. Docs: update session-artifacts decisions 10, 14, 15, and 16, and
   `docs/session-orchestration.md`.

## Verification

- Unit (`session-digests`): a turn is written at its start and its settle, not
  for each tool call, and at most once in each interval while it runs; tool
  calls fall into 15-second buckets, without a sub-agent's own calls;
  sub-agents take their description and their answer on Claude and on Codex,
  and a background one is written at once when it reports; a stopped turn stops
  its sub-agents; a checkpoint lands on its turn; a new turn continues the
  stored digest.
- Unit (`session-tree`): each node carries its own record, stored digest, and
  artifacts; a subtree and another organization; a remote subtree is stored
  under its local parent with no `resource_links` edge; a session delete
  removes its digest.
- Unit (`remote-session-copies`): a delegate on another host is copied at once,
  again on that host's notice, and once more when the exchange ends; a host
  that cannot answer keeps the last copy.
- Unit (`turn-checkpoints`): two sessions in one linked worktree each keep only
  the paths their own turns changed; a checkpoint hands its listener the
  summary, largest file first, and the turn's totals.
- Unit (`session-artifacts`): the walk up the tree is one read, ends a cycle,
  and names a session with no row.
- Unit (`session-tree-model`): a node's timeline lays out with each call in
  its bar; the total counts each file once and says when it is cut; a row for
  each session below another, remote ones included; every artifact carries its
  session; the watch reads again only for its session or a listed work, never
  overlaps a read, and keeps the last tree, stale, when a read fails.
- Replay provider (`showcase`) for a turn that renders; no real provider turn.

## Execution status

The runner saves the current phase and latest turn outcome in
`session_executions`. A row belongs to a Solus session. A provider subagent
has a separate row under its tool call ID. The row has a revision and the
current and last turn IDs. A new turn can run while the last turn's outcome
remains available.

The runner saves each change before it sends `session.executionChanged`.
List, detail, watch, and tree reads return the saved state. Remote tree
copies accept a state only when its revision is newer. After a restart, the
runner marks its own open runs interrupted. Older sessions get a status when
the runner records a turn. The migration does not infer status from old
transcripts or delegation receipts.

The desktop and web Sessions store uses the revision to apply reads and live
updates in order. The Project panel and Threads use the same Agents card and
store. Native mobile uses the saved status in its existing session rows and
conversation.

## Open questions

None.
