# 031 The host owns its data

Status: BUILT (2026-11-03), in the working trees of `solus` and `solus-cloud`, not
committed. Built: D1, D2, D4, D6, D7 (D3 needed no code), the mobile Shared with you rule, and the documents.
D2 needed no list change: with D1 and a fresh database every row the owner writes
has the one key, and the list's person test lists exactly the owner's sessions plus
the ones they opened (Q1). Each database keeps one migration file: `solus.db`'s
baseline is regenerated (`bun run db:generate`); the cloud's `host_list` table is
folded into `drizzle/0000_baseline.sql`. Not done: the one `kind` vocabulary of D7
(`HostCategory`, `MachineKind`, and `cloud` in `HostKind` still exist, and
`host.category` stays in `solus-cloud`), because it changes the organization
policy `allowPersonalHosts` and every client's directory row; it is its own change.
`solus-cloud`'s `@solus/contracts` link must point at a `solus` tree with
`contracts/src/host-list.ts` before its `check` passes; vitest already resolves it.

## 1. Rules (user decision, 2026-11-03)

1. **Every record in a host's local SQLite database belongs to the host owner.**
2. **A host that the owner pairs belongs to the owner too.** Its data is theirs,
   in the same way as the data of the machine they sit at.
3. **Only data read from the cloud needs an organization and user filter.** The
   cloud is the Solus API: the organization workspace service and its Postgres
   (`isApiMode()`).

These rules are true when the owner is signed in and when the owner is signed out.

The database starts fresh (user decision, 2026-11-03; plan 029 decision 1): there
are no users yet, so no step migrates, backfills, or reads an old key.

## 2. Problem

A host now decides ownership from a person key on each row, and the owner's key
changes when they sign in or sign out:

- `hostUserKey()` (`host/host-user.ts:47`) is `local:<id>` while signed out, and
  the account id while signed in.
- Sign-in rewrites the owner's rows to the account key. Sign-out rewrites only
  the Local organization's rows back (`host/host-user-rows.ts:225`, `inScope`
  at :70). Organization rows keep the account key.
- Every read compares a row with the one current key (`ownerKeyOf`,
  `admission/actor.ts:62`).

Seen on 2026-11-03, signed out: four of the owner's organization sessions were
in "Shared with you". `standingOf` gave the owner `editor`, not `owner`, on rows
with the account key, and the client puts any role other than `owner` in Shared
with you. The same mismatch hides or mislabels records in 15 places (§5): the
session list, archive, snooze and settle state, notifications, saved Insights
queries, turn flags, webhooks, automations, and integrations.

When the key changes, a host can also admit its own owner as an `org-member`
of a personal host (`unattendedActorFor`, `actor.ts:124-141`). This happens for
automations, webhooks, and pull request watches whose stored creator is the
owner's other key.

## 3. Decisions

**D1. The host owner has one key on the host, and it never changes.** The key is
`local:<localId>`, minted once (plan 012 U4). Sign-in and sign-out do not rewrite
rows. `followHostAccount` changes host settings only. The row moves in
`host-user-rows.ts` (`moveUserRows`, `rewriteComments`, `adoptHostUser`) are
deleted. Plan 029 decision 1 (no compatibility) lets us delete them with no
migration. `ownerKeyOf` gives this key for every `owner` principal, through every
door.

**D2. An owner's read on a host has no person filter.** For the owner,
`standingOf` gives `owner` on every record in scope (built). `visibleTo` gives
every record in scope. The session list (`sessionListedClause`, `listCandidates`)
does not compare `created_by`. The owner's personal state (archive, snooze,
settle, viewed, task snoozes) is keyed by the D1 key. One key means one row per
record, so reads do not need to look at more than one key.

**D3. Which hosts are read whole follows from the host list.** Signed out, every
host a client reaches comes from the person's own list (D7) and is dialed with its
pairing, which is `owner`: the person reads all of it. Signed in, the account's
hosts route names each host's kind. A personal host the person owns is dialed with
the account's token, which the account plane mints as `access: 'owner'` for the
host's owner whatever organization the client names (`solus-cloud`
`sign-in-clients.ts`), and the host admits it as `owner` (`doors.ts`): read all. A
managed host, or a host another person shared, is reached as a member, with the
organization's filters (rule 3). No code was needed: a host-side check of the
linked owner was built and removed again. Plan 009's Local-only rule for a pairing
on an attached machine stays: under D7 such a machine is `managed`.

**D4. The cloud boundary maps the key.** A row that leaves the host for the Solus
API (mirror, outbox, runner delivery) names the linked account in place of the
D1 key. This happens in one function at delivery (`sync/delivery-queue.ts:deliveryActorOf`).
Records read from the Solus API keep their organization and user filters (rule 3),
and Shared with you comes from those reads only. While the owner is signed out,
nothing is mirrored, as now.

**D5. People other than the owner keep their filters on a host.** Rule 1 is about
the owner's reads. Guests (link binding), organization members admitted to a
personal machine, and runners keep every check listed in §5.C.
`unattendedActorFor` keeps making real members. Only its test for "this is the
host owner" changes to the D1 key.

**D6. A session that the indexer finds starts as settled.** The indexer reads
provider transcripts on disk (`~/.claude/projects`, `~/.codex/sessions`) and
writes a record for each. A transcript that this database never ran is history,
not open work: its record starts with `settled_at` set to its last activity.
Opening or prompting it makes it active, as for any completed session. Seen on
2026-11-02: after the database wipe, about 830 indexed sessions from the last 30
days showed as open, because their settled and archived marks were in the wiped
database. The maintainer chose this rule (2026-11-03) over listing only the
sessions Solus ran or the owner opened: a transcript from the terminal stays in
the list, and a fresh database does not open 30 days of history.

**D7. One hosts list, read from one source.** (Maintainer, 2026-11-03.)

- **Signed out: the local database.** A `hosts` table in the host's SQLite
  database holds every host the person connected to: by pairing, SSH, an
  introduction, or a forward. Each row has its id, label, routes, identity key,
  OS, `kind`, and when it was last connected. A typed RPC route lists, adds,
  renames, and removes rows, and an event topic tells clients when the list
  changes. A phone has no host of its own; signed out, it keeps the same list on
  the device.
- **Signed in: the cloud.** The list lives in the account and syncs as the
  personal settings do (`client-core/src/document-sync.ts`). At sign-in the
  local rows go up into the account; after that the client reads the account's
  hosts route, which also lists the account's registered machines and the
  organization's managed machines. The local table is not read while signed in.
- **Access is per client and user, not per host.** The list holds what a host
  is and how it is reached, never a credential. Each client keeps its own token
  for each host it paired (its secure store), and signed in it reaches a listed
  host with its own grant. Revoking one client's pairing ends that client's
  access only.
- **`kind` is one fact on every host:** `personal` or `managed`. A host is
  `managed` when the organization set it up through the control plane: a machine
  Solus provisioned for it, or a standalone server connected to the organization
  in the organization's setup. Every other host is `personal`, including a
  standalone server that a person runs and pairs (maintainer, 2026-11-03). A
  `managed` host is reached through the Solus API (rule 3). The host stores its
  own `kind` and reports it in `serverInfo`; the row and the directory copy it.
  It changes only when the organization setup connects or removes the host.
  A desktop host that its owner shares with the organization stays `personal`:
  the owner reads everything on it, and members get only their grants
  (maintainer, 2026-11-03). `HostCategory`, `MachineKind`
  and the `cloud` value of `HostKind` go. In `solus-cloud`, `host.category` goes
  and `host.owner_user_id` is null for a managed host.
- **Plain requests, no copy.** A client reads the list from its source and shows
  the answer beside the hosts it keeps itself (`server-registry.ts`: its own
  pairings and their tokens). Pairing a host writes it to the source; forgetting
  one removes it. Nothing is copied back into the registry, so nothing is
  reconciled (`client-core/src/host-list-source.ts`; the phone holds the answer in
  memory, `HostRegistry.setListedHosts`). A host another device paired shows
  without a token until this client pairs it.
- **One primitive for account documents.** `contracts/src/account-documents.ts` is
  a table with one row per document (its route and schemas), and
  `client-core/src/account-documents.ts` is one call that decodes any row. Desktop
  has one IPC channel (`solus:account-document`), checked against the table; web
  and mobile give only how they send. The host list is its first row; settings and
  the agent profile move to it in a later change.
- The host's own `introduced-hosts.bin` and `forwarded-hosts.bin` are host-to-host
  credentials, not the person's list, and stay as they are.
- **`kind` is one fact on every host:** `personal` or `managed`. A host is
  `managed` when the organization set it up through the control plane: a machine
  Solus provisioned for it, or a standalone server connected to the organization
  in the organization's setup. Every other host is `personal`, including a
  standalone server that a person runs and pairs (maintainer, 2026-11-03). A
  `managed` host is reached through the Solus API (rule 3). The host stores its
  own `kind` and reports it in `serverInfo`; the row and the directory copy it.
  It changes only when the organization setup connects or removes the host.
  A desktop host that its owner shares with the organization stays `personal`:
  the owner reads everything on it, and members get only their grants
  (maintainer, 2026-11-03). `HostCategory`, `MachineKind`
  and the `cloud` value of `HostKind` go. In `solus-cloud`, `host.category` goes
  and `host.owner_user_id` is null for a managed host.
- **The client's registry is a cache of the list.** `server-registry.ts` keeps
  its saved hosts and this client's own tokens; `HostListSync`
  (`client-core/src/host-list-sync.ts`) folds the source into it and writes a
  host this client pairs or forgets to the source. The source is the truth: a
  host the client agreed on before and the source no longer has was removed on
  another device and leaves; a host the source never had is new here and goes up.
  The host's own `introduced-hosts.bin` and `forwarded-hosts.bin` are host-to-host
  credentials, not the person's list, and stay as they are.

## 3a. Audit fixes (2026-11-03)

A read audit of server and clients found these gaps; each is fixed in the working tree
with a test.

1. **A personal host's records show whole.** The window's organization filter
   (`visibleInWindow`) applies only to records from a Solus API or a managed host
   (`usesWindowFilter`, `managedHostIds`), on desktop, web, and mobile. Signed out, the
   owner's organization records no longer vanish. `organization-scope.md` §2 says so.
2. *(Replaced by the plain-requests rewrite of D7: there is no copy to reconcile.)*
   **The host list keeps a host it cannot confirm.** An account write that does not
   land throws; a host counts as listed only after its write lands; a pull that
   overlapped a write of this client reads again; an overlapping refresh is queued;
   a host a pull removes gets the cleanup a forget has; a host this client never
   paired is never written to a list; a re-paired host's old id is removed.
3. *(Replaced by the rewrite: the phone holds the list's answer in memory, apart from the directory.)*
   **The phone keeps account-list hosts through a directory refresh.** They carry
   `listedBy`, not the directory's `accountUserId`; the list or a sign-out removes them.
4. **A personal machine's sessions keep their personal state on the machine.** Only a
   managed machine's published sessions are homed on the Solus API (`sessionHomeId`);
   the API's copy of a session a connected personal machine runs is not listed twice.
5. **Inbound mapping, `hostKeyOf`.** The linked owner's account id is stored as the
   host user's key: review requests, mentions, share subjects, task assignees (the
   owner may now be assigned an organization task), an attached machine's session
   owner, and the automation pause.
6. **Outbound mapping, `keyForReader`, `cloudKeyOf`, `cloudUserIdOf`.** Anyone but the
   owner sees the owner by their linked account in share lists, record roles
   (`accessOf`), and session records; the share mirror and the activity mirror send
   the account. Presence and reviewer ids still show the local key to members.
7. **Agent tools read what the turn's person may open** (`toolMayRead`):
   `read_session`, `search_sessions`, `read_plan`, `comment_document`.
8. **Pinned sessions are the owner's.** Others get none and cannot pin.
9. **The event stream, attention, and presence respect the owner's scope**
   (`readsWholeDisk`): a pairing on an attached machine hears only what it may read.

Open: item 10 of the audit (what an attached self-hosted server is) is the
maintainer's decision.

## 4. Questions

Answered by the maintainer on 2026-11-03: Q2–Q6. Q1 uses the proposal until the maintainer says otherwise.

- **Q1. Members' sessions on the owner's personal machine.** By rule 1 they are
  the owner's (role `owner`). Do they also show in the owner's session list, or
  only when the owner opens one? Proposal: they show only when opened, so the
  list stays the owner's own work.
- **Q2. A managed machine (an organization VM with no personal owner).** Answer:
  an organization-managed machine is reached through the Solus API, not through a
  personal link. So rule 3 applies to it: its records have organization and user
  filters. Rules 1 and 2 apply only to a machine with a personal owner.
- **Q3. Other people's credentials on the owner's host** (`PERSONAL` kinds:
  integrations, notifications, browser profiles). Answer: yes. A member's MCP
  connection, notification, or browser jar stays that member's. Rule 1 applies
  to records, not to another person's credentials. The owner's own `PERSONAL`
  rows use the D1 key, so they do not disappear at sign-out. Plan
  `cloud-vault.md` §2.5 (the host keeps no credential of the person after
  unlink) stays.
- **Q5. Where the list is read.** Answer: from the local database while signed
  out, from the cloud while signed in; the local rows sync up at sign-in (D7).
- **Q6. Tokens.** Answer: access is per client and user. Each client holds its
  own token for a host; the list holds no credential (D7).
- **Q4. A different account signs in on the same machine.** By rule 1 the data is
  the machine owner's, so it stays and is mirrored under the newly linked account.
  Answer: yes.

## 5. Sites (inventory of 2026-11-03)

### 5.A Host reads that compare a person key → D1 + D2

| Site | Change |
|---|---|
| `data/sessions/session-records.ts:149-183` `readerViewJoin`, `sessionListedClause`; `:294-307` `listCandidates`; `:340` `readPage` sharedBy | owner: no `created_by` test; D1 key for `reader_view` |
| `data/sessions/session-states.ts:180-338`; `data/sessions/api-operations.ts:121-150, 321-329` | D1 key for the owner's state rows |
| `data/tasks/task-snoozes.ts:64-92`; `transport/handlers/tasks-handlers.ts:64-67, 229-234` | D1 key |
| `admission/access.ts:158-160` `visibleTo` `PERSONAL` branch | D1 key (Q3) |
| `data/notifications/store.ts:220-222, 285, 396`; `notifications/hub-events.ts:23`; `data/notifications/shared-sessions.ts:46-58` | D1 key; Shared with you never names the owner's own session |
| `data/insights/saved-queries.ts`, `data/insights/turn-flags.ts`, `transport/handlers/observability-handlers.ts:33-37, 120` | D1 key |
| `transport/handlers/webhook-handlers.ts:53`; `execution/webhooks/webhook-runtime.ts:29-34` | D1 key |
| `data/automations/automations-store.ts:469, 490-493, 688` | D1 key |
| `transport/handlers/suggestion-handlers.ts`, `data/tasks/task-activity.ts:129`, `data/stored-attribution.ts:47-63` | D1 key; `followHostUser` keeps showing the account to others |

### 5.B Owner scope and admission → D3

- `admission/principal.ts:231-234` `recordScopeOf`: an owner reads every organization.
- `admission/doors.ts:63-82` `principalForClaims`: the linked owner's token is `owner`.
- `admission/actor.ts:124-141` `unattendedActorFor`; `execution/seats/acting-identity.ts:269-272`; `vault/vault.ts:96`; `execution/sessions/turn-organization.ts:189-195`: "is the host owner" uses the D1 key.

### 5.C Filters that stay → D5

Guests: `access.ts:67-72, 139-145`, `principal.ts:239-240`, `access-policy.ts:257-264, 332-390`.
Members on a personal machine: `standingOf` ACL path, `visibleTo` `:162-166`,
`namingClause`, the per-person list for a non-owner, `event-audience.ts`,
`presence-manager.ts:71-73`, `departed-members.ts`. Runners: `access.ts:85, 156`,
`sync/runner-intake.ts`.

### 5.D Cloud boundary → D4

`sync/delivery-queue.ts:85-88` `deliveryActorOf`, `sync/runner-delivery.ts:191, 268`,
`sync/mirror/transcript-mirror.ts:78`, `sync/mirror/webhook-mirror.ts:34-43`.

### 5.E Clients

- Desktop and web decide Shared with you from the role alone
  (`workspace-ui/src/contexts/workspace/shared-sessions.ts:24-35`). With D2 they need no change.
- Mobile counts `none` as shared (`apps/mobile/src/features/threads/shared-with-you.ts:15-17`).
  Change it to the desktop rule, and correct its comment.
- The client compares person keys for comment read marks, work reviews, mentions,
  webhooks, and browser guests (`connections-handlers.ts:97-100` gives the key).
  With D1 the host gives the D1 key on every door, so these comparisons hold.

## 6. Order

1. **D6, indexer-born sessions settled.** Small, and independent of the rest.
2. **D2 role** — built: `standingOf` gives the host owner `owner`
   (`admission/access.ts`). Tests updated: `access.test.ts`, `share-manager.test.ts`.
   `organization-vm-records.test.ts:408` still expects `editor`; it changes with D3.
3. **D1** — one owner key; delete the row moves; `ownerKeyOf` for every owner door.
4. **D4** — map the key at delivery; prove that a mirrored row names the account.
5. **D2 lists and personal state, D5** — §5.A, with a test that a non-owner's
   filters do not open.
6. **D3** — scope and admission (§5.B).
7. **Clients** — mobile Shared with you; docs.

## 7. Documents to change

- `docs/plans/access-model.md` §2.3 and §2.3.1 ("the host owner is an administrator" → owner of the disk).
- `plans/012-user-actor-and-activity.md` U5 (link and unlink no longer move rows).
- `plans/009-organization-vms.md` Record scope (a paired owner reads every organization).
- `docs/plans/shared-with-you.md` §2 rule 1 and §12 (Shared with you comes from cloud reads and real shares).
- `admission/principal.ts` comment on `isHostOwner`, which already states rule 1.

## 8. Proof

- A host signed out, then signed in, then signed out: the owner's organization
  session keeps role `owner` and its archive, snooze, and settle state, and it is
  never in Shared with you.
- A mirrored session names the linked account, not `local:<id>`.
- A paired owner on an attached machine reads an organization session.
- A member on the owner's personal machine still gets `none` on the owner's
  unshared session; a guest still reaches only its link's resource.
- An indexed transcript that this database never ran lists as Completed.
