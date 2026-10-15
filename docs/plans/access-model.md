# Access model — roles, ACLs, and one vault

Status: decided 2026-10-14 (D1–D4 answered by the maintainers, §4).
Extends `docs/plans/permissions.md` (the host permission table stays; its names change, §1).
Changes `plans/019-acting-identity.md` (the acting scope) and
`plans/020-agent-profile.md` §5 (where a connection lives).

Solus has no users yet, so this is a clean change: no migration of old rows,
no compatibility readers.

## 0. Why

A member's PlanetScale server on a managed host had a `connected` connection
and gave their agent no tools. The cause was not one bug. Three parts of the
access model answer the same questions in different ways:

1. **Who is the person.** `ownerKeyOf` (records), `credentialUserFor`
   (GitHub, Google, Atlassian), and, until 2026-10-14, `personalRecordOwnerOf`
   and `integrationUserOf` (MCP). `null` meant "the owner" in one place,
   "shared" in another, and "the host's own store" in a third.
2. **Who may read or change a record.** The host-action gate is one table
   (`permissions.md`). Records are not:
   - sessions and works use share roles (`share_grant`, `ShareManager.roleFor`);
   - integrations use an owner column and `mayChange`;
   - notifications and snoozes compare a person key by hand;
   - tasks use the organization grant and `filterVisible`;
   - automations, Insights metrics, project update and remove, and the `pr*`
     mutations have no check beyond `host.use`.
   A list and a get can disagree, because a list filters in SQL
   (`workspaceResourceVisibility`) and a get asks `roleFor`.
3. **Where a credential is.** Four stores, each with its own lookup:
   provider credentials (`vault/provider-credentials.ts`), MCP connections
   (`connection-store.ts`, `connections.ts`, `cloud-credentials.ts` and its
   reconcile), seat logins (`seats/`), and delegations (`sync/delegations.ts`).
   Each caller decides the location before it asks, with the `null` rule.

## 1. Vocabulary

Standard access-control terms, so a reader needs no glossary. Locked for this
plan and its code.

- **person** — someone Solus acts for. Named by a **person key**, the user
  key of plans/012: an account id, `local:<id>` for the owner of a host that is
  not linked, or `guest:<id>`. `ownerKeyOf(actor)` is the only function that
  gives it. The host's own work and a runner have no person (`null`).
- **host role** — what a person is on a host: `owner`, `admin`, `member`,
  `guest`, or `system`. Today's principal kinds map to these.
- **permission** — one thing a host role allows, such as `host.git.write`.
  The table is RBAC: `PERMISSION_OF_METHOD` names each method's permission,
  and `permissionsFor` gives a host role's permissions (step 6, which renamed
  the old "host action" code).
- **resource** — a record a person can own: `session`, `work`, `task`,
  `integration`, `automation`, `project`, `notification`, `insight`,
  `browserProfile`. A pull
  request is part of its session.
- **owner** — the person a resource belongs to. Every resource has exactly
  one: `owner_key`, never empty.
- **ACL entry** — one grant on a resource to someone other than its owner: a
  user, a team, the organization, or a link, with a **resource role**. Today's
  `share_grant` row; the table becomes `acl_entry`.
- **resource role** — `viewer`, `commenter`, `editor`, `owner` (and `none`).
  What a role allows is `ROLE_VERBS`, unchanged.
- **personal resource** — a resource only its owner can reach: `integration`,
  `notification`, and `browserProfile` (one person's cookie jar in a project,
  member-isolation.md §6). Hard-coded; no administrator and no ACL entry reaches it.
- **vault** — the one module that holds and reads credentials. A caller names
  a person and a **credential ref**; the vault decides the location.
- **location** — where a credential is: `account` (the person's Solus account),
  `host` (this host's secret store), or `machine` (logins the host's operating
  system already holds, such as `gh`).

Do not say "credential user", "integration user", "personal record owner",
"null owner", "shared record", "kind entry", or "access rule".

## 2. Decisions

### 2.1 One person in the acting scope

`ActingScope` becomes `{ identity, personKey }`. `credentialUserId` and
`credentialUserFor` are removed. `personKey` is `ownerKeyOf(actor)`.

A guest is their own guest key. Their turn runs on the sharer's seat
(`seatFor`, unchanged), but it has no credentials: the vault answers nothing for
a guest key, so a guest's turn cannot push, call Google or Atlassian, or use an
MCP server (D1). Work that needs a credential is the sharer's to run.

### 2.2 Every resource has one owner

Every resource table has `organization_id` (unchanged) and `owner_key`, a
person key, `NOT NULL`. There is no "shared" or "the host's" resource. It
replaces `owner_user_id` on `integration`, `session_records`, and
`session_admissions`, and the owner row of `share_grant`: `acl_entry` holds only
what the owner gave to others. `created_by` is history and grants nothing.

"Shared with the organization" is an ACL entry (`subject: organization`), not a
missing owner. A session a member creates in an organization space gets its
owner and an organization `editor` entry (`ShareManager.claimSession` and
`shareWithOrganization`).

`host-user-rows.ts` moves `owner_key` and ACL subjects on every resource table
in one list, so a new resource cannot be forgotten on link and unlink.

### 2.3 One function decides a resource role

```ts
const PERSONAL: ReadonlySet<ResourceKind> = new Set(['integration', 'notification', 'browserProfile'])

function roleOf(actor: Actor, resource: ResourceRow): ResourceRole {
  if (!scopeAdmits(recordScopeOf(actor.principal), resource.organizationId)) return 'none'
  if (resource.ownerKey === ownerKeyOf(actor)) return 'owner'
  if (PERSONAL.has(resource.kind)) return 'none'
  return highest(aclRole(actor, resource), isHostAdmin(actor.principal) ? 'editor' : 'none')
}
```

1. Outside the person's organization scope: `none`.
2. The owner: `owner`.
3. A personal resource: nobody else.
4. Otherwise the best ACL entry that names the person, their team, their
   organization, or their link; an administrator gets at least `editor`.

`visibleTo(actor, kind)` is the same four lines as one SQL predicate, so a list
and a get cannot disagree. A resource kind that cannot be shared simply has no
ACL entries; the client does not offer Share for it. There is no per-kind
setting.

What this gives, by resource:

| Resource | Owner | Others | Administrator |
|---|---|---|---|
| session, work, task | owner | ACL entries | editor |
| automation (D4) | owner | — | editor |
| project | owner | lists the directory (§2.3.2) | editor |
| insight (D2) | the person who ran the turn | — | editor (reads all) |
| integration (D3), notification, browser profile | owner | nobody | nobody |
| pull request | its session's role | | |

### 2.3.1 Special cases (decided while building steps 3 and 4)

The rule above has no exceptions for a person. These cases decide what the
rule reads, and they are the only places outside `roleOf` that touch a role:

- **The host itself and a runner.** `system` holds every role (it acts for the
  host, not for a person); a `runner` holds none (its writes go through the
  system-only methods). Both are in `roleOf`.
- **The host's own work.** A record the host makes for nobody — a session the
  indexer finds on the disk, a task or a work an outbox op or an import makes
  on a host — is owned by the host's user (`hostUserKey()`). On a personal host
  that is its owner. On a managed host it is the machine's own `local` user,
  which no member is: members reach it only through ACL entries, and an
  administrator edits it. This replaces "a resource nobody owns on a managed
  host is every member's to edit". On the Solus API a record always has a
  person (the runner's or the caller's); with none it would be the `host-owner`
  key, which no person holds.
- **The host owner is an administrator.** `owner` only on what is theirs (the
  host user's), `editor` on everything else in their scope. This replaces "the
  host owner holds every role on the disk". A pairing connection to a machine
  attached for organization work has the Local scope, so `roleOf` line 1 keeps
  it out of the organization's records. A host administrator still reaches
  `shareTransfer` for what a departed member owned (plan 004 item 10).
- **A session before its record.** The person who starts a session owns it.
  The first claim (`claimSessionOwner`: a client's watch or prompt, and every
  turn admission for the turn's person, so a child session or an automation's
  run is its person's) is kept in memory until the record is written, and the
  record is born with it. While a session id is unknown to the machine and
  unclaimed, the person who names it (a host owner or a member, never a guest)
  is its owner-to-be, so their first watch passes the gate; the handler then
  claims it. A session the machine knows but has not recorded yet is the
  machine's own (the host's user, in the machine's organization), as its record
  will be. On the Solus API a session with no record does not exist.
- **Transfer** changes `owner_key`. The new owner's ACL entry, if any, goes.
- **Integrations** are personal: the owner alone reads, uses, and changes one,
  its OAuth client included (D3). An administrator reaches none.
- **Notifications** are personal too: `recipient_key` is their owner (the
  column keeps its name). Reads, marks, and the `notifications.changed`
  audience use `visibleTo` and `roleOf` with that column as the owner.
- **Who delivers a record's rows** to the Solus API: its owner when that is an
  account; the account that linked the host when the owner is the host's user
  with no account (`deliveryActorOf`).
- **Browser profiles** are personal (member-isolation.md §6.1). Their rows
  are host-local and have no `organization_id`: a person's jar is theirs in
  every scope. The methods name a project and a profile id, which is unique
  only per person, so no call names one person's profile for another: each
  handler reads and writes only the caller's rows (`owner_key = person`, the
  personal-kind predicate of `visibleTo` without the scope), and the event
  audience sends `browser.profilesChanged` only to the owner. A page in a
  person's jar is driven only by that person.
- **Old rows.** The migration (`drizzle/*/0019_resource_owners.sql`) takes
  `owner_key` from the owner row of `share_grant`, then from a session record's
  `owner_user_id`. A row with neither keeps `''`, which no person holds: only an
  administrator reaches it. An integration with no owner is not kept, nor are
  its connections (host migration slot after `disabled_tools`).

### 2.3.2 Decisions of step 5 (built 2026-10-14)

- **Kinds with no ACL entries.** An automation, a project, an insight, and the
  personal kinds have no ACL entries, so `visibleTo` does not read `acl_entry`
  for them. This is not a per-kind setting: those kinds have no entries. It
  lets the predicate run where there is no `acl_entry` table: an automation is
  in the host's own SQLite file (`getDb`), an insight in `metrics.db`.
- **One role lookup for the gate.** `ShareManager.roleFor` answers every kind
  a call names: a shareable kind from its row and ACL entries; an automation, a
  project, or a notification from its own row (`ownedRoleFor`). The gate and the
  event audience ask it.
- **Automations (D4).** `automations.owner_key` (host migration slot after the
  integration rebuild) is the person it runs for (`creatorKeyOf`), or the host's
  user for the host's own. An automation a person makes over RPC is in their
  organization for new records (`organizationForNew`), so it is in their scope.
  `automationList` and `automationRecentRuns` read through `visibleTo`; the
  methods that name one need its verb. `automation.changed` reaches only
  the people with a role on it; a deletion names only an id. The agent tools
  (`list_automations` and the rest) act as the turn's person
  (`workspaceToolAuthority`): an automation they may not reach answers as one
  that does not exist. The scheduler and the runner are the host's own work and
  run as before (the runner as the creator, `unattendedActorFor`).
- **Projects.** `workspace_projects.owner_key` (migration `0020_project_owners`)
  is the person who added it. The directory stays the organization's: every
  member lists every project of the organization (`workspaceProjectList` is
  not filtered by owner), because a project is found by its repository and two
  people add the same one. Update and remove need `project.edit`: the owner,
  or an administrator. A list and a get do not disagree: there is no get.
- **Insights (D2).** The owner of a turn is `user_id` on its spans (the
  account that ran it); a span with no person is the host's own work, which
  only an administrator reads. `visibleInsights(actor)` is `visibleTo(actor,
  'insight')` rendered for `metrics.db`; the turn page, its summary, the query
  builder, the distinct values, and a trace read through it. On the Solus API
  a member's insight page and reads hold their own turns; an organization
  owner reads all.
- **`metricsRunSql` is an administrator's (`host.admin`).** Arbitrary SQL can
  name any table and view of `metrics.db`, so it cannot be held to the
  caller's rows in a way that cannot be escaped. The agent tool
  `query_insights` takes the same permission from the turn's person.
  `metricsValidateSql` (prepare only) and `metricsCompileNl` stay `host.use`.
- **Pull requests.** A pull request is part of the sessions that link it
  (`session_pull_requests`, a dismissed link excluded). The `pr*` mutations are
  `host.git.write` (a repository write); `writePullRequest`, which every
  mutation passes, also asks for `session.edit` on at least one linking
  session. One that no session links needs only `host.git.write`. The gate
  cannot do this: the repository comes from the session's checkout, read with
  git in the handler.
- **Not changed:** turn flags (`metricsSetTurnFlag` and the list) are the
  host's marks in `solus.db`, not filtered by person; saved Insights queries
  are host-wide text.

Not changed here: a Solus API list of works or sessions also returns what a
task the caller can open links to (`workspaceResourceVisibility`), and a get
does not. That expansion is outside `roleOf` and stays until it is decided.

### 2.4 One gate for RPC and the Solus API

`assertRpcAccess` keeps its order (permission, then resource) and gets the
resource role from `roleOf`, not from `ShareManager`.
`RESOURCE_VERB_OF_METHOD` and `RESOURCE_LOCATORS` grow to every resource in §2.3:
the methods with no check today (`automation*`, `metrics*`,
`workspaceProject*`, `pr*` mutations) get a verb.

The HTTP Solus API's token scopes (`requireScope`) stay as an upper bound on a
token. `requireResource` calls `roleOf` too. One function,
`authorize(principal, action, resource)`, is what both doors call.

### 2.5 Administrators

An administrator is a host `owner` or an organization `owner`
(`isHostAdmin`, unchanged). They get every admin permission on the host and
`editor` on every resource that is not personal. Teams stay ACL subjects. A new
host role is a new row in `permissionsFor`.

### 2.6 One vault

The ref is the cloud vault's (`packages/contracts/src/vault.ts`,
`docs/plans/cloud-vault.md`): `provider` (GitHub, Google, Atlassian), `mcp`
(a server address), `typesafe`, and `seat`. The host keeps an MCP credential by
integration, so its MCP ref also carries the integration id
(`McpCredentialRef = McpRef & { integrationId }`); the account keys it by the
server's address alone.

```ts
class Vault {
  /** The stored credential where the vault keeps it; null when the person has none there. */
  read<T>(personKey: string | null, ref: ProviderRef | TypesafeRef, schema: ZodType<T>): Promise<T | null>
  read(personKey: string | null, ref: McpCredentialRef): Promise<McpCredential | null>
  /** A credential made on this host: a login only where the host keeps it; an MCP sign-in on the host. */
  save(personKey: string | null, ref: ProviderRef | TypesafeRef | McpCredentialRef, credential): void
  /** What this host holds; for MCP, the removed host token (to revoke) and the account cache entry. */
  remove(personKey: string | null, ref: ProviderRef | TypesafeRef | McpCredentialRef): void | OAuthToken | null
  /** Link and unlink: the person's key changed; their MCP tokens on this host move with it. */
  move(fromKey: string, toKey: string, integrationIds: string[]): void
  /** Link: the TypeSafe key moves into the account (the account's wins); every host login goes. */
  settleLinked(personKey: string): Promise<void>
  /** Unlink: the host keeps nothing for the person. */
  forgetPerson(personKey: string, integrationIds: string[]): void
  /** An executor upload (`PUT /v1/vault/credential`, `expectedVersion: null`): an MCP credential or a TypeSafe key. */
  upload(personKey: string, ref: McpCredentialRef | TypesafeRef, material: UploadMaterial, label: string | null): Promise<CloudCredentialUpload>
  /** Drop a cached account token: one (refused by its server) or all (a delegation ended). */
  forget(personKey: string, ref: McpCredentialRef): void
  forgetAll(): void
}
```

`vault/vault.ts` is the one module. The server installs its vault at boot
(`useVault`); code that holds no server object reads `vault()`. Every account
read and upload goes through one client: `POST /v1/vault/read` and
`PUT /v1/vault/credential` with the person's delegated token.

The vault owns the location rule (`credentialLocationOf`), which is written once.
**Signed in means the account** (maintainers, 2026-10-14):

1. The host's user before the host is linked to their account (the host user has
   no account): `host`. Only the host's own work (`null`) shares this store.
2. The host's user once the host is linked to them, and every member: `account`.
   The cloud refreshes; the host caches an MCP access token until a minute
   before it expires.
3. A guest: `none` (D1). The Solus API has no `host` location.
4. GitHub only: the owner of this machine (`isMachineOwner`) falls back to the
   machine's own `gh` login after the host store, and after their account when
   they are signed in. `gh` is a runtime login of the machine, so an account that
   does not answer only leaves the account out. A member never gets the owner's
   `gh`. One list holds this rule: `GitHubCredentials.sourcesFor`
   (`providers/github/credentials.ts`).

   | Person | Sources, in order |
   |---|---|
   | The host's own work (`null`), and the machine owner signed out | paired device, host store, `gh` |
   | The machine owner signed in | paired device, account (skipped if it fails), `gh` |
   | A member | account (a failure is the member's error) |
   | A guest | none |

An MCP connection of a person with an account may still have a host copy: a
sign-in made on this host, which the reconcile has not moved into the account
yet. The host reads that copy until the reconcile moves it (the connection row
says `source: 'host'`); after that the row says `source: 'cloud'`.

**At the link** (the host's user becomes their account, `host-user-rows.ts`):
the person's rows and MCP tokens move to the account key; `settleLinked` uploads
the TypeSafe key (a key the account holds already wins) and deletes every host
login, `provider:*` included, which the person connects again once on the
website; the reconcile uploads the MCP credentials and deletes their host copies.
What the cloud could not take yet (no delegation, cloud unreachable) is tried
again when the owner's personal delegation is made, and is never read meanwhile.

**At the unlink** (the registration ended, or the desktop signed out): the host
keeps nothing for the person: their host logins, MCP tokens, and Local MCP
connection rows go. They connect again on that machine.

Refresh stays with the code that speaks each protocol on the host (Google,
Atlassian, MCP OAuth): it reads from the vault, refreshes, and saves the new
credential back. There is no `status` on the host: a login's location answers
"is this the host's to change" (`usesAccountIntegration`), and an MCP
connection's status is its row in `connection-store.ts`.

The reconcile that moves a host connection into the account stays
`IntegrationConnections.reconcile` and runs after a profile pull: it needs the
OAuth client, the revocation, and the status rows, which are not the vault's. It
reads the vault's statuses that `POST /v1/agent-profile/read` answers beside the
document (`VaultConnection[]`), and reads, uploads, and removes through the vault.

**Out of the vault**, and why: seat logins (`.credentials.json`, `auth.json`)
are files the Claude and Codex CLIs read themselves, not something Solus sends;
delegations, WebSocket ticket keys, asset signing, and uplink tokens are the
host's own infrastructure, not a person's.

**Runtime logins and Solus connections** (decided 2026-10-14). There are two
kinds of credential, and each kind has one rule:

- **Runtime logins stay where the agent runs.** These are the Claude and Codex
  seat logins, the `gh` login and the git credential helper, and SSH. For the
  host's owner they are the machine's. For a member they are in their seat home;
  the copy of their GitHub token that their seat's `gh` and git use comes from
  their account and is a runtime login.
- **Solus connections are read only through the vault.** These are the
  credentials Solus itself uses to call an API: Google, Atlassian, MCP servers,
  Solus's own GitHub API calls, and TypeSafe. A signed-in person reads their
  account; the host keeps short-lived tokens in memory only. The owner of a
  machine that is not linked reads that machine's host store. A guest has none.
  No credential is stored for the host as a whole.

TypeSafe is a `typesafe` ref with the same location rule. `TYPESAFE_API_KEY`
from the launching shell is a machine credential, like `gh`: it counts only at
the `host` location, never for a signed-in person. Reads use the acting scope's
`personKey`, so `ask_jev` and Auto routing in a run use the run's person.

Open item, not changed here: the host store is plaintext JSON (mode 0600) on a
standalone server. Only the desktop app encrypts it (Electron safe storage).

### 2.7 Clients

Lists already return resources; each one carries `role` from `roleOf`, so
`Host.me.may(verb, resource)` reads one field for every kind, not only shares
(`resource-roles.ts` is generic: it keeps the role a list carried for a
control that names a resource by id, and asks for a share list only for a
shared kind it knows nothing about). Mobile reads the same field. No new
screens: controls that showed for anyone (automation edit, project remove) are
disabled with the reason when the role does not allow them.

A session card asks for `drive` on every client. When the reader may not drive
the session, a permission, a question, a plan, a usage limit, or a worktree
offer shows "Waiting for an editor" in place of its actions, and Stop is not
shown. The composer says "Shared with you to view".

On the wire the names are the names of §1. A Solus API record (task, work,
session, session admission) and a share list carry `ownerKey`, the owner's
person key. A share list has `entries`, each an `AclEntry`, and `shareSet`
takes `entries`. `share.changed` names no owner: a client reads the list again.
A share list and a share write need the resource's row. A session that is being
started has a role for its starter, but it has no owner until it is claimed, so
its list and its writes answer `NOT_FOUND`. They never name the host's user as
its owner. A record page whose row is gone between the read and the role read
answers `NOT_FOUND`.

A record listed through a task the caller can open (`workspaceResourceVisibility`,
§2.3.2) carries the role `roleOf` gives, which can be `none`: the role says
what a get and a change allow, not why the list held it.

## 3. Steps

Each step ships alone, with its tests, and leaves the tree green.

1. **Person** — `ActingScope { identity, personKey }`; remove
   `credentialUserFor`. Provider credential readers take `personKey` and the
   location rule (§2.6 rules 1–3) in one function. Tests: the location rule per
   principal and host kind.
2. **Vault** — `vault/vault.ts` with `read/save/remove/move/upload/forget`; MCP
   connections first (they already use person keys), then the three providers.
   `connection-store.ts` keeps the status rows; secrets and the cloud cache move
   behind the vault. Tests: each location, refresh, move, adopt.
3. **Owners and ACLs** (built 2026-10-14) — `owner_key NOT NULL` on every resource table;
   `owner_user_id` and the owner row of `share_grant` removed; `share_grant`
   renamed `acl_entry`; `host-user-rows.ts` moves one list of columns.
4. **`roleOf`** (built 2026-10-14) — `admission/access.ts` with `roleOf` and `visibleTo`, for
   session, work, task, and integration first. `ShareManager` keeps ACL entries
   and links and stops deciding roles. Tests: a role table per resource and
   host role, and a test that `visibleTo` and `roleOf` agree on every fixture
   row.
5. **Unchecked resources** (built 2026-10-14, §2.3.2) — automation, project, notification, insight, and
   the `pr*` mutations get a verb per method and a locator. Tests: a member
   cannot read or change another member's automation; a member reads only
   their own Insights, an administrator reads all (D2).
6. **One door** (built 2026-10-14) — `authorize(principal, action, resource)`
   in `admission/access-policy.ts`, called by `assertRpcAccess` and by the
   Solus API's `requireResource`; the old names are gone: `Permission`,
   `PERMISSION_OF_METHOD`, `permissionOf`, `permissionsFor`, `permissionsAllow`,
   `EVERY_PERMISSION`, `GUEST_PERMISSIONS`, and the wire field
   `ConnectionsServerInfo.permissions`. `authorize` takes the principal, not
   the actor: the permission table and `ShareManager.roleFor` read the
   principal, and `roleOf` resolves the actor.
7. **Clients** (built 2026-10-14) — `role` on records: the Solus API's task,
   work, and session records (`ShareManager.accessOf` reads a page's rows and
   ACL entries in one query each), `Automation`, `WorkspaceProject`, and
   `Integration`. A notification is not given one: only its owner ever reads
   it. `Host.me.may(verb, resource)` reads the role on the resource;
   `resource-roles.ts` keeps the roles of the sessions the list carried, for
   the composer and the cards. Mobile reads the same field with
   `resourceAllows`.

The `exceptions` list in `tests/unit/server-module-boundaries.test.ts` must not
grow. A lint rule (`solus/resource-read-through-role`) rejects a store read of a
resource that takes a bare `RecordScope` instead of `visibleTo`.

## 4. Decisions (maintainers, 2026-10-14)

- **D1. Guests have no credentials.** A guest's turn never uses the sharer's
  GitHub, Google, Atlassian, or MCP credentials. This changes today's behavior,
  where a guest's turn pushed as the sharer.
- **D2. Insights:** a person sees their own turns; a host administrator sees all.
- **D3. There are no shared MCP servers.** Every integration belongs to one
  person, like every record. `integrationCreate` loses `shared`; the
  OAuth client of a server without dynamic registration is set by its owner,
  not by an administrator; `mcp-integrations.md` §6.2's per-tool policy is the
  owner's. Shared rows in old data are not migrated (§0: no users).
- **D4. Automations:** a member sees and changes their own; a host
  administrator sees and changes all.

## 5. Not in this plan

Operating-system isolation between people on one host (plans/019 says the
model "prevents mistakes, not attacks"). Per-tool MCP policy
(`mcp-integrations.md` §6.2) — the integration's owner sets it, after step 4.
