# Plan 012: One user, one actor, and one activity record

**Status:** IMPLEMENTED (uncommitted, 2026-09-29). All eight stages are built: one `User`, one `Attribution`, the actor on every request, one activity record for sessions, tasks and works, one user chip, and activity on the Solus API (mirrored session activity, record API reads, "activity naming me"). See "Implementation record" at the end.
**Depends on:** The plan 004 working-tree changes (stages 1–6, uncommitted). Plan 010 (OAuth) for account ids.
**Related:** Plan 004 item 1, D13 and D15 (notifications hub). Feature plan `de142de0` P7 owns
which person runs an automation or an agent-started turn. This plan gives P7 one place to
put that answer. It does not decide it.

## Why

Plan 004 added "who did this" to many places one at a time. The work showed four
problems.

1. **Six types describe one person.** `TurnAuthor` (`contracts/src/presence.ts:119`),
   `PresenceParticipant` (`presence.ts:18`), the client's `PresencePerson`
   (`workspace-ui/src/components/presence/lib/presence-people.ts:13`), the flat fields on
   the `org-member` principal (`server/src/admission/principal.ts:42`), `TurnActor`
   (`server/src/execution/seats/seat-manager.ts:151`) and `AccountProfile`
   (`contracts/src/account-types.ts:7`). More copies: `SessionActiveTurn`
   (`presence.ts:84`), `ShareList.changedBy` (`sharing.ts:124`), `CommentActor.person`
   (`comment-commands.ts:47`).
2. **Ids and labels stand in for people.** One `userId` string holds an account id, the
   `host-owner` sentinel, or `guest:<id>`. Comments and plans store the label `'you'`
   (`CommentAuthor`, `types.ts:1132`). So `TurnActor` has both `userId` and
   `accountUserId`, the client's `selfUserIds`
   (`workspace-ui/src/contexts/presence/presence.store.svelte.ts:147`) collects several
   ids for one reader, and comments carry a second `person` field to say who "you" was.
3. **"Who did this" has five shapes for things that are not people.** `TaskActor` and
   `actorLabel` (`task-types.ts:294`, `:382`) never say which user.
   `WorkContentAuthor` (`types.ts:1478`), `CommentAuthor` and `CommentAgentAuthor`,
   `AutomationCreator` (`types.ts:3297`), and a plain `author: string` on task comment
   ops (`outbox-types.ts:53`).
4. **Each handler works out the person, and each "who did this" fact has its own path.**
   Three conversions (`turnActorFor`, `turnAuthorOf`, `actedBy`); a `by` or `actor`
   parameter on each runtime method; `by` on about ten event types; six special
   `Message` fields. Fork, worktree-move and plan dividers exist only on the client
   that acted, so everyone loses them on a reload. Task events already solve this for
   tasks (`task_events`), in a different shape.

## Words used here

- **User** — a person, as Solus knows them: an id, a name, an email, an avatar.
- **User id** — the kind of person, and their id in that kind.
- **Attribution** — who or what did something: a user, an agent, an automation, an
  upstream system, or Solus itself.
- **Actor** — the user a request or a turn is for, with the principal that admitted it.
  It produces the attribution.
- **Host login** — the provider CLI's own login on a machine. It is a kind of seat, not
  a user.
- **Activity** — one thing that happened to a session, task or work that people read:
  a stop, a fork, a decision, a status change, a rename. The host stores it and sends it.

## Decisions

| # | Decision |
| --- | --- |
| U1 | One `User` type in contracts. It is plain data, not a class, because it crosses IPC and WebSocket and lives in Svelte `$state`. |
| U2 | The email is part of `User`. It is not private. |
| U3 | A user id names its kind: `account`, `local` or `guest`. No string sentinel and no `'you'` label is stored. |
| U4 | `HOST_OWNER_USER_ID` is deleted. Its three jobs move: the owner with no account becomes a `local` user minted once per host; the machine's provider login becomes the `host-login` seat; records nobody claimed belong to the host's user. |
| U5 | Linking a host moves the `local` user's rows to their account id, once. Unlinking is the reverse step. |
| U6 | One `Attribution` union names every kind of doer. It replaces `TaskActor`, `WorkContentAuthor`, `CommentAuthor`, `CommentAgentAuthor`, `AutomationCreator` and string authors. |
| U7 | Admission resolves the actor once and puts it on every request, for every domain: sessions, works, tasks, comments, sharing. Handlers and runtime methods take it. They do not convert the principal. |
| U8 | One activity record for sessions, tasks and works. Task events move onto it. The notifications hub (D15) reads it. |
| U9 | One user chip and one avatar component draw a user everywhere on the client. |
| O1 | `local` stays (decided 2026-09-29): Solus works without an account, so a host owner who never signs in is a `local` user. |

## 1. User and user id

```ts
// contracts/src/user.ts
export type UserId =
  | { kind: 'account'; accountId: string }   // a Solus account: members, a linked host's owner, a signed-in guest
  | { kind: 'local'; localId: string }        // this host's owner before they link an account
  | { kind: 'guest'; guestId: string }        // an anonymous link guest

export interface User {
  id: UserId
  displayName: string
  email?: string
  avatarUrl?: string
}

export function sameUser(a: UserId, b: UserId): boolean
/** The string for maps and rows: the bare account id, `local:<id>`, or `guest:<id>`. */
export function userKey(id: UserId): string
export function parseUserKey(key: string): UserId
export function userColorIndex(user: User): number   // moves here from server/src/presence/presence-color.ts
export function userInitials(user: User): string
```

What changes:

- `TurnAuthor` is deleted; the wire carries `User`. `colorIndex` leaves the wire: each
  client computes it with `userColorIndex`.
- `PresenceParticipant` becomes `{ user: User; clientId; deviceLabel; access; joinedAt }`.
  `SessionActiveTurn` becomes `{ author: User; provider }`.
- `ShareList.changedBy` becomes `User`. `ShareList.ownerUserId` and
  `grantedByUserId` hold user keys.
- The `org-member` principal holds `user: User` in place of its flat fields. The host's
  owner standing (`hostOwnerIdentitySchema`, `organization-scope.ts:36`) is a `User`.
- The client knows one `UserId` per host. "Is this me?" is `sameUser`.
  `selfUserIds` and its `host-owner` collection are deleted.
- The "Host owner" display cases are deleted: `share-rows.ts:147`, `:173`;
  `presence-people.ts:65`; `presence-manager.ts:276`.
- `AttentionEntry.resolvedBy?: string` (`attention-types.ts:18`) is never set. Delete it.
- `AccountProfile` stays the account plane's API shape and maps to `User` at the edge.
- `PersonMention` keeps its saved name (the name when the mention was written);
  its `userId` becomes a user key.
- Workspace projects' `createdBy: string | null` (`workspace-projects.ts:14`) holds a
  user key.

### Stored ids

`userKey` writes the strings the rows hold today for members (bare account ids) and
guests (`guest:<id>`). Only `host-owner` rows and `'you'` labels change. The columns:

- `resource_owner.owner_user_id`, `share_grant.subject_id` (user rows),
  `share_grant.granted_by_user_id` (`server/src/sharing/schema.ts`)
- `session_records.owner_user_id`, `session_admissions.owner_user_id`
  (`server/src/data/sessions/schema.ts`)
- `provider_seat.user_id` (`server/src/execution/seats/seat-manager.ts`)
- work and plan comment authors (`server/src/plans/annotations.ts:19`, `:32`, `:36`;
  work annotations), which hold `'you'` or `'solus'` today
- `insight_spans.user_id` and `runner_cursors.actor_user_id` hold account ids only; no change

Migration (one new migration file per engine):

1. At boot, mint the host's `local` id once and store it in host settings.
2. Rewrite `host-owner` to `local:<id>` in the ownership, grant and session columns.
3. The `host-owner` seat row becomes the `host-login` seat (section 3).
4. Comment and plan-comment authors: `'solus'` becomes a `system` attribution; `'you'`
   becomes the comment's stamped `person` when it has one, and otherwise the host's
   user. The separate `person` field goes.
5. On link (U5): rewrite `local:<id>` to the owner's account id in the same columns, in
   one transaction. On unlink, the reverse.

The Solus API projections that answer `ownerUserId ?? 'host-owner'`
(`data/sessions/api-operations.ts:33`, `data/tasks/api-operations.ts:27`,
`data/works/api-operations.ts:37`) answer the stored key. A record always has an owner
after step 2.

## 2. Attribution

```ts
// contracts/src/user.ts
export type Attribution =
  | { kind: 'user'; user: User }
  | { kind: 'agent'; sessionId: string; provider: AgentId; for?: User }   // for: whose turn it was
  | { kind: 'automation'; automationId: string; name?: string; for?: User } // for: its creator (P7)
  | { kind: 'upstream'; provider: DocProviderId | TrackerId }
  | { kind: 'system' }
```

It replaces:

| Today | Where |
| --- | --- |
| `TaskActor` and `actorLabel` | `task-types.ts:294`, `:382`; `createdBy` at `:166`, `:318`, `:355` |
| `WorkContentAuthor` | `types.ts:1478` (work revisions) |
| `CommentAuthor`, `CommentAgentAuthor`, `person?`, `resolvedBy` | `types.ts:1132-1199`; `comment-commands.ts:70`, `:82`, `:107`, `:141` |
| `AutomationCreator` | `types.ts:3297` |
| `author: string` on task comment ops | `outbox-types.ts:53` |
| the plan decision comment stamped `'you'` | `execution/orchestration/plan-decisions.ts:25` |

`for` is where P7's answer lands: an agent's work is done for the person whose turn
started it, and an automation's for its creator. Nothing here decides who that is.

Kept separate on purpose: GitHub and Jira authors and assignees (`providers.ts`,
`task-types.ts:86`, `:519`), Google comment authors (`work-comments.ts:4`), and git
commit identity (`GitIdentity`). They are other systems' people. Something they did in
Solus is an `upstream` attribution.

## 3. The host-login seat

`seatUserFor` (`seat-manager.ts:138`) answers the host-owner sentinel for the owner, the
runner and the host itself. The seat store then special-cases that string in about ten
places (`seat-manager.ts:236`, `:266`, `:286`, `:304`, `:323`, `:373`, `:382`, `:403`,
`:412`, `:427`; `usage-handlers.ts:52`, `:63`, `:132`; `seat-connect.ts:52`).

Change: a seat is `{ kind: 'host-login' } | { kind: 'user'; userId: UserId }`.

- The owner of an unlinked host runs on `host-login`, as today.
- The owner of a linked host also runs on `host-login` unless they connect a seat of
  their own. This keeps today's behavior.
- A guest runs on the sharer's seat, as today.
- A turn with no actor does not fall back to `host-login`. It is refused
  (`SEAT_REQUIRED`). This is plan 004 item 1's rule; the fallback at
  `session-runtime.ts:1791` goes away when P7 gives every turn an actor.

## 4. The actor on every request

```ts
// server/src/execution/actor.ts
export interface Actor {
  principal: Principal
  user: User | null        // null only for the host's own work
}
export const HOST_ACTOR: Actor
export function actorFor(principal: Principal, host: HostOrganizations): Actor
export function attributionOf(actor: Actor, via?: { sessionId: string; provider: AgentId } | { automationId: string }): Attribution
export function seatFor(actor: Actor): Seat
export function credentialUserFor(actor: Actor): UserId | null   // today's integrationUserFor
```

- `SolusServer.handle()` calls `actorFor` once and sets `HandlerCtx.actor` for every
  RPC. `actorFor` takes over `turnActorFor` and `attributeActor` (the linked owner's
  account is part of the user now).
- `TurnActor` and its nine fields are deleted. `turnAuthorOf`, `actedBy` and
  `principalDisplayName` are deleted.
- **Sessions.** Runtime methods that a person causes take `actor: Actor`:
  `submitPrompt`, `createSession`, `retry`, `stopSession`, `respondToPermission`,
  `respondToQuestion`, `resolveRateLimit`, `cancelQueuedPrompt`, `editQueuedPrompt`.
  The `by?: TurnAuthor` parameters and their private copies go. Admission
  (`admitTurnOrganization`) takes the actor. Retry passes through it too.
- **Works and comments.** `CommentActor` becomes `{ actor: Actor; canModerate }`. Work
  saves record `attributionOf(actor)` as the revision author.
- **Tasks.** Task writes and task comment ops record `attributionOf(actor)`, not
  `'user'` or a string.
- **Sharing, publication and automations.** `principalOwnerId(principal) ?? HOST_OWNER_USER_ID`
  (`share-manager.ts:556`, `:613`, `:684`; `organization-handlers.ts:76`) becomes
  `userKey(actor.user.id)`. An automation's creator is `attributionOf(actor)` at create
  time.
- **Delivery and Insights.** The outbox's `actor_user_id` and Insights' `user_id` read
  `actor.user` (account ids).
- The credential rule has one home. The fallback at `session-runtime.ts:280`, which
  exists only for actors with no principal, is deleted.

Call sites that convert today (line numbers at the time of writing):
`transport/handlers/session-handlers.ts:185`, `:302`, `:379`, `:390`, `:398`, `:404`,
`:410`, `:416`; `boot-server.ts:593`; `transport/handlers/history-handlers.ts:255`;
`execution/session-runtime.ts:1941`, `:2032`, `:2726`, `:3494`, `:3545`, `:4009`.

P7 hook (not decided here): the orchestrator's `createSession` and `promptSession`
(`execution/orchestration/session-orchestrator.ts:226`, `:279`, `:396`) and
`startAutomationSession` (`session-runtime.ts:2389`, from `boot-server.ts:558`) take an
`Actor`. P7 decides whose.

## 5. Activity

One record for what happened to a session, a task or a work.

### Contract

```ts
export type ActivitySubject = { kind: 'session' | 'task' | 'work'; id: string }

export type Activity = {
  id: string
  subject: ActivitySubject
  at: number
  by: Attribution
  turnId?: string        // a session activity inside a turn
} & ActivityKind

export type ActivityKind =
  // sessions
  | { kind: 'stopped' }
  | { kind: 'forked'; sourceSessionId: string }
  | { kind: 'moved_to_worktree'; path: string; branch?: string }
  | { kind: 'agent_switched'; provider: AgentId; model?: string }
  | { kind: 'plan_decided'; planId: string; decision: 'accepted' | 'rejected'; newSessionId?: string }
  | { kind: 'permission_decided'; questionId: string; tool: string; decision: PermissionDecision }
  | { kind: 'question_answered'; questionId: string }
  | { kind: 'rate_limit_decided'; action: RateLimitDecisionAction }
  | { kind: 'queued_prompt_changed'; queueId: string; change: 'removed' | 'edited'; author?: User }
  | { kind: 'seat_needed'; provider: AgentId }
  // any subject
  | { kind: 'renamed'; title: string }
  | { kind: 'shared'; with: 'organization' | 'user'; userId?: UserId }
  | { kind: 'mentioned'; userId: UserId; threadId?: string }
  // tasks: today's TaskEventKind, with its from/to/target fields
  | { kind: 'task_changed'; change: TaskEventKind; from?: string | null; to?: string | null; target?: TaskEventTarget }
```

### Host

- `data/activity/activity.ts`: `appendActivity(activity)`, `activityFor(scope, subject)`
  and `activityFor(scope, { userId, since })` for the notifications hub. Plain functions,
  like `session-records.ts`.
- Table `activity` (`organization_id`, `subject_kind`, `subject_id`, `id`, `at`,
  `turn_id`, `kind`, `by_kind`, `by_user_key`, `by` JSON, `data` JSON). It is not part
  of `session_messages`: that table is rebuilt from provider files and would lose these
  rows (the C2 point in plan 004).
- **Task events move.** `task_events` (`data/tasks/schema.ts:107`) is copied into
  `activity` as `task_changed` rows (`actor` becomes an attribution: `'user'` becomes the
  host's user, `'agent'` and `'automation'` keep `actor_label` as the name). The
  functions `appendTaskEvent`, `diffTaskEvents` and `readTaskEvents`
  (`data/tasks/task-events.ts`) become thin callers of the activity functions, then their
  five importers (`task-store.ts`, `task-lifecycle.ts`, `task-sessions.ts`, `task.ts`,
  `task-links.ts`) call the activity functions directly. `task_events` is dropped after
  the copy.
- `SessionRuntime.recordActivity(subject, actor, kind)` appends, then emits
  `{ type: 'activity', activity }` through the existing `_emit` for sessions. Tasks and
  works publish through their existing invalidation events. The rename, share and
  mention paths call the same function.
- The transcript read merges session activity by `at`; an activity with `turnId` goes
  inside its turn. Session activity is small, so this is one pass.
- The transcript mirror and the record API send activity to the Solus API for
  organization records.

### Host actions that replace client steps

- `acceptPlan(sessionId, planId)`: stop, reset, start the new session, record
  `plan_decided`. Replaces the client steps at
  `workspace-ui/src/contexts/workspace/session-plan-operations.ts:150-180`.
- `rateLimitDecision('wait')` records `rate_limit_decided` like the other choices
  (`session-runtime.ts:3636`).
- Fork and move-to-worktree record their activity in the host code that does the work.
  The client writers at `session-opening.ts:147` and `:271` are deleted.
- Agent switch records `agent_switched`. The lineage rebuild
  (`session-runtime.ts:1316`, `:1392`) stays for sessions switched before this record existed.
- A mention (plan 004 item 13) records `mentioned` when it is first saved. This is what
  the notifications hub (D15, D16) reads; it needs no diff of document bodies.

### Client

- One reducer case, `activity`, pushes `{ role: 'system', activity }` into the
  transcript. The task page's timeline reads the same rows.
- One `ActivityRow.svelte` switches on `kind`, and names the doer with the user chip
  (section 6) and `actorName` ("you" only for the reader, via `sameUser`).
- Deleted: `Message.actedBy`, `personNotice`, `forkSourceSessionId`,
  `worktreeMovedTo`, `worktreeMovedToPath`, `agentChangedTo*`,
  `newSessionForPlanId`; `recordStopper`, `pushPersonNotice`, the rename-notice path
  (`session-title-change.ts:29`); five branches of `TranscriptItem.svelte`; the task
  timeline's own event renderer.
- State events keep their state job and lose `by`: `status_change`,
  `prompt_dequeued`, `prompt_queue_updated`, `rate_limit_resolved`,
  `permission_resolved`, `question_answered`. `turnAuthor` on
  `permission_request`, `question_request` and `rate_limit` becomes `turnAuthor: User`.

Not in this plan: prompt authors (D13). A `prompt_authored` activity could hold them, but
placing it next to its provider message needs the message key from plan 004 C2.

## 6. One way to draw a user

Five client components draw "avatar and name in presence colour":
`presence/PresenceAvatar.svelte`, `presence/PersonName.svelte` (plan 004 stage 4),
`presence/TurnAuthorLabel.svelte`, `mentions/PersonMention.svelte`, and the share
dialog's member rows (`sharing/lib/share-rows.ts`). Comment threads draw their own.

- `components/users/UserAvatar.svelte` and `components/users/UserChip.svelte` take a
  `User` (and a size). `UserChip` shows the first name inside cards and dividers, and
  the full name elsewhere.
- The other five become callers, then are deleted where they only forwarded props.
- **One member list.** The organization directory (`sharesStore.directoryFor`) answers
  `User[]`. The mention picker, the share dialog's add-people row, and task assignee
  choices for organization tasks read that one list and draw `UserChip` rows.

## Stages

Each stage is one pull request with focused tests. No build, no dev server.

| Stage | Work | Proof |
| --- | --- | --- |
| 1 | `User`, `UserId`, `Attribution`, the functions; `local` id minted; `host-owner` rows and `'you'` labels migrated; link and unlink move rows | Migration test on a fixture database: owner rows become `local:<id>`, then the account id on link, and back on unlink; `'you'` comments get their stamped user. `sameUser` and `userKey` round trip. |
| 2 | `host-login` seat; seat store without the sentinel | Seat tests: the owner runs on `host-login`; a member on their own seat; a guest on the sharer's; a turn with no actor is refused. |
| 3 | `Actor` on every request; session runtime methods take it; `TurnActor`, `turnAuthorOf`, `actedBy` deleted; `User` on the wire | Existing runtime and presence tests pass with the new shapes; the client's "is this me" is one id per host. |
| 4 | `Attribution` in works, comments, tasks, automations, sharing, delivery | A work revision, a comment, a task change and an automation each name the same user for one person's actions; an agent's names the session and the person it worked for. |
| 5 | Activity: table, functions, event, read merge, `ActivityRow`; move session stop, answers, decisions, queue changes, rename, share, seat; copy `task_events` and drop it | An activity survives a reload; a teammate gets it live; the task timeline shows the same rows as before the copy, now with users. |
| 6 | Host `acceptPlan`, fork, worktree and mention activity; delete the old `Message` fields and client dividers | Plan accept, fork, move and mention each record one activity with the actor; nothing else writes a divider. |
| 7 | `UserAvatar`, `UserChip`, one member list | The five user-drawing components render through `UserChip`; the mention picker, share dialog and assignee choices read one list. |
| 8 | Activity in the transcript mirror and the record API | An organization record's activity reaches the Solus API, and the notifications hub can read a user's `mentioned` rows. |

Stages 1–4 are the refactor. They change no visible behavior except real names in
place of "Host owner" and "you". Stages 5–8 are new behavior.

## Risks

- **Wire change.** `User` replaces `TurnAuthor` and the flat presence fields;
  `Attribution` replaces five author shapes. The desktop, web and mobile clients share
  `packages/workspace-ui`, so they change together. An older client against a newer
  host fails to read authors: accept, the same as other contract changes in this tree.
- **Task events copy.** Old `'user'` rows have no user. They become the host's user,
  which is right for a personal host and a guess for a shared one. Say so in the
  migration's log line.
- **solus-cloud.** The account plane's contracts copy (`src/lib/shared/uplink.ts`)
  carries account ids only. Only the standing's owner and member ids are affected,
  and they are already account ids. The Solus API (this repo's
  `boot-solus-api.ts`) serves activity for organization records in stage 8.
- **Activity order.** Ordering by `at` is right for dividers and notices between turns. A
  session activity inside a streaming turn uses `turnId`.
- **Size.** `session-runtime.ts` (over 4,000 lines) and the reducer (`apply`, lint
  complexity 245) change in most stages. Keep each stage's change to the lines it names.

## Implementation record

(Each stage adds its entry here.)

### Stage 1 — User, UserId, Attribution; the host's user; row moves (2026-09-29)

**Done.**

- `packages/contracts/src/user.ts`: `UserId`, `User`, `Attribution`, their zod schemas,
  `sameUser`, `userKey`, `parseUserKey`, `userColorIndex` (the same FNV-1a hash as
  `presenceColorIndex`, over the user key) and `userInitials`.
- Host settings (`host/settings.ts`) hold `hostUser: { localId, account?, adoptedAt? }`.
  `hostUserSettings()` mints the `local` id once and stores it.
- `host/host-user.ts` holds the host's user in memory: `hostUserId`, `hostUser`,
  `hostUserKey` (the account once linked, else `local:<id>`) and `isHostUserKey`
  (the current key or the legacy sentinel).
- `host/host-user-rows.ts` lists the user-key columns once: `resource_owner.owner_user_id`,
  `share_grant.subject_id` (user rows) and `granted_by_user_id`,
  `session_records.owner_user_id`, `session_admissions.owner_user_id`, and the comment
  threads in `plan_annotations.comments` and `work_annotations.data`.
  - `adoptHostUser` (boot, once, marked by `adoptedAt`): `host-owner` becomes the host's
    key in every column; every stored comment gets an attribution (migration steps 1, 2, 4).
  - `followHostAccount(owner)`: the standing names the owner's account → every row of the
    host's user moves to the account (U5). The link is removed → the rows in the Local
    organization move back to `local:<id>`; organization records keep the account,
    because the organization knows its people by account. One transaction for the rows,
    then host settings. Moves run one at a time.
- Stored comments (`annotations/stored-comments.ts`): the host stores `author` and
  `resolvedBy` as an `Attribution`, with no `'you'` label and no `person` or
  `resolvedByPerson`. `'solus'` with an agent becomes `agent`, else `system`; `'you'`
  becomes the stamped person, else the host's user; `readBy` marks of `host-owner` move
  to the host's key. Plan and work annotation reads and writes go through
  `toStoredComments` / `fromStoredComments`; the wire shape does not change. A plan's
  wire threads still carry no person.
- New owner rows use the host's key: `principalOwnerId` answers `hostUserKey()` for
  `local-owner` and `remote-owner`; the `?? HOST_OWNER_USER_ID` fallbacks in
  `share-manager.ts`, `organization-handlers.ts`, `turnActorFor` and `activeTurnFor`,
  and the `?? 'host-owner'` answers of the three `api-operations.ts`, use `hostUserKey()`.
  The owner checks in `credentialScopedAgentTools`, `activeTurnFor` and the task sync
  credential use `isHostUserKey`.
- `connectionsGetServerInfo` answers the host's key as `userId` for `local-owner`, so the
  client's "is this me" set holds it. The client reads a `local:` key as the host owner
  (`isHostOwnerKey` in `contracts/sharing.ts`) in `share-rows.ts`, `presence-people.ts`
  and `presence.store.svelte.ts`.

**Decisions.**

- No new migration file. No table or column changes. The data move needs the `local`
  id, which is in host settings, and a SQL migration cannot read it. The Solus API has
  no host user. So the move is the boot step `adoptHostUser`, marked done in host
  settings after the rows commit; a crash before the mark repeats a move that is
  idempotent.
- The Solus API has no host user: `useHostUser` is never called there, `hostUserKey()`
  answers the legacy sentinel, and `toStoredComments` stores threads as they came. A
  work transfer's fingerprint covers the exact comment JSON, and a retried import must
  find the JSON it wrote.
- The agent attribution has `title?`: the session name when the agent wrote, so the
  thread keeps its signature. The plan's section 2 does not list it.
- A `local` user's display name is the operating-system user name ("Host owner" if it
  cannot be read); a linked host's user is named from the standing's owner.

**Left for later stages.**

- Stage 2: `HOST_OWNER_USER_ID` still names the host-login seat (`seatUserFor`,
  `seat-manager.ts`, `seat-connect.ts`, `usage-handlers.ts`, `setup-handlers.ts:627`,
  `git-identity-manager.ts`, `departed-members.ts`); `provider_seat` is not touched.
- Stage 3: `claimForRunner` (`share-manager.ts:277`) still writes the sentinel for a
  runner with no person (Solus API only). `principalDisplayName` still says "Host
  owner"; the client's `selfUserIds` still adds the sentinel; the "Host owner" display
  cases remain and now also cover `local:` keys. `solus-api/schemas.ts` examples
  still show `host-owner`. Delete `HOST_OWNER_USER_ID`, `isHostOwnerKey` and
  `isHostUserKey` when their last caller goes.
- Stage 4: the wire comment types (`CommentAuthor`, `person`, `resolvedByPerson`)
  become `Attribution`; then delete `fromStoredComments` and the legacy branch of
  `toStoredComments`. Rows written before stage 1 still hold `host-owner` in
  `works.content_author`, `work_revisions.author` and automation `createdBy.userId`;
  stage 4 maps them when those become attributions.
- The Lab's `share-matrix` scenario expects `host-owner` as the owner on a personal
  host. It must expect the host's key. It was not run.

**Verified.**

- `bun test tests/unit/host-user.test.ts`: 7 pass. It proves the round trip of
  `userKey`/`parseUserKey`, that `userColorIndex` equals `presenceColorIndex` for the
  same key, and on a fixture database: sentinel rows and `'you'` comments move to
  `local:<id>` at boot (a member's comment keeps its person, an agent reply its
  signature, a plan comment stays without a person); a second boot changes nothing;
  linking moves the rows to the account; unlinking moves the Local ones back and leaves
  the organization's rows on the account.
- The related suites (sharing, sessions, admission, comments, plans, presence, uplink,
  organization, seats, works): 523 pass, 24 fail. The failures come from other work in
  the tree (`isNewerRecord` export, `runed` package, `async_questions` queries,
  `turnActorFor` principal field). `work-google-comments` and `organization-vm-flow`
  pass alone and with `host-user.test.ts`; they fail only beside other suites.
- `tsc` for server, contracts and workspace-ui: no errors in the changed files.
  `oxlint` on the changed files: no new findings (`bootServer` complexity is 27, as
  before).

### Stage 2 — The host-login seat (2026-09-29)

**Done.**

- `contracts/src/seats.ts`: `Seat = { kind: 'host-login' } | { kind: 'user'; userId: UserId }`
  and `HOST_LOGIN_SEAT`. `SeatChangedEvent` carries `seat` in place of `userId`.
  `seatRemove` still takes a user key: only a user seat can be removed.
- `seat-manager.ts`: every `SeatStore` method takes a `Seat` (`remove` takes a
  `UserId`). The store decides by `seat.kind` and compares no user key. `seatKey(seat)`
  is the string for maps, logs and `provider_seat.user_id`: a user seat is its user's
  key, and the host login is `@host-login`, which the user seat id pattern cannot
  produce. `TurnSeat` carries `seat` in place of `userId` and `isHostLogin`.
- `seatUserFor(principal)` answers a `Seat`: `local-owner`, `remote-owner`, `runner`
  and `system` run on the host login; an `org-member` on their own account's seat; a
  guest on the sharer's seat, which is the host login when the sharer is the host's
  user (`isHostUserKey`, so a link made before stage 1 still works). This also fixes
  a stage 1 gap: a guest of the owner had a `local:` sharer key and was refused.
- `TurnActor.seatUserId` is `TurnActor.seat`. The shared-prompt wire from the Solus API
  keeps `seatUserId` (a user key); the runner turns it into a user seat at the edge.
- Callers moved to `Seat`: `seat-connect.ts`, `usage-handlers.ts` (reads keyed by
  `seatKey`, `clientsForSeat`), `seat-handlers.ts`, `setup-handlers.ts`,
  `git-identity-manager.ts` (`resolve(seat)`), `departed-members.ts` (no sentinel
  filter: `memberUserIds` never lists the host login), `boot-server.ts`, the Codex
  pool and the Claude seat, the e2e mock backend, and the Lab oracle and scenarios.

**Decisions.**

- No new migration file. `provider_seat` is created by `seat-manager.ts`, not by
  drizzle, so the `SeatManager` constructor moves the old `host-owner` row to
  `@host-login` at startup (`UPDATE OR IGNORE`, then delete the old row). It is
  idempotent. `0022_host_login_seat` and `0011_host_login_seat` stay free.
- The owner of a linked host runs on the host login. "Unless they connect a seat of
  their own" is the owner reaching the host as an organization member: that principal
  runs on their account's seat, as before. No fallback from that seat to the host
  login was added.
- **A turn with no actor still runs on the host login.** Automations, the orchestrator
  and other agent-started turns have no actor yet, so refusing them with
  `SEAT_REQUIRED` would break them. `SessionRuntime.seatForTurn` keeps the fallback,
  with a comment that names plan 004 item 1 / P7. Remove it when P7 gives every turn
  an actor.
- The client is unchanged: it reads `SeatStatus` (with `hostLogin`), which did not
  change, and it never read `SeatChangedEvent.userId`.

**Left for later stages.**

- Stage 3: `HOST_OWNER_USER_ID` remains only in the one-time row move
  (`LEGACY_HOST_LOGIN_ROW_ID`), `hasLeftOrganization`, `isHostUserKey` and the stage 1
  leftovers. `TurnActor` and `turnActorFor` remain; `seatFor(actor)` replaces
  `seatUserFor` when the `Actor` lands.
- The Lab's `seats` and `cloud-sessions` scenarios were updated but not run.

**Verified.**

- `bun test tests/unit/seat-manager.test.ts`: 15 pass. New proofs: the owner and a
  guest of the host's user run on the host login for a `local` and for a linked key (a
  store that compared the owner's key fails this); a member whose account id is
  `host-owner` gets a seat of their own, not the host login; an old `host-owner` row
  (a pasted owner token) reads as the host login after a restart and is never swept.
- The seat, usage, session-runtime, scratchpad, git identity, member removal,
  presence, organization and sharing suites: 213 pass, 8 fail. The failures are not in
  seat code: a duplicate `pr_state` column in the test database stops
  `session-runtime-seats` and `session-runtime-agent-dispatch` before dispatch; the
  others are the usage-store epoch, a question-answer promise, git fixture repositories,
  `$derived.by` outside Svelte, and the `async_questions` query budget.
- `tsc` for server, contracts and workspace-ui: no errors in the changed files. `oxlint`
  on the changed files: no new findings.

### Stage 3 — The actor on every request; `User` on the wire (2026-09-29)

**Done.**

- `server/src/execution/actor.ts`: `Actor { principal, user }`, `HOST_ACTOR`, `actorFor`,
  `attributionOf`, `seatFor` (was `seatUserFor`), `credentialUserFor` (was
  `integrationUserFor`, now a `UserId`), `withActorCredentials` (the credential scope for
  an actor; used by `SolusServer.handle()`, the Solus API router and agent tools) and
  `insightsAccountOf` (the account a turn is attributed to in Insights; was
  `attributeActor` plus `TurnActor.accountUserId`/`email`).
- `SolusServer.handle()` takes a `CallerCtx` (the transport's context) and passes
  handlers a `HandlerCtx` with `actor` set once. The WebSocket transport passes a
  `CallerCtx`.
- Deleted: `TurnActor`, `turnActorFor`, `seatUserFor`, `turnAuthorOf`, `actedBy`,
  `attributeActor`, `integrationUserFor`, `server/src/presence/presence-color.ts`,
  `isHostOwnerKey`, the client's `activeTurnAuthor`, `AttentionEntry.resolvedBy`, the
  client's `hostOwnerName` and `identityOf`.
- Session runtime: `stopSession`, `retry`, `respondToPermission`, `respondToQuestion`,
  `resolveRateLimit`, `cancelQueuedPrompt` and `editQueuedPrompt` take `actor: Actor`;
  `submitPrompt`, `promptSession` and `createSession` carry `actor?: Actor`. Private
  helpers carry `by?: User`. Internal callers (orchestrator, delegation revoke, run
  cancel) pass `HOST_ACTOR`. The credential fallback for actors with no principal is
  gone: every actor has one. `admitTurnOrganization` takes the actor, and `retry`
  passes through the same admission as `prompt`.
- Wire: `User` replaces `TurnAuthor` on every event field (`by`, `turnAuthor`,
  `author`), `Message.author`, `Message.actedBy`, the queued-prompt author and
  `SessionTitleChangedEvent.by`. `PresenceParticipant` is `{ user, clientId,
  deviceLabel, access, joinedAt }`; `SessionActiveTurn` is `{ author, provider }`.
  `ShareChangedEvent.changedBy` and `organizationSharedBy` are `User`. `colorIndex` left
  the wire; the client computes `userColorIndex`. `connectionsGetServerInfo` answers
  `user`.
- Client: `presenceStore.selfUserId(serverId)` is the one `UserId` per host (the room's
  own row, else the connection's identity); "is this me" is `sameUser`. `actorName`,
  `otherPerson` and every label helper take `(User, UserId | null)`. `personOf(user)`
  builds the avatar model for `TurnAuthorLabel`, `PersonName` and presence rows. The
  roster merges people by user key. The "Host owner" display cases are gone
  (`share-rows.ts`, `presence-people.ts`, `presence-manager.ts`); the share dialog names
  the reader's own row from their user.
- `HOST_OWNER_USER_ID` is left only in the one-time row moves (`host-user-rows.ts`,
  `LEGACY_HOST_LOGIN_ROW_ID`, `stored-comments.ts`), `isHostUserKey` (a guest link
  shared before stage 1), `departed-members.ts`, the Solus API's `hostUserKey()`
  fallback and `claimForRunner` (stage 4). The API schema examples show a `local:` key.

**Decisions.**

- `actorFor(principal)` reads the host's user from `host-user.ts`, not from
  `HostOrganizations`: `followHostAccount` already moves the host's user to the linked
  account, so the owner's user is the account once linked. One source, no second
  lookup. The host's own admitted work (`system`) is attributed in Insights to the
  linked account, as `attributeActor` did.
- A `local-owner` with no host user (the Solus API, tests) has `user: null`, and joins
  no presence room. A real host always sets its user at boot.
- A runner and `system` have `user: null`. A runner's `ownerUserId` is not yet a user
  (it has no name); stage 4 decides it with delivery.
- `hostOwnerIdentitySchema` stays as it is: it is the account plane's contract
  (`uplink.ts`, copied verbatim by solus-cloud). `actorFor` maps it at the edge through
  the host's user.
- The `org-member` principal keeps its flat fields: the principal is persisted in
  workspace API tokens (`principalSchema`), and `actorFor` builds the `User` from them
  in one place. Moving them into `user: User` is left for later.
- `ShareChangedEvent.changedBy` is optional: absent when the host itself changed the
  share. The notice then says "Access removed" (it said "Access removed by Solus").
- `createSession` keeps `actor?`: the orchestrator calls it with none until P7 decides
  whose turn it is, and `seatForTurn` keeps its no-actor fallback (stage 2).
- The shared-prompt runner builds a guest actor from the Solus API's command: the
  user is the one the API named, and the seat and credentials follow the guest rule
  (`sharedByUserId` = the command's seat key). The old principal-less actor is gone.
- `principalDisplayName` and `turnAuthorFor` stay as deprecated shims (stage 4): the
  works area (`data/works/work.ts`, `transport/handlers/folio-handlers.ts`) still calls
  them, and comment threads still carry `TurnAuthor` (`person`, `resolvedByPerson`,
  `CommentActor.person`). `principalDisplayName` names the owner from the host's user,
  not "Host owner". The comment surfaces read `[userKey(selfUserId)]` through
  `comment-viewer.ts` until stage 4.

**Left for later stages.**

- Stage 4: `TurnAuthor` (comments only), `principalDisplayName`, `turnAuthorFor`,
  `SelfIds`, `principalOwnerId` in sharing, publication and automations,
  `claimForRunner`'s sentinel, and the runner's user.
- The `org-member` principal's flat fields (see Decisions).
- The Lab's `presence`, `share-matrix`, `guest-revoke` and `cloud-workspace` scenarios
  were updated to the new shapes but not run.

**Verified.**

- New `tests/unit/actor.test.ts`: `actorFor` for the local owner (unlinked and linked),
  the remote owner, a member, a guest (anonymous, signed in, and a guest of the host's
  user), a runner and the host itself gives the right user, seat, credential user and
  Insights account; `attributionOf`; `SolusServer.handle()` sets `ctx.actor` once.
  `presence-manager.test.ts` pins `userColorIndex` to the indexes the deleted
  `presenceColorIndex` gave. `session-event-acted-by.test.ts` proves "is this me"
  compares one whole `UserId` (a `local` user is not the account with the same text).
  `presence-people.test.ts` and `share-rows.test.ts` prove the owner reads by the name
  the host gave them. New helper: `tests/unit/helpers/actors.ts`.
- The related suites (presence, session runtime and events, conversation, actor,
  seats, turn, share, attention, queue, mention, organization, people, plus host user,
  credentials, API mode, guests, chat folders, busy trees, comments): 639 pass,
  9 fail, 5 errors. None come from this stage: `rune_outside_svelte` (5 suites),
  `organization-vm-flow` beside other suites ("Not in API mode"),
  `respondToQuestion` returning a promise where the test expects a boolean, the
  `async_questions` query budget, and `working-tree-busy`'s missing `gitIdentities`
  stub. `session-runtime-rate-limit-park` passes alone (13/13) and can lose two
  timing tests beside other suites. `session-orchestrator` is outside the list and
  fails to resolve `node:sqlite` in most runs.
- `tsc` for server, contracts, client-core, workspace-ui and apps/client: no errors in
  the changed files (server errors went from 155 to 151). `svelte-check` in
  workspace-ui: no errors in the changed `.svelte` files that come from this stage.
  `oxlint` on the changed files: no new findings. `bun scripts/generate-solus-api.ts`
  regenerated `docs/api/openapi.json` (the example owner keys only).

### Stage 4 — `Attribution` in works, comments, tasks, automations, sharing (2026-09-29)

**Done.**

- `admission/actor.ts` (moved from `execution/actor.ts`; see Decisions) records every
  write: `attributionOf(ctx.actor)` for a person, `attributionOf(actor, { sessionId })`
  for an agent working for one. New: `ownerKeyOf(actor)`, the user key a record is owned
  under. `admission/workspace-credentials.ts` adds `requestAttribution(context)` for the
  Solus API: the acting agent and its person, else the person.
- **Works.** `Work.contentAuthor` and `WorkRevisionSummary.author` are `Attribution | null`
  (null: nobody recorded it; `WorkContentAuthor` and its `unknown` are gone). Folio
  handlers stamp `attributionOf(ctx.actor)`; `agentSaveWork` stamps an agent for the
  person; the outbox applier stamps the op's agent; an upstream pull stays `upstream`.
  The workspace API schema and `docs/api/openapi.json` carry the attribution;
  the runner's work-transfer outline accepts it.
- **Comments.** `PlanComment.author`, `resolvedBy` and `PlanCommentReply.author` are
  `Attribution`, absent only on a message the host has not stamped yet (the reader's
  optimistic copy). Deleted: `CommentAuthor`, `CommentAgentAuthor`, `person`,
  `authorAgent`, `resolvedByPerson`, `TurnAuthor`, `fromStoredComments`,
  `toStoredComments`, `turnAuthorOfUser`, `turnAuthorFor`, `userOfCommentPerson`,
  `SelfIds`. `CommentActor` is `{ by: Attribution; canModerate; now }`. Plan saves are
  stamped by the host (`stampComments` in `savePlanAnnotations`), so no client names
  itself; `recordPlanDecision` and `decidePlan` take the decider. `readStoredComments`
  reads the old shapes (Solus API rows, rows before `adoptHostUser`); `moveCommentUser`
  keeps U5.
- **Tasks.** `TaskEvent.actor`, `TaskLink.createdBy` and a local `TaskComment.author` are
  `Attribution`; an upstream comment names its author in `externalAuthor`. Deleted:
  `TaskActor`, `actorLabel`, `EventActor`, `TaskLinkInput.createdBy` (replaced by
  `automatic`: a link Solus found, recorded as `system` and replaceable by a later
  checkout). Every `Task` write takes `by`; handlers pass `attributionOf(ctx.actor)`,
  the upstream pull `{ kind: 'upstream', provider }`, PR auto-close and session moves
  `system`. Outbox ops carry `author`/`actor` as attributions (`TaskCommentOpPayload`,
  `TaskSetStatusOpPayload`, `TaskLinkOpPayload`).
- **Automations.** `Automation.createdBy` is `Attribution`; `AutomationCreator` is gone and
  `automationCreate` no longer takes a creator from the client. `pauseAutomationsOf`
  finds a person's automations by the user, the agent's `for`, or the agent's session owner.
- **Agent tools** name themselves with `toolAgentAttribution` (session, provider, and
  `for` = the host's user when the host's user owns the session). Browser evidence and
  task artifacts take the filer's attribution.
- **Sharing, publication, runners.** `principalOwnerId` and `principalDisplayName` are
  deleted: `claimOwner`, `shareWithOrganization`, grants, publication and the API budget
  key read `ownerKeyOf(actor)`. A runner principal always names its person
  (`ownerUserId` required; the runner routes admit only delegated tokens), so
  `claimForRunner` records that person and the sentinel is gone.
- `HOST_OWNER_USER_ID` is deleted from contracts. The legacy key lives only as local
  constants: the one-time moves (`host-user-rows.ts`, `stored-comments.ts`, the seat
  row), and `host-user.ts` (a guest link shared before stage 1, and the key where there
  is no host user).
- The `readWorkGoogleComments` / `refreshWorkGoogleComments` / `sendWorkGoogleComment`
  aliases in `data/works/work-comments.ts` are removed (the RPC names stay).
- Client: comment surfaces read a `CommentReader { selfUserId, isSingleReader }` and
  compare with `sameUser`; a plan rail is its one reader. `attributionName(by, self)`
  (`presence/lib/actor-name.ts`) names a doer: "you" only for the reader, "your agent" /
  "Alice's agent" for an agent working for someone. The task timeline and task comments
  use it, and draw a person's comment with `UserAvatar`. The demo backend has a
  `DEMO_USER` and names it in `connectionsGetServerInfo`.

**Decisions.**

- **No migration file.** Every attribution is JSON in a text column that already exists
  (`works.content_author`, `work_revisions.author`, `task_events.actor`,
  `task_comments.author`, `task_links.created_by`, the automation metadata, annotation
  JSON). Old values read at read time: `data/stored-attribution.ts`
  (`parseStoredAttribution`, `userOfStoredKey`, `hostAttribution`), `legacyTaskActor`
  (`'user'`/`'You'` → the host's user, a guess on a shared host; `'agent'` → the agent
  with its label or session; `'system'`/`'migration'` → system), `authorFromJson`
  (`person` → the user, `unknown` → null, an agent with no session → an empty session id),
  `creatorFromLegacy` (a creator with a bare member id is named "Organization member").
  sqlite `0023` and postgres `0012` stay free.
- **`actor.ts` moved to `admission/`.** Data may not import execution
  (`server-module-boundaries`), and the works and tasks API operations must compute an
  attribution from their principal. Admission is where U7 puts the actor.
- **`CommentActor` holds `by: Attribution`**, not `actor: Actor`: it is a contracts type the
  Lab and demo share, and contracts cannot name the server's `Actor`.
- **The agent attribution's `provider` is optional**: old task events and op labels never
  stored it, and it is not guessed.
- **Attribution columns follow a link on read**: a `local` user of this host reads as the
  linked account (`followHostUser`). Rows are not rewritten, and an unlink does not map
  back (comment threads and owner rows still move both ways, as in stage 1).
- **Who an agent tool works for** is the host's user only when the host's user owns the
  session; otherwise `for` is absent until P7 gives agent turns an actor.

**Left for later stages.**

- Stage 5: the activity table and the `task_events` copy (the read path already answers
  attributions). The task timeline keeps its own renderer until `ActivityRow`.
- Delivery: the outbox's `actor_user_id` for an agent's queued write is still the session
  record's owner — agent tools have no actor (P7). Insights was done in stage 3.
- No client drew a work revision's author or an automation's creator, so none was built.
- The task page's mention scope could now read the task comments' authors
  (`recentUserIds: []` in `TaskPage.svelte`).
- Wire change: an older client against this host, or an older host publishing a work to
  this Solus API (`verifySnapshot` parses attributions), fails to read authors.

**Verified.**

- New `tests/unit/attribution.test.ts` (9 tests): one owner's restore, comment, task link
  and comment, and automation all name the same user through the handlers; a client
  cannot name an automation's creator; `agentSaveWork` and an API agent turn name the
  session and `for`; an agent's automation pauses with its person; plan saves stamp only
  unstamped messages; old task actors, task comment authors, link makers, work and
  revision authors, automation creators and comment threads (host and Solus API) read.
  `task-page.test.ts` proves the timeline says "You" only for the reader (by user id) and
  "Alice's agent" / "Your agent". Updated: comment commands, thread people, comment text,
  diagram threads, comment tools, host user, work version/revisions/sync/events/write
  paths/Google comments, cloud sharing, task store/sync/lifecycle/links/record
  scope/artifact links, publication, dispatch parity, PR sync, runner intake, mirror
  sinks, organization VM records, API mode, seat and share managers, presence
  manager, renderer tasks store, and link/automation fixtures.
- 152 related suites run one file at a time: all pass except failures from other work in
  the tree — `automation-model-resolution` (duplicate `pr_state` column),
  `sidebar-task-order` (`$state`), `task-upstream` (`afterDatabaseCommit` export),
  `work-comment-send` and `session-continue-worktree` (`runed`), `working-tree-busy`
  (`gitIdentities` stub), `session-runtime-observability` (1: `respondToQuestion`
  returns a promise), and `session-orchestrator`, which fails to resolve `node:sqlite`
  in most runs (the run that loaded: 5 `respondToQuestion` failures).
  `renderer-tasks-store` (38/38) and `task-store` (46/46) pass when Bun loads them.
  Run together the suites share one database and fail where they pass alone.
- `tsc`: contracts 0, client-core 3 and workspace-ui 53 as before, server 150 (151
  before; one fixed); apps/client: no errors in the demo. `svelte-check` in workspace-ui:
  no errors in the changed `.svelte` files. `oxlint` on the changed files: no new findings.

### Stage 7 — One way to draw a user (2026-09-29)

**Done.**

- `workspace-ui/src/components/users/`: `UserAvatar.svelte` (a `User`, a size, and the
  presence stack's `ringed` and `composing` marks) and `UserChip.svelte` (avatar and name
  in the user's colour; `short` shows the first name inside cards and dividers, the full
  name elsewhere). Colour from `userColorIndex`, initials from `userInitials`.
- `users/lib/users.ts`: `firstName` (moved from `presence/lib/actor-name.ts`), `chipName`
  (the first-name/full-name rule) and `presenceTint` (moved from `presence-people.ts`).
- `users/lib/organization-people.ts`: `OrganizationPeople { organizationId, name,
  members: User[], teams }`, `memberUser`, `organizationPeople` and `memberByKey`.
  `sharesStore.directoryFor` converts the account plane's directory there, once; the
  mention picker, the mention access check, `PersonMention`, the work body's person
  chip and the share dialog read `members: User[]` and compare with `userKey`.
- Deleted: `presence/PresenceAvatar.svelte` (callers draw `UserAvatar`: the presence
  stack, session presence, the composing line, `GuestRail`, `MobileHereNow`) and
  `presence/PersonName.svelte` (callers draw `<UserChip short>`: answered questions, the
  "working for" line, the person notice). `PresencePerson` carries `user` in place of
  `initials`, `colorIndex` and `avatarUrl`.
- Kept as callers: `TurnAuthorLabel` (it decides "not the reader" with
  `otherPerson`, then draws `UserChip`) and `PersonMention` (it decides the standing,
  then draws `UserChip`, or the saved name as plain text for a person who left; the rule
  is `mentionUser` in `mentions/lib/mentions.ts`). `PersonStanding.member` carries the
  `User`.
- Share dialog: `PersonRow` carries `user` in place of `name` and `avatarUrl`;
  `personCandidates` answers `User[]`; both rows draw `UserAvatar` (the `face` snippet is
  gone). A person the directory no longer lists is a user named "Former member".
- Mention picker rows: `MenuItem.user` puts the person's `UserAvatar` in the glyph slot of
  `UnifiedAutocompleteMenu`.
- Comment threads: `messageUser` (was `messagePerson`) answers a `User`, adapted at the
  edge from the deprecated `TurnAuthor` by `userOfCommentPerson`; `CommentThreadCard`,
  the diagram `CommentsTab` and `ArtifactCommentLayer` draw `UserAvatar`. The artifact
  pin colour reads `userColorIndex` of the same user, so pin and face agree.

**Decisions.**

- The directory answers `OrganizationPeople`, not a bare `User[]`: the share dialog's
  scope choices need the teams and the organization's name, and the mention access check
  needs the teams. The member list itself is `User[]`, converted once in the store. The
  member's organization role is dropped; no client read it.
- Rows with a second line (the share dialog's email, the presence menus' "where") draw
  `UserAvatar` beside their own name column; `UserChip` is for a person named inline
  (dividers, labels, mentions). A chip has no second line.
- The mention picker keeps the reference menu's row grammar (title highlighting, meta);
  the person's avatar takes the glyph's place rather than a `UserChip` in the title.
- The work body's person chip (`editor/personRefExtension.ts`) is Tiptap HTML, not
  Svelte, so it cannot mount `UserChip`. It reads the same `PersonStanding` and keeps its
  token chip; the left rule is the same.
- `PresencePerson` keeps `userId` and `displayName` beside `user`: they key every stack
  and label, and removing them is not needed to draw through one component.
- Task assignees: organization (Local-provider) tasks have no assignee picker
  (`taskPageCapabilities`: `canEditAssignee` only for a provider that writes the
  assignee). The existing picker lists GitHub and Jira logins, which plan §2 keeps
  separate. No picker was built; the organization member list is ready for one.

**Left for later stages.**

- Stage 4: `userOfCommentPerson` and `SelfIds` go when comments carry an `Attribution`.
- No works-area file (solus-83) needed a change.

**Verified.**

- New `tests/unit/users.test.ts`: the chip-name rule, the palette, the directory
  member as an account `User`, and `memberByKey`. `shares-store-publish.test.ts`:
  `directoryFor` answers the members as `User`s and reads the account plane once per host.
  `mentions.test.ts`: `mentionUser` draws a member by their current name, the saved name
  while the directory is unknown, and nothing for a person who left. `share-rows`,
  `presence-people`, `picker-presence` and `comment-thread-people` updated to the new
  shapes.
- The presence, mention, share, people, user, task and comment-thread suites, each run
  alone: all pass except `renderer-tasks-store` (Bun cannot parse `@lucide/svelte`'s
  `Icon.svelte`), `sidebar-task-order` (`$state` outside Svelte), `task-store`
  (`node:sqlite`) and `task-upstream` (`afterDatabaseCommit` export). None of these
  import a file this stage changed.
- `tsc` for workspace-ui and apps/client: no errors in the changed files. `svelte-check`
  in workspace-ui: no new errors in the changed `.svelte` files (the ones reported there
  are on lines this stage did not touch). `svelte-check` in apps/client cannot read its
  vite config for any file. `oxlint` on the changed files: no findings.

### Stage 5 — Activity (2026-09-29)

**Done.**

- Contract: `packages/contracts/src/activity.ts` holds `ActivitySubject`, `ActivityKind`
  (every kind of §5, stage 6's included), `Activity`, `TaskEventTarget` and
  `activityKindSchema`. `NormalizedEvent` has `{ type: 'activity'; activity }`;
  `Message.activity` and `SessionLoadMessage.activity` carry one. `TaskDetails.events:
  TaskEvent[]` is `TaskDetails.activity: Activity[]`; `TaskEvent` is deleted
  (`TaskEventKind` stays: it is `task_changed.change`).
- Table `activity` (`data/activity/schema.ts`, `defineTable`, in `PORTED_TABLES` and both
  drizzle entries): `id`, `organization_id`, `subject_kind`, `subject_id`, `at`, `turn_id`,
  `kind`, `by_kind`, `by_user_key`, `by`, `data`. `data` is the whole `ActivityKind`;
  `kind` sits beside it for queries.
- `data/activity/activity.ts`: `newActivity`, `appendActivity(organizationId, activity, db?)`
  (a task passes its transaction), `activityFor(scope, subject, { limit })` and
  `activityFor(scope, { userId, since })`, `deleteActivityFor`, and
  `mergeSessionActivity(messages, activity)`: one pass, each activity before the first
  message after it.
- `SessionRuntime.recordActivity(subject, actor, kind)` stamps the open turn's id
  (captured before the status settles the turn), appends in the session's organization,
  then `_emit`s `{ type: 'activity', activity }` to every watcher (so the turn log replays
  it to a joiner). `sessionActivitySubject(id)` resolves either id space to the Solus id.
- Moved onto it: stop (`stopSession`), permission decided (`respondToPermission`, both
  providers), question answered (both paths of `respondToQuestion`), rate-limit decided
  (`resolveRateLimit`, `wait` included), queued prompt removed / edited (only when the
  person is not the prompt's author, as before), rename (`setSessionTitle`, manual), share
  with the organization (the share listener in `boot-server.ts`; `ShareChange` carries the
  `Actor` host-side, never on the wire), and seat needed (`submitPrompt`).
- Deleted: `by` on `status_change`, `prompt_dequeued`, `prompt_queue_updated`,
  `rate_limit_resolved`, `permission_resolved`, `question_answered`; the `seat_needed`
  event; `SessionTitleChangedEvent.by`; `ShareChangedEvent.organizationSharedBy`; the
  private `by` parameters of `_setStatus`/`_applyStatus`/`_releaseRateLimitQueue`/
  `_broadcastRateLimitResolved`; `permissionAnswers` keeps the decision only.
- History read (`history-handlers.ts`): `loadSession` and `loadSessionPage` merge the
  session's activity. A page holds the activity from its first message (from the start
  when it is the oldest) up to where the newer page began; the handler wraps the history
  cursor as `{ before, at }` so each activity lands in exactly one page.
- Client: the reducer's `activity` case appends in place, once per id (a replay may repeat
  one), and is accepted while the session reads as interrupted. `materializeSessionTranscript`
  keeps the merged rows. `buildTurns` absorbs a `stopped` activity into the turn's end
  (`TurnEnd.by`), and makes it the ending on a client with no provider notice. One
  `components/activity/ActivityRow.svelte` (with `lib/activity-line.ts`) draws every
  activity: a person other than the reader as `UserChip`, anyone else in words via
  `attributionName` ("You", "Your agent"). The transcript wraps it in `TranscriptDivider`;
  the task timeline in its disc row.
- Deleted client code: `recordStopper`, `pushPersonNotice` (`person-notices.ts`), the rename
  notice in `session-title-change.ts`, `applyOrganizationShare` and its `share.changed`
  subscription, `Message.actedBy`, `Message.personNotice`, the `personNotice`
  branch of `TranscriptItem.svelte`, the plan card's `decidedBy`, the answered question's
  answerer chip and `answeredByLabel`, and the task timeline's `eventLine` and its label
  helpers (moved into `activity-line.ts`).
- Tasks: `data/tasks/task-events.ts` is deleted. `data/tasks/task-activity.ts` holds what
  is task-specific (`taskChanged`, `diffTaskActivity`, `legacyTaskActor`,
  `TASK_ACTIVITY_LIMIT`); `task-store.ts`, `task-lifecycle.ts`, `task-sessions.ts`,
  `task.ts` and `task-links.ts` call `appendActivity` / `activityFor` directly.
  `Task.events()` is gone; `Task.delete()` deletes the task's activity in its transaction
  (the foreign key of `task_events` did this).
- Migrations: sqlite `0023_activity.sql`, postgres `0012_activity.sql` (numbers as asked),
  with journal and snapshot entries generated by `bun run db:generate` (the snapshot then
  had `task_events` removed by hand; a second `db:generate` reports no changes). Each
  creates `activity`, copies `task_events` as `task_changed` rows, and drops `task_events`.

**Decisions.**

- **The copy is SQL.** A JSON attribution is kept as it is; `'agent'`, `'automation'`,
  `'system'` and `'migration'` become attributions in SQL; `'user'` needs the host's user,
  whom only the host knows, so the row keeps the label and is read as the host's user
  (`activityFromRow`, the same read-time rule stage 4 chose). The SQLite migration logs
  `task_events_moved_to_activity` with the count read that way (the plan's "say so in the
  log line"). `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` keep the copy idempotent.
  drizzle-kit asks whether `activity` renames `task_events` and cannot ask without a TTY,
  so the migration was generated with `task_events` still declared and its drop added by
  hand.
- **Session subject id is the Solus session id** (stable across provider handoffs, and
  the id sharing uses). History reads and the rename handler resolve a provider thread id
  to it.
- **Who sees which row.** The host records every fact; the client draws a row for a
  person other than the reader (as `pushPersonNotice` did, so a session where the reader
  acts alone stays quiet, now also after a reload). A stop is always kept, because the
  turn's end names the stopper, "you" included (as before). `showsActivity` is the rule.
- **The plan card and the answered-question card no longer name the decider**: a
  `permission_decided` ("Bob approved the plan") or `question_answered` row beside them does,
  and survives a reload. Looking the activity up from each card would walk the transcript.
- **`activityFor(scope, { userId, since })` answers what that user did** (`by_user_key`).
  The notifications hub's "mentioned me" needs the mentioned user's key; stage 6/8 adds
  it with the `mentioned` kind (a column, or a read of `data`).
- **Name clash.** `components/conversation/ActivityRow.svelte` (the §16 run row) already
  existed; the plan's row is `components/activity/ActivityRow.svelte`. One of them should
  be renamed (not done here).
- `recordActivity` takes a session subject only (`ActivitySubject & { kind: 'session' }`):
  tasks and works append with their change and publish through their own invalidation.
- A cleared custom title records `renamed` with an empty title (the old notice fired for
  a clear too).

**Left for later stages.**

- Stage 6: fork, worktree move, agent switch and plan accept still write their client
  dividers and `Message` fields; the `forked`/`moved_to_worktree`/`agent_switched`/
  `plan_decided`/`mentioned` kinds exist in the contract and `ActivityRow` but nothing
  records them.
- Stage 8: activity is not mirrored to the Solus API, and the Solus API's
  history read merges only its own `activity` rows.
- Works record no activity yet (no existing work fact moved in this stage).
- The Postgres migration was not run (no Postgres here); only its SQLite twin was.
- The Lab scenarios were not run.

**Verified.**

- New `tests/unit/activity.test.ts` (7): subject and user reads, scope and cap; the merge
  places activity by time; a recorded activity is broadcast to every watcher and comes back
  from `loadSession` inside its turn after a "reload"; history pages hold each activity once;
  on a fixture database from before 0023 with old `task_events` rows of every vintage the
  migration copies them as `task_changed` rows with attributions, drops `task_events`, and
  the task timeline reads the same rows; running the copy twice adds nothing; a new task
  change is a `task_changed` activity and goes with its task.
- `session-event-acted-by.test.ts` rewritten for activity: appended in place and once, the
  reader's own notices not drawn, none for an unknown reader, a stop kept while interrupted,
  state events write nothing, the stop named at the turn's end (with or without the
  provider notice), one sentence per moved fact and "you" only for the reader. Updated:
  `session-runtime-queue-author`, `conversation-turns`, `conversation-people-labels`,
  `task-page`, `task-store`, `task-lifecycle`, `task-artifact-link`, `attribution`.
- The related suites (`ls tests/unit | grep -iE "activity|task|session-event|conversation|people|transcript|history|session-runtime|share|seat|rename|title"`,
  113 files) run one file at a time: 101 pass whole. The others fail alone for reasons
  outside this stage: `session-runtime-seats` and `session-runtime-agent-dispatch`
  (duplicate `pr_state` column), `review-agent-session-runtime` and
  `cross-provider-subagent-session-runtime` (a user system prompt the tests do not
  expect), `session-runtime-observability` (1: a worktree test on a repository with no
  commit), `startup-transcript` (the test evaluates source that names
  `serverConnections`), `sidebar-task-order` (`$state`), `renderer-tasks-store`
  (`@lucide/svelte`), `task-upstream`, and `setup-readiness-seats`,
  `voice-transcription-http` and `task-store`, where Bun fails to resolve
  `node:sqlite` before the mock (`task-store` passed 46/46 once after this stage's
  changes, then not again). `seat-connect`, `session-runtime-model-routing`,
  `session-runtime-worktree-rename` and `worktree-branch-rename` fail only beside
  the others and pass alone.
- `server-module-boundaries`: 3 pass. `tsc`: contracts 0; server 150, the same errors as
  before; workspace-ui 51 (53 before; none in changed files); client-core 3 and
  apps/client as before. `svelte-check` in workspace-ui: no errors in the changed
  `.svelte` files from this stage. `oxlint` on the changed files: no new findings (the
  complexity of `apply`, `buildTurns`, `materializeSessionTranscript` and the
  `session-runtime.ts` methods was already over the limit).

### Stage 6 — Host actions that replace client steps (2026-09-29)

**Done.**

- `acceptPlan(ctx, { planId, provider?, startNewSession })` (contract in `rpc.ts`,
  `rpc-planes.ts`, `host-api.ts`, `types.ts` `AcceptPlanRequest`/`AcceptPlanResult`;
  access `editor(ctxAt(0))`; handler in `session-handlers.ts`; demo backend stub).
  `SessionRuntime.acceptPlan` stops a busy planning run as the host (so no `stopped`
  row), hands the session to `provider` or resets it, and records `plan_decided`
  accepted, with `newSessionId` (the Solus session id) when a fresh agent session
  starts. Desktop and web reach it through the generic RPC transport (the preload has
  no per-method bridge). `approvePlanWithModel` makes that one call; a host handoff
  comes back as `result.handoff` and the client adopts it with
  `SessionConfigController.adoptHandoff`, split out of `switchActiveAgent`.
- The orchestration decision (`decidePlan`) takes the deciding person's `Actor` (not
  an attribution) and records `plan_decided` (accepted or rejected) on the target
  through `OrchestratedRuntime.recordActivity`. The plan note keeps
  `attributionOf(actor)` (the `'you'` stamp was already gone since stage 4). A
  rejection in the plan's own session stays its `permission_decided` row.
- Fork: recorded in `_launchRun` when a forked dispatch has no active lineage thread
  (a new session branching from another), as `forked` with the source thread,
  `sourceTitle` (index) and `midRun`. A move into a worktree forks the session's own
  active thread and is not a fork.
- Move into a worktree: `continueInWorktree` records `moved_to_worktree` (path and
  the branch at the time) with the caller's actor.
- Agent switch: `switchSessionProvider(…, actor)` records `agent_switched`
  (`provider`, `fromProvider`, `fromModel`), at the new lineage member's `startedAt`;
  switching back before the target starts records a switch back. The lineage
  rebuild (`execution/sessions/thread-activity.ts`, `lineageSwitchDivider`) now
  yields an `agent_switched` activity with `by: system` and id `handoff:<id>:<pos>`;
  `mergeSessionActivity` drops a rebuilt row whose handoff has a recorded one (same
  `at` and provider) and gives the recorded row the lineage's models. Mirrored rows
  that still hold `agentChanged*` are read as the same activity
  (`transcript-reads.ts`).
- Mentions: `data/activity/mentions.ts` records `mentioned` for each person a work
  body (`writeBody`, and a new work's first body) or a work comment message
  (`applyWorkComment`, per thread and reply id) first saves, only on an
  organization record. `activityFor(scope, { targetUserId, since })` answers
  "mentions of this user" (and shares with them) from the new indexed
  `target_user_key` column.
- Client: `Message.forkSourceSessionId`, `forkSourceTitle`, `forkSourceRunning`,
  `worktreeMovedTo`, `worktreeMovedToPath`, `agentChangedTo`, `agentChangedFrom*`,
  `agentChangedTo*`, `newSessionForPlanId` and `SessionLoadMessage.agentChanged*`
  are deleted, with their writers (`session-opening.ts` fork and worktree dividers,
  `session-config.svelte.ts` handoff divider and `nameModelOnPendingDivider`,
  `session-plan-operations.ts`, `session-transcript.ts` copies). The four
  `TranscriptItem.svelte` branches and its activity branch are one
  `conversation/ActivityDivider.svelte`, which frames `ActivityRow` per kind with the
  actions it had: the fork's link to its source, the worktree's live branch name,
  the plan divider's link (new: it opens the plan), the open switch's model from the
  picker. `ActivityRow` draws an agent switch as `from → to` models.
  `dividesThread` (in `activity-line.ts`) names the four divider kinds: `turns.ts`
  opens a turn at them and `showsActivity` shows them to the reader who made them
  too. A fork's activity that arrives after its first prompt's bubble goes before
  it, where a reload puts it. `replaceHydratedMessages` keeps live activity newer
  than the loaded history (it kept only client dividers before).
- Migrations: sqlite `0024_activity-target-user.sql`, postgres
  `0013_activity-target-user.sql` (`bun run db:generate`): the column and the index
  `activity_for_user (target_user_key, at)`.

**Decisions.**

- **Accept carries the provider switch.** The switch has to happen after the stop
  and before the decision is recorded, or a refused switch would leave an
  "accepted" row on a plan that went back to pending. So the host does stop,
  switch or reset, then record; the client adopts the switch's result.
- **`newSessionId` is the Solus session id.** A reset keeps the session and starts
  a new provider thread only on the next prompt, so there is no other id to name.
  The field says "a fresh agent session implements this plan".
- **The fork is recorded at dispatch**, not when the fork tab opens: before its
  first prompt the fork exists only on the client. The unprompted fork tab shows
  no divider (its title still reads "Fork: …").
- **`agent_switched` has `fromProvider`/`fromModel`** (added to the contract) so the
  divider keeps its `from → to` models; `model` is filled from the lineage at read
  time, since the host does not know the target model when the switch is made.
- **Deduplication is by the lineage member's start time**, which the switch records
  as the activity's `at`; no id links the two stores.
- **Mentions compare with the previous saved copy per message**, and are attributed
  to whoever saved the change. Agent comment tools (`saveWorkAnnotations`) record
  none: an agent never makes a new mention (`restoreMentions`).
- **The handoff error toast moved to `SessionConfigController.handoffFailed`** so plan
  operations do not load `svelte-sonner` (their tests run without it).

**Left for later stages.**

- Stage 8: activity (mentions included) is not mirrored to the Solus API yet.
- Plan comments (`plans/annotations.ts`) and task comments record no mentions; only
  works and work comments do.
- A fork tab saved before this stage with an unprompted copy (`pendingFork`) still
  holds the old divider message, which now reads as an empty notice.
- `approvePlanWithModel` (48) and `switchSessionProvider` (40) stay over the lint
  complexity limit, as before.
- The Postgres migration was not run (no Postgres here).

**Verified.**

- New `tests/unit/activity-host-actions.test.ts` (8): accept records one
  `plan_decided` by the person with `newSessionId`, stops the run, writes no
  `stopped`, and survives a reload; keeping the session records no `newSessionId`;
  a fork records one `forked` on the fork by its prompter and a worktree re-home
  records none; an agent switch records one row by the switcher and shows once
  after a reload; a switch from before the record shows once, rebuilt; the
  worktree handler records `moved_to_worktree` with the caller; a work body mention
  is recorded once, not again on an edit that keeps it, not on a Local work, and
  `activityFor({ targetUserId })` returns it; a comment mention is recorded once per
  message.
- Updated: `plan-approval-session` (one `acceptPlan` call, no client divider, a failed
  handoff leaves the plan pending), `session-orchestrator` (the decision is one
  `plan_decided` by the decider), `session-event-acted-by` (dividers shown to their
  maker, fork placement, divider wording), `session-bootstrap-agent-change`,
  `session-config-default-model`, `session-transcript-rehydration`,
  `conversation-turns`, `transcript-turns`, `worktree-divider`, `session-fork`,
  `session-continue-worktree`.
- Related suites (the requested filter plus work, comment, rpc, access-policy,
  history, 130 files; and session-event, conversation, people, task, share, title,
  reducer, bootstrap, seat, 42 files) run one file at a time with
  `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (with the cache, Bun often fails to resolve
  `node:sqlite` before the mock). Failing alone, for reasons outside this stage:
  `session-runtime-seats`, `session-runtime-agent-dispatch`,
  `review-agent-session-runtime`, `cross-provider-subagent-session-runtime`,
  `session-runtime-observability` (1), `startup-transcript`, `voice-transcription-http`,
  `setup-readiness-seats` (as in stage 5); `session-orchestrator` (5: tests expect
  `respondToQuestion` to return a boolean; it is async); `session-config-default-model`
  (3: the permission default reads `supervised`, the tests expect `ask`);
  `session-open-rpc` (its fixture has no `sessions.byId`); `working-tree-busy`
  (`gitIdentities` missing from its deps); `session-fork`, `session-continue-worktree`
  and `work-comment-send` (`$state` or `svelte-sonner`'s `runed` do not load in Bun).
- `server-module-boundaries`: 3 pass. `tsc`: contracts 0; server 150 (as before);
  workspace-ui 51 (as before, none in changed files); client-core and apps/client
  none in changed files. `svelte-check` (workspace-ui): no errors in
  `ActivityRow.svelte`, `ActivityDivider.svelte`, `TranscriptItem.svelte`,
  `ConversationView.svelte`. `oxlint` on the changed files: no new findings beyond
  the complexity already over the limit.

### Stage 8 — Activity in the transcript mirror and the record API (2026-09-29)

**Done.**

- **Sessions travel with their transcript.** `TranscriptMirror.sync` also reads the
  session's activity (`activityFor(ANY_ORGANIZATION, …)`: a session published from
  Local brings the rows it had) and appends each row not yet sent under that
  transcript id to the mirror log as the new domain `activity` (`MIRROR_DOMAINS`,
  `mirrorDomainWireSchema`, `activityMirrorPayloadSchema = { activity }`), in the same
  transaction as the transcript rows. The row's subject is rewritten to the id the
  transcript is mirrored under (the provider thread id the API keys the session by);
  the new dep `activitySubjectId` (boot: `sessionRuntime.sessionActivitySubject`) maps
  back to the Solus id the host records under. The host-only table
  `activity_mirror_rows (session_id, activity_id)` (hand-written host migration slot in
  `db/migrations.ts`, like `transcript_mirror_rows`) remembers what was sent. The
  trigger is the one the transcript already has: every broadcast runtime event,
  `activity` included, touches the mirror. A publication's `flushNow` returns the
  highest sequence, activity included, so it waits for both.
- **Only published records send.** The destination is `transcriptDestination`: a
  `published` record of a real organization, or one whose publication is on its way.
  A Local session and an organization-attributed but unpublished one send nothing.
- **Tasks and works need no mirror.** An organization's task or work lives on its Solus
  API (a publication moves it there and deletes the host copy); agent tools write it
  through the remote record API (`remoteWorkspaceOperations`) or the runner outbox
  (`destination: 'cloud'`). The API's own data code records the activity when it
  applies the write (`task_changed` from the task store, `mentioned` from
  `recordNewMentions`), in the API's `activity` table. The outbox cursor
  (`runner_cursors`) and the record API's version and idempotency checks keep a
  redelivery from applying anything twice.
- **Intake.** `applyMirrorItem` stores an `activity` item with
  `storeMirroredActivity` (`data/activity/activity.ts`): the runner's organization,
  `ON CONFLICT (id) DO UPDATE SET subject_id` only within the same organization and
  subject kind, so a redelivery writes nothing new. `applyRunnerMirror` announces a
  session whose activity arrived (`session.transcriptChanged`), as it does for rows.
  `appendActivity` and `storeMirroredActivity` share one private `insertActivity`.
- **The Solus API's session history merges activity.** `service-handlers.ts`
  `loadSession` and `loadSessionPage` merge the session's activity from the API's own
  table as the host does. The window and page rules moved out of `history-handlers.ts`
  into `data/activity/activity.ts` (`mergeWindowActivity`, `mergePageActivity`,
  `readActivityPageCursor`), and both readers call them, so the two cannot drift.
- **Record API.** Four operations in `contracts/src/solus-api/operations.ts`, the
  `WorkspaceOperations` interface, `data/workspace/service.ts`, the HTTP router and
  `remoteWorkspaceOperations`:
  `GET /v1/tasks/{taskId}/activity` (`listTaskActivity`, `tasks:read`),
  `GET /v1/works/{workId}/activity` (`listWorkActivity`, `works:read`),
  `GET /v1/sessions/{sessionId}/activity` (`listSessionActivity`, `sessions:read`), and
  `GET /v1/me/activity` (`listMyActivity`: activity whose `target_user_key` is the
  caller, `since` and `limit`). `data/activity/api-operations.ts`
  (`ActivityApiOperations`) checks a record read with the record's own scope and share
  check (`requireScope` + `requireResource(…, 'viewer')`, 404 otherwise). "Activity naming
  me" answers only the caller's key, and drops each row whose record the caller may not
  open or whose kind the credential may not read. The response is
  `workspaceActivityListSchema = { items: Activity[] }` (newest `limit`, oldest first,
  no cursor). The OpenAPI generator writes it once as `components.schemas.ActivityList`
  and the four operations reference it (inline, each copy was about 5,700 lines).
  `docs/api/openapi.json` regenerated (`bun run api:generate`; `api:check` passes);
  `docs/api/routes.md` lists the routes.

**Decisions.**

- **A mirror domain, not a new stream.** Session activity rides the transcript mirror:
  same destination rule, same trigger, same delivery and cursor, and a publication
  waits for it without new code.
- **A session's activity follows its newest transcript copy.** A provider handoff
  changes the id the transcript is mirrored under; the host sends every row again under
  the new id, and the API moves the row (same id) to it. The older copy's history
  then shows no activity. The copy a reader opens is the newest.
- **No task or work history is carried at publication.** A Local task's
  `task_changed` rows and a Local work's rows are Local records' activity and stay (and
  are deleted with the host copy). The API records `created` when it applies the
  publication's `create` op. Carrying the rows would double `created` and would need the
  host's `local` user keys on the API.
- **No new drizzle migration.** The API's `activity` table (0023/0024; 0012/0013) holds
  mirrored rows as they are. The only new table is host-only bookkeeping, in the
  hand-written host migrations.
- **`listMyActivity` has no single scope.** A row is answered when the credential may
  read its record kind and the caller may open its record.

**Left for later.**

- An API older than this stage refuses a mirror batch that holds an `activity` item
  (the domain enum), so the runner's mirror stream stalls against it until the API is
  updated. Deploy the API first.
- The API's paged history cursor is now the `{ before, at }` wrapper (as on a host). A
  client holding a bare cursor from before must reload the page.
- Plan comments and task comments still record no mentions (stage 6 leftover).
- The notifications hub client (D15) is not built; `listMyActivity` is its read.
- The Postgres engine was not exercised (no Postgres here).

**Verified.**

- New `tests/unit/activity-api.test.ts` (5): a mirrored session activity is stored
  once, and a redelivery and a re-queued copy add nothing; the API's session history
  places each activity where a host does, once per history, once across pages, and
  only from a cut window's first message on; the record API answers a private
  session's activity to its owner and 404 to a teammate; a task change applied from a
  runner's outbox is recorded once, and a redelivered batch adds nothing; a work's
  activity is answered to its readers only, and "activity naming me" answers only the
  caller's own mentions on records they may open (not a private work, not someone
  else's, not before `since`, not without `works:read`).
- `tests/unit/transcript-mirror.test.ts`: a published session's activity (recorded
  as Local and in the organization) is queued once under the mirrored id; nothing new
  sends nothing; a new activity is sent alone; a Local and an attributed session send
  none.
- Related suites (`ls tests/unit | grep -iE "activity|mirror|runner|intake|delivery|outbox|solus-api|organization-vm|api|history|publication"`,
  43 files) run one file at a time with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`: all pass.
  `server-module-boundaries`: 3 pass (no new crossing). `tsc`: contracts 0; server 150,
  as before, none in changed files. `oxlint` on the changed files: no new findings (the
  `bootServer` complexity and `hostOrganizationsDeps` findings were there before).

