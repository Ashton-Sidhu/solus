# Session starter — record who started a session

Status: steps 1 to 3 built, 2026-10-30. Steps 4 and 5 (the client filter and
marks) are not built; §6 is still a proposal.

Related: `projectless-chat.md` (how a chat is known), `agent-delegation.md`,
`cross-host-sessions.md`, `webhooks.md` §3.1, `unified-search.md`.

## 1. Problem

A session does not record who started it.

- An automation run marks only its first user message (`via: 'automation'`,
  `automationId`). The contract says this mark is live-only: a history reload
  loses it (`packages/contracts/src/types.ts`, `via` on the message).
- A webhook `start_session` action marks nothing. `startUnattendedSession`
  gets no webhook id and no delivery id (`execution/webhooks/webhook-runtime.ts`).
- `startedBy: SessionOrigin` (`{ hostLabel, sessionId }`) names only a session on
  another host. It is kept in the machine index (`sessions.started_by`), not in
  `session_records`, so it does not sync to the Solus API.
- `delegation` names the parent session, but it is orchestration data (depth,
  intent, message), not an answer to "who started this".

Thus the picker and the sidebar cannot show or filter sessions by how they
started.

## 2. Vocabulary

- **Place** — where a session runs: `chat` or `project`. Stored.
- **Starter** — what started a session: a person, an automation, a webhook, or
  another session. Stored.

These are two axes. One session has one value on each axis. An automation can
start a chat or a project session, so one enum for both axes is wrong.

## 3. Decisions

### 3.1 Place is stored once, when the session is made

```ts
type SessionPlace = 'chat' | 'project'
```

- The host writes `place` when it makes the session, from the folder it runs
  the session in: `chat` for a folder it made under its chat root, `project`
  for every other folder. A worktree is a `project`.
- The value does not change. **Add project…** works only on a draft, before
  the first prompt, and **Run on** moves a chat to another host as a chat
  (`projectless-chat.md`).
- Readers use `record.place`, not a path match. The record reaches every
  client, so a client still knows a chat without asking its host. `isChat`
  stays only for a draft, which has no record yet, and for the host when it
  makes the session.
- The SQL filter `project_path LIKE '%-solus-chats-%'` becomes
  `place = 'chat'` (`session_records`, and the machine index `sessions`). This removes a false match for a project whose path
  contains `solus-chats`.

### 3.2 Starter is stored once, when the session is made

```ts
type SessionStarter =
  | { kind: 'person'; personKey: string }
  | { kind: 'automation'; automationId: string; runId: string }
  | { kind: 'webhook'; webhookId: string; deliveryId: string }
  | { kind: 'session'; sessionId: string; hostLabel?: string }
```

- `person` — a person sent the first prompt. `personKey` is the acting person,
  which can differ from the owner in organization work.
- `automation` — a scheduled or manual automation run.
- `webhook` — a webhook delivery ran a `start_session` action.
- `session` — another agent session started it. `hostLabel` is present only
  when that session is on another host. This kind replaces `SessionOrigin`.
- Ids only. A client reads the current name of an automation or a webhook
  through its store. When the source is deleted, the row says
  "Deleted automation" or "Deleted webhook".
- The host writes it once. No later operation changes it. A moved checkout
  (`continueInMovedCheckout`) keeps the same session, so it keeps its starter.
- `delegation` stays as orchestration data. It is no longer the only record of
  the parent.

### 3.3 New sessions only

Only sessions made after this change get a place and a starter. There is no
backfill: old records keep null in both fields. A client reads a null place as
a project and shows no mark for a null starter. A filter matches only sessions
that have the value it asks for, so an old chat is not in a chat filter.

## 4. Where the host writes it

| Start path | File | Starter |
|---|---|---|
| A client's first prompt in a tab (`submitPrompt`, `retry`) | `execution/sessions/prompt-dispatch.ts` | `person` (the actor) |
| `createSession` from a client RPC | `transport/handlers/session-handlers.ts` | `person` (the actor) |
| `createSession` from another host (`startedBy` today) | same | `session` with `hostLabel` |
| `createSession` from orchestration (`delegate_task` and similar) | `execution/orchestration/` | `session` (the parent) |
| `startUnattendedSession` with an automation | `boot-server.ts` dispatcher | `automation` (add `runId`) |
| `startUnattendedSession` from a webhook | `execution/webhooks/webhook-runtime.ts` | `webhook` (add `webhookId`, `deliveryId`) |

`startUnattendedSession` takes one `starter` field in place of its optional
`automation` field. The `via: 'automation'` message mark stays for the bubble
badge.

## 5. Contract and storage

- `packages/contracts/src/types.ts`: add `SessionPlace` and `SessionStarter`.
  Add `place: SessionPlace | null` and `startedBy: SessionStarter | null` to
  `SessionRecord`, and `place?` and `startedBy?` to `SessionMeta`. Remove `SessionOrigin`; its
  callers use `{ kind: 'session', ... }`.
- `session_records`: add `place TEXT` (indexed) and `started_by TEXT` (JSON),
  in the SQLite and Postgres schemas. Both are null on old rows (§3.3). They
  sync to the Solus API with the rest of the record
  (`sessionRecordUpsert`), so an organization's sessions keep it when the
  machine is off.
- The machine index column `sessions.started_by` holds the new shape. Old rows
  that hold a `SessionOrigin` read as null (§3.3).
- The machine index `sessions` table gets `place` too, so the search filter
  reads a column, not a path.
- Solus API: add `place` and `startedBy` to the session schema
  (`packages/contracts/src/solus-api/schemas.ts`), and run
  `bun scripts/generate-solus-api.ts`.
- `sessionMetaFromRecord` copies the field.

## 6. Clients (proposed)

- **Picker (desktop and web):** a "Started by" filter in the search options
  menu: Anyone, People, Automations, Webhooks, Agents. The row's second line
  shows the source when there is no match passage, for example
  "Automation · Nightly triage".
- **Sidebar:** a small mark on the row for automation, webhook, and agent
  starts. No new section. No "started by <name>" mark for a session that
  another person started (maintainer, 2026-10-30).
- **Mobile:** the same filter in Home search and the same mark on the row.
- **Providers:** no difference between Claude and Codex. The host writes the
  starter before the provider starts.

## 7. Steps

1. Contract, storage, and host writes (§4, §5), with tests that start a session
   on each path and read `place` and `startedBy` from the record and from the
   Solus API.
2. Move readers from `isChat(cwd)` to `record.place`, and the chat filters from
   the path match to the column.
3. Remove `SessionOrigin` and the old `startedBy` uses.
4. Picker filter and row mark (desktop and web), then mobile.
5. Sidebar mark.

## 8. Open questions

1. Must the picker filter persist between openings, as the other filters do?
2. ~~Must a session that another person started show their name?~~ Not in
   the session sidebar (maintainer, 2026-10-30).

## 9. As built

- `SessionPlace`, `SessionStarter`, and `SessionStarterFromHost` are in
  `packages/contracts/src/types.ts`; their Zod schemas, `hostStarterOf`, and
  `parseStoredStarter` are in `packages/contracts/src/session-starter.ts`.
  `placeOfFolder` (`contracts/chat.ts`) is the one folder rule, for the host
  and for a draft.
- The machine writes both in `persistIndexedSessionStart`, from the run's
  `startedBy`. `mergeRecord` and the upsert keep the first value.
- Migrations: Drizzle `0032_session_place_starter` (both engines) and the
  machine index `sessions.place`.
- `parentSessionIdOf` nests a session by its starter only when another host
  started it, as before. A local session started as independent stays
  top-level.
- `privateToOwner` in `runner-delivery.ts` still reads the folder. It is a
  privacy decision for the first delivery, so it does not depend on a value
  that old records do not have.
- Readers moved to `place`: `conversationProjectLabel` (desktop and web) and
  mobile `isChatSession`. Calls on a task's project key, a draft, or a live
  run's folder keep `isChat`.
