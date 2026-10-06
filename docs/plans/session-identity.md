# Session identity

Status: implemented, 2026-10-06. The dual-id code is deleted.

A session has one id. Everything that belongs to a session records that id.
A provider thread id tells Solus where a transcript is. It never names a
session.

## Problem

A session had two ids, and each table chose one:

- The **provider thread id** keyed `session_records`, works, plans,
  automations (`createdBy`), comment and task attribution, the outbox, runner
  reports, and the Solus API's records.
- The **Solus id** keyed tabs, task links, session pull requests, session
  states, runs, watches, Insights spans and activity.

About 30 call sites translated between the two (`recordSessionId`,
`stableSessionIdForProviderThread`, `sessionIdForms`, `sessionIdFor`). Three
`rekey*` functions moved rows when a thread got a Solus id. The Solus API had
no map between the ids, so a session that changed provider became two records
there. Read state, remote session stubs and share grants each mixed the two.

## Vocabulary

- **session id** — the one id of a session. It does not change. Code that
  says `sessionId` means this id.
- **thread id** — the id a provider gives one conversation (a Claude session
  id, a Codex thread id). A session has one or more threads: a provider switch
  or a fork adds one. Code that holds this id says `threadId`.
- **lineage** — the ordered threads of a session (`session_lineage_members`,
  `session_thread_aliases`). It is the only map between the two ids.

Do not say "record id", "stable session id" or "Solus session id". There is
one session id.

## Decisions

1. **A thread that Solus finds on disk has the session id of its thread id.**
   A transcript that never ran in Solus has no lineage row. Its session id is
   its thread id, and the lineage row is written when it first runs in Solus
   with the same id. `sessionIdOfThread(threadId)` answers the lineage's
   session id, else the thread id. A session that Solus starts gets a new id
   from the client or the server, and the lineage binds its threads at
   `session_init`.
2. **The session id keys every record of a session.** This includes
   `session_records` on the host and on the Solus API, works, the plan's
   session, automations `createdBy`, attribution, task origin, the outbox,
   runner reports, share grants, pins and read state.
3. **The thread id is a locator only.** It is used by the provider adapters,
   the transcript index (`sessions`, `session_messages`, `session_fts`,
   `session_keys`, `session_files`), the transcript mirror's reads, and the
   plan's place in its transcript. These are facts about one transcript, not
   about the session. The runtime's thread-to-session map routes provider
   events at the adapter boundary, and nothing past it.
4. **One record for each session.** The indexer writes the record of a thread
   only when the thread is its session's active thread. A session that
   changed provider is one record that shows its current provider.
5. **No rekey.** A session id does not change, so nothing moves. The
   `rekey*` functions and `tasksRekeySession` are deleted.
6. **Agent tools get the session id.** `AgentToolContext.sessionId()` is the
   session id. No tool needs the thread, so the context does not carry it.
7. **No data migration.** Solus has no users yet. Old rows that hold a thread
   id are not converted. The one schema change, `indexed_plans.thread_id`,
   copies the old `session_id` into it, because those rows held the thread.
8. **A plan is named by its session and its tool use.** `planKey(sessionId,
   planToolUseId)`. `indexed_plans.thread_id` says which transcript holds the
   plan, so a reindex of one thread replaces only that thread's plans.

## Stages

1. `session_records` and its writers use the session id: the indexer, status,
   organization, publication, runner reports and intake, remote stubs.
2. Owned records use the session id: works, plans, automations, attribution,
   task origin, the outbox, sharing and access checks. The agent tool context
   gives the session id.
3. Delete the bridge code: `recordSessionId`, `useLiveRecordIds`, `rekey*`,
   `sessionIdForms`, and the double-id reads in tasks.
4. Clients: the picker, sidebar, pins, titles, goals and read state send the
   session id. The sidebar no longer collects several ids for one session.

## What changed

- `data/sessions/session-lineage.ts`: `sessionIdOfThread`, `activeThreadOf`
  and `isActiveThread` replace `stableSessionIdForProviderThread`. A miss is
  not cached, because a thread can join a session later.
- `session_records`: the indexer writes the record of the session's active
  thread only, under the session id. Status, organization, publication, the
  transcript mirror, runner reports and the tool context all use the session
  id. `recordSessionId`, `useLiveRecordIds`, `sessionIdForRecord`,
  `onSessionRecordBound` and `Delegations.bindRecord` are deleted.
- An organization is decided at admission and remembered under the session id,
  so the record is born in it. `applyPendingAssignment` only clears the wait.
- A thread with no lineage is its own session in `watchSession` and in an
  unattended prompt, so no random id is minted for it.
- `getSessionInfo`, `getIndexedSession`, titles, branches, read state and pins
  take a session id and read the index row of its active thread.
- Works, task origins, comments, automations (`createdBy`, `AutomationRun.sessionId`),
  outbox ops and plans record the session id. `readSessionOutputs` reads by
  that one id.
- Deleted: `rekeyTaskSessionLinks`, `rekeySessionPullRequests`,
  `rekeySessionState`, the `tasksRekeySession` RPC, and
  `SessionProviderSwitchResult.taskSessionMove` with its client handling.
- Clients: plans, works, titles and pins use `session.id`. The workspace finds
  a tab by host and session id (`tabIdForHostSession`). Mobile names plans and
  titles by the session id.
- Orchestration names sessions by session id. Exchanges, reports, notices,
  `AgentConversationRef`, `AgentConversationUpdate` and parent delivery carry
  `sessionId`. A spawn picks the child's session id before it dispatches, so
  there is no `pending:` id: the card shows `starting` until the child
  attaches. `senderAgentSessionId`, `targetAgentSessionId`, the prompt's
  `agentSessionId`/`agentMessageId` and `resolvePendingStarts` are deleted.
  Delegations name the parent by `parentSessionId`.
- Read state is `session_states.viewed_at`. `sessions.viewed_at` and
  `session-read-state.ts` are deleted. A provider switch copies the custom
  title to the new thread's index row, so the name follows the session.
- Git session snapshots, the diff and turn-snapshot reads, the review guide
  and review lenses use the session id.
- Search returns one hit for each session, named by its session id, with the
  best score of its threads.
- `Session.handoffId` is replaced by `Session.handoffPending`, which is true
  only while a provider switch waits for the new thread.
- Deleted with the bridge: `sessionIdFor`, `canonicalSessionId`,
  `sessionActivitySubject`, `ShareManager.canonical`,
  `cancelQueuedPromptForSession`, the client's `tabIdForAgentSession`,
  `sessionForAgentSession` (now `sessionForHostSession`),
  `sidebarSessionIds`, `stateSessionIds` and `taskBindingSessionId`. Session
  stores (states, pull requests, sidebar status) take one session id. PR sync
  maps a thread to its session where it reads the index.
- Opening a saved session uses its session id from the start. `watchSession`
  takes `{ sessionId, attachRuntime }` and no thread; its result has no
  `sessionId`, so a client never adopts an id from the host. `describeSession`,
  `getSessionInfo`, `loadSession`, `loadSessionPage` and `loadSessionPreview`
  take the session id and read its lineage. The `resolveSessionLineage` RPC is
  deleted. A tab that opens a saved session takes that session's id before it
  watches.

## Known limits

- `sessions.branch` and `sessions.model` stay on the thread's index row. They
  describe one transcript; a read reaches them through the active thread.
- Old rows that hold a thread id are not converted (decision 7).
