# Plan 020: The agent profile follows the person

Status: IMPLEMENTED in source (2026-10-08, uncommitted; not run against a cloud
host). See §10. The cloud half is `solus-cloud/docs/plans/agent-profile.md`;
the two are one feature and ship together.

## Why

A person's skills, instructions, and MCP servers make an agent work their way.
Today they are on one machine. Three mechanisms move parts of them, and none
of them talks to the others:

- **Agent profile** (`docs/agent-profile.md`, `execution/seats/agent-profile.ts`).
  The desktop reads `CLAUDE.md`, `skills/`, `agents/`, `commands/`, `AGENTS.md`,
  and `prompts/` from the laptop and copies them into the person's seats on a
  shared host, or into the homes of a VM they own. One way, desktop only. It
  skips MCP servers on purpose. Web and mobile can only see it and remove it.
- **Integrations** (`integrations/`, `docs/plans/mcp-integrations.md`). An MCP
  server is a host record, `local` or an organization's. Each person signs in on
  each host. The token is in that host's secret store, bound to an OAuth client
  the host registered for itself.
- **Settings sync** (`client-core/settings-sync.ts`, plan 018) and the **seat
  vault** (solus-cloud `agent-seats/`, plan cloud-agent-seats) carry preferences
  and provider logins between machines. Neither carries skills or MCP servers.

A person who moves to a VM gets an agent that does not know them. The goal is
that every host they have a seat on feels like their own machine: the same
skills, the same instructions, the same MCP servers, connected. It must work
without a Solus account, and with one it must sync and be editable from every
client and from the cloud console.

## Words used here

Keep the name **agent profile**. Do not coin "user agent profile".

- **agent profile** — one person's instructions, skills, and MCP servers, as
  one document (§1). Not a login, a setting, a plugin, a hook, or a transcript.
- **entry** — one key of the document: one file, one registry skill, or one
  integration. The conflict unit of sync.
- **source** — where a host's copy of a profile came from: `computer` (a push
  from the person's desktop) or `account` (a pull from Solus Cloud).
- **applied profile** — what a host holds for one person, with its source and
  revision, recorded in the manifest.
- **personal integration** — an integration record owned by one person, visible
  and usable only by them. A host's or an organization's integration is not
  personal.
- **push** — the desktop sends the profile to a host it reached. The unauthed
  path. Exists today.
- **pull** — a host fetches a person's profile from their account. The authed
  path. New.
- **reconcile** — the step of a pull that moves a host-local MCP connection
  into the account vault, or adopts the vault's (§5).

## Decisions

1. **One document, three parts, flat keys.** The profile is a map from entry
   key to entry. Keys are `file:<provider>/<path>`, `skill:<name>`, and
   `integration:<slug>`. One key is one conflict unit, so the settings-sync
   engine applies without change.
2. **A registry skill is a reference, not files.** A skill installed from
   skills.sh is stored as its source and id, and the host installs it with the
   skills CLI into the target's homes. A hand-written skill is its files, under
   the limits that exist today (1 MB per file, 16 MB in all). The document
   stays small, and the host keeps one installer.
3. **The computer is never overwritten.** On a host the person owns, a copy
   never replaces a file the host already had. That rule stays, and it applies
   to the laptop. The account document is a distribution point, not the truth
   for `~/.claude`. A difference on one entry is a conflict the person resolves.
4. **Credentials move only through the vault.** A push carries a record (name,
   URL, auth kind) and never a key, a token, or an OAuth client. Signed in,
   the cloud is the OAuth client and the only refresher. A host holds an MCP
   access token in memory until it expires, and nothing else.
5. **Cloud-held wins.** When the cloud holds a credential for a person and a
   server URL, every host uses it and drops its own.
6. **A host-local connection is moved, not abandoned.** When sync reaches a
   host that already holds a person's connection, the host uploads it (§5).
   The pair of OAuth client and refresh token works from the cloud, because a
   refresh sends client credentials and a refresh token and checks no redirect
   URL. One refresher must remain: the host deletes its copy after the cloud
   confirms the write.
7. **No compatibility.** Solus has no users. The bundle contract, the manifest
   format, and the RPC names change in place. The `integration` table is
   committed, so `owner_user_id` is a new migration; `integration_connection`
   is not committed and may change in place.
8. **No new push channel.** The cloud cannot push to a host today. A host pulls
   on three triggers: a client's nudge after its own write, a seat's creation
   or the host's boot, and the five-minute standing refresh. Do not build a
   cloud-to-host event stream for this.
9. **The host moves the credential, in open-source code.** Plan
   cloud-agent-seats decided that seat logins move only in private code. An
   MCP token is already held and used by the host in open-source code, and the
   host already reads account connections from the cloud
   (`vault/account-integrations.ts`). The reconcile upload follows that
   precedent. It is one `PUT`, over the person's delegated token, and it is
   named here so the exception is visible.

## 1. The document

In `@solus/contracts/agent-profile`, replacing `AgentProfileBundle`:

```ts
type AgentProfileEntry =
  | { kind: 'file'; provider: SeatProvider; path: string; contentBase64: string; executable?: boolean; hash: string }
  | { kind: 'skill'; name: string; source: string; skillId: string; version?: string }
  | { kind: 'integration'; slug: string; name: string; url: string; auth: IntegrationAuth }

type AgentProfile = Record<AgentProfileKey, AgentProfileEntry>   // the key is derived from the entry
```

`AgentProfileKey` is a template literal type over the three prefixes, so the
record is not a broad unknown record (CLAUDE.md rule 11). `isProfilePath`
stays the rule for a file path. A `file` under `skills/` is a hand-written
skill; a `skill` entry is a registry reference. The two must not name the same
skill; the schema refuses a document that has both.

Limits: 1 MB per file entry, 16 MB for the document, 5000 entries. A patch is
`set` and `reset` of keys with `expectedRevision` and `generation`, exactly
the shape of `accountSettingsPatchRequestSchema`.

Reading this machine's profile (`agentProfileRead`) answers a document: the
registry skills from `skills list -g --json` (its `source` field names the
registry skill), the rest as files, and the person's personal integrations as
`integration` entries. It still runs only for the host's administrator
(`access-policy.ts`).

## 2. The host: `AgentProfileManager` grows, the file applier moves out

`execution/seats/agent-profile.ts` is split:

- `execution/seats/profile-files.ts` — today's body: `check`, the writes,
  `keepHostFiles`, `refuseLinks`, `removeEmptyParents`, `walk`, `readManifest`.
  Unchanged in behavior. Moved because the manager would pass 600 lines.
- `execution/seats/agent-profile.ts` — `AgentProfileManager`, the one owner:

```ts
apply(target, document, source: 'computer' | 'account'): AgentProfileStatus
pull(target, userId): Promise<AgentProfileStatus>   // §4
remove(target): AgentProfileStatus
status(target): AgentProfileStatus
```

`apply` runs three appliers in order and writes the manifest last:

1. **Files**: `file` entries through the file applier, as today.
2. **Registry skills**: `skill` entries through `installSkill` and
   `removeSkill` in `skills-cli.ts`, with the target's `MemberSkillHomes`. A
   skill in the manifest and not in the document is removed. An install that
   fails is reported in `skipped` with reason `install-failed`; the rest
   continues.
3. **Personal integrations**: `integration` entries through
   `IntegrationStore` with `ownerUserId` set to the target person. Match an
   existing personal record by owner and URL, never by id: each host minted its
   own ids. A record in the manifest and not in the document is removed with
   its connection.

The manifest `.solus-profile.json` becomes `{ version: 2, source, revision,
syncedAt, entries: AgentProfileKey[], skipped }`. No reader of version 1.

The manager is not a pass-through. It owns the order, the manifest, the
source, and the one status. The appliers stay their own modules.

### 2.1 Personal integrations

Migration: `ALTER TABLE integration ADD COLUMN owner_user_id TEXT` and a
partial unique index on `(owner_user_id, slug)`. `IntegrationStore` reads
take the caller's scope as today plus `ownerUserId = caller or NULL`; a
personal record never appears in another person's list or catalog of tools.
`integrationCreate` takes `personal: boolean`. The gateway's session catalog
adds the acting person's personal integrations.

A personal integration's slug is unique per person, not per organization. The
tool prefix is unchanged.

## 3. Clients

Every surface implements the same capability (CLAUDE.md "Multi-surface").

- **Desktop and web**: Settings → Agent profile, one page, replacing the "Your
  agent profile" row of Settings → Providers. It lists the three parts, with a
  conflict per entry resolved in place, and on desktop only "Import from this
  computer". Sync status, the hosts the profile applies to, and "Clear synced
  profile" are on Settings → Account & sync (§10, "One account, one policy"). The
  sync engine is a second `DocumentSync` instance over the profile document,
  with its own storage key and request port.
- **Mobile**: the same page in React Native under Account, with
  `use-agent-profile.ts`. Mobile has no agent profile UI today; this is new.
- **Not signed in**: `AgentProfileStore.copyOnce` stays. The push now
  carries integration entries.
- **Signed in**: sync is on (§10). After a local write is confirmed by the
  account, the client calls `agentProfilePull` on every connected host where
  `profileAppliesTo` is true. That is the nudge of decision 8.
- **First copy**: at sign-in, an account document with content is adopted; an
  absent or empty one is created from this computer's profile (desktop) or
  this device's copy, with no prompt. The same rule personal settings follow
  (plan 018 decision 9).

## 4. The pull

`agentProfilePull` runs on the host for the caller. `AgentProfileManager.pull`:

1. Fetches the person's document and revision from the cloud with their
   delegated token (`sync/delegations.ts`; scope `profile:read` added to
   `DELEGATED_SCOPES`). A revision equal to the manifest's is a no-op.
2. Calls `apply(target, document, 'account')`.
3. Reconciles connections (§5).

Triggers, in `boot-server.ts` and `seat-manager.ts`:

- a client's `agentProfilePull`;
- a member's seat is created or connected on this host;
- the host boots, for every member with a seat;
- the standing refresh (`host/organizations.ts`, every five minutes) carries
  each member's profile revision; a changed revision pulls.

## 5. Credentials, and the reconcile

### 5.1 Where a credential lives

| State | Record | Credential | Refresher |
|---|---|---|---|
| Not signed in, or sync off | the host, pushed from the computer | the host secret store, one per host | the host |
| Signed in, sync on | the account document, pulled by each host | the account vault, one per person and server URL | the cloud |

### 5.2 Reading a credential on a call

`IntegrationCredentials.authorizationFor` for a personal integration of a
person whose profile source is `account`:

1. The in-memory cache for (person, URL) while its expiry is ahead.
2. Else `POST /v1/agent-profile/credential` with the person's delegated token
   and the server URL. The cloud refreshes if due and answers the
   authorization header value and its expiry. Cache it.
3. If the cloud is unreachable and the cache is expired, the connection row
   shows `cloud-unreachable`, a new status. Never `needs-sign-in`: that label
   would be a lie.

A host-local credential is used only when the person's profile source is
`computer`, or when the cloud has answered `not_connected` for that URL.

### 5.3 Signing in while synced

The connect card and Settings → MCP start the sign-in at the cloud:
`POST /v1/account/agent-profile/integrations/<slug>/connect` answers the
authorization URL; the callback is `/oauth/integration/callback` on
app.solus.sh; a bearer key is posted to the cloud, which checks it against
the server and seals it. The host learns the new connection on its next pull,
which the client nudges when the cloud reports the sign-in finished.

The OAuth protocol (discovery, dynamic registration, PKCE, `resource`,
exchange, refresh, revoke) moves out of `integrations/oauth.ts` into
`packages/contracts/src/integrations/oauth-protocol.ts`: pure functions over
`fetch` and Web Crypto, no Node imports, so the cloud consumes it as it
consumes every other contract. The host keeps its flow for the unauthed path
and calls the same functions.

### 5.4 The reconcile

After `apply`, for each personal integration of the person on this host that
has a host-local connection:

1. Ask the cloud whether it holds a credential for (person, URL).
2. **It does not.** Upload it: `PUT /v1/agent-profile/credential` with
   `expectedVersion: null`, the kind, and the material. For `bearer`, the key.
   For `oauth`, the client (id, secret, token endpoint auth method), the
   refresh token, the access token and its expiry, and the resource URL. On
   `201`, delete the host's token and mark the row "Connected through Solus
   Cloud". The host keeps the client registration: other people on the host
   share it.
3. **It does, or the upload answers `409`.** Cloud wins. Revoke the host's
   token at the server when the metadata names a revocation endpoint, delete
   it, and use the cloud path.
4. **The cloud is unreachable.** Keep the local credential, show "Connected on
   this host, not yet synced", and try again at the next pull. Nothing is
   deleted before the cloud confirms.

A server that expires a dynamically registered client, or binds a refresh
token beyond the specification, fails the cloud's first refresh. The row goes
to `needs-sign-in`, the person reconnects once through the cloud flow, and the
cloud's own client replaces the host's. That is the only path with a second
sign-in.

### 5.5 Reverse states

- Sync off on a device: nothing moves back. The vault keeps the credentials;
  hosts keep the cloud path while the delegation stands.
- "Clear synced profile": the cloud deletes the document and the credentials
  and advances the generation. Every host shows `needs-sign-in` for them.
- Sign-out revokes the delegation. The cloud path stops; the hosts hold no
  local tokens for synced integrations, so they show `needs-sign-in`.
- "Remove" on a host removes the applied profile from that host, as today.

An OAuth integration on a synced host depends on the cloud. A local copy as
well would bring back two refreshers. Decision 6 stands.

## 6. Managed hosts

A managed VM pulls every member's profile at boot and at seat creation (§4),
with that member's delegation. The host-worker is not involved: the document
holds no secret, and a token is fetched per call. The organization route
`GET /v1/orgs/<id>/agent-profiles` lists `{ userId, revision }` so the
five-minute refresh finds changes without reading documents.

## 7. Stages

1. **Contract and host.** The document (§1), the split and the manager (§2),
   the `owner_user_id` migration and personal integrations (§2.1),
   `agentProfileRead` as a document, `agentProfileApply(document)`,
   `agentProfilePull`, `agentProfileStatus`. The push carries integrations. A
   personal VM feels local for an unauthed person at the end of this stage.
2. **Account document.** Cloud stage 1 (the cloud plan). The second sync
   engine instance in client-core; Settings → Agent profile on desktop and web;
   the mobile screen; the first-copy offer; the nudge.
3. **Pull.** §4 on the host, with its triggers and the delegation scope.
4. **Credentials through the cloud.** The protocol module (§5.3), cloud stage
   2, the cloud-first read (§5.2), the cloud sign-in from the card and the
   page, the reconcile (§5.4), the `cloud-unreachable` status.
5. **Managed hosts** (§6) and the organization revisions route.
6. **Docs**: `docs/agent-profile.md`, `docs/integrations.md`, `docs/skills.md`,
   `docs/settings.md`, and the Codebase Map rows for `profile-files.ts`.

## 8. Tests

Host (`tests/unit/`):

- `agent-profile`: a document with a registry skill installs through the CLI
  into the target's homes and never into the host's; a removed entry is
  removed; a hand-written skill and a registry skill of one name are refused;
  the manifest is written last; an owner's host file is kept.
- `integrations`: a personal integration is matched by owner and URL across
  two hosts' ids; another person never lists it; a personal slug may equal an
  organization slug.
- `agent-profile` (pull): a revision equal to the manifest's does nothing; a
  changed revision applies; the three triggers each pull once.
- `integration-reconcile`: no cloud credential uploads and then deletes the
  local token; a `409` revokes and deletes; an unreachable cloud deletes
  nothing and keeps the row "not yet synced"; after reconcile the gateway
  reads from the cloud and caches until expiry; an expired cache with an
  unreachable cloud reads `cloud-unreachable`, not `needs-sign-in`.
- `oauth-protocol`: the moved functions behave as `oauth.ts` did, against the
  fake MCP server the integration tests already use.

Client (`tests/unit/`): the profile sync engine instance merges per entry and
shows a conflict per entry; a confirmed write nudges every host the profile
applies to; the first-copy offer appears only for an empty account document.

## 9. Open items

1. **An owner's delegation on a personal host.** Token exchange today names an
   organization (plan 010). A personal VM linked to an account has the owner's
   token through `ownerAccessToken` while a client is connected. (Resolved: ADR 0001
   stages 4 and 6 give the owner a `personal` delegation, made from the token that a
   client presents, the desktop's main process included; `ownerAccessToken` is gone.) The cloud
   credential read and the pull need a token when no client is connected. The
   proposal: the owner's access token on a linked personal host carries
   `profile:read` and `integrations:read`, and the host refreshes it as it
   does a delegation. Confirm against `delegations.ts` before stage 3.
2. **Registry skill references.** `skills list -g --json` reports `source`;
   confirm it reports enough to reinstall the same version, or store the
   installed version alongside.
3. **Is `agentProfileRead` still administrator-only?** Yes. The import from
   this computer is a desktop action, and web and mobile do not have a
   computer. No change proposed.

## 10. Implementation record (2026-10-08)

### What was built

- **Contract** (`packages/contracts/src/agent-profile.ts`): the flat document
  of `file:`, `skill:`, and `integration:` entries with the schema refinements
  of §1; the account document shapes beside the settings ones; the statuses.
  `packages/contracts/src/integrations/oauth-protocol.ts` holds the MCP OAuth
  protocol as pure functions over `fetch` and Web Crypto;
  `profile-credentials.ts` holds the vault, executor, and connection shapes.
- **Host**: `execution/seats/profile-files.ts` is the file applier, moved
  unchanged; `AgentProfileManager` sequences files, registry skills through the
  skills CLI, and MCP records through `integrations/profile-integrations.ts`,
  and writes the version-2 manifest; its `pull` reads the account with the
  person's delegated token, applies on a moved revision, and runs the
  reconcile. Personal integrations: `owner_user_id` by a table rebuild (the
  committed table's `UNIQUE (organization_id, slug)` could not be dropped in
  place), `IntegrationStore.list(scope, viewer)`, `getVisible`, `listOwned`,
  `findByUrl`, `all`; `personalRecordOwnerOf(principal)`; the handlers let a
  member write their own records and keep shared ones for the administrator.
  `connections.ts` reads a `cloud` connection from `cloud-credentials.ts` with
  the cache and the `cloud-unreachable` status, and its `reconcile` moves a
  host-local connection into the account after a pull. `oauth.ts` keeps the
  host's flows and secrets over `McpOAuth`, the one protocol class.
- **Triggers**: a member's seat connecting, boot, a client's `agentProfilePull`
  after its own write, and a five-minute sweep over every member with a seat
  and the owner of a linked host. The delegated scopes gained `profile:read`,
  `integrations:read`, `integrations:write`.
- **Clients**: `client-core/document-sync.ts` is the engine of plan 018 made
  generic over a `SyncedDocumentContract`; `settings-sync.ts` binds it to the
  personal settings with its public names unchanged, `agent-profile-sync.ts`
  to the profile. `agent-profile-requests.ts` is the account adapter (cookie
  on web, the main process on desktop through three plus four narrow IPC
  methods, the bearer session on mobile). The Settings → Agent profile page
  on desktop and web (`components/settings/SettingsTabAgentProfile.svelte`
  and `agent-profile/`, stores under `contexts/seats/`), and the mobile screen
  (`apps/mobile/src/features/settings/AgentProfileScreen.tsx` with its local
  store, sync, and hook), implement §3; the integrations stores of both route
  a synced personal integration's sign-in to the cloud (§5.3) and read
  "Connected through Solus Cloud" and "Solus Cloud unreachable".
- **Cloud**: see `solus-cloud/docs/plans/agent-profile.md` §10.

### Decisions made during implementation

1. **No organization revisions route** (§4, §6). A pull costs one read and
   compares the revision, so a five-minute sweep over every seat replaces the
   `GET /v1/orgs/<id>/agent-profiles` route. The host-worker does nothing.
2. **The sync engine was not reusable as it stood.** Plan 018's engine named
   the settings keys throughout. It became `DocumentSync` over a contract that
   names the keys, the schema, the size bound, and the storage key; the
   settings binding kept every public name. Decision 1's "without change" was
   wrong by one refactor.
3. **A connection row names where it lives.** `IntegrationConnection.source`
   is `host` or `cloud`, and `cloud-unreachable` is a status of its own, so a
   client can say "Connected through Solus Cloud" and never show "Needs
   sign-in" for an outage.
4. **An uploaded OAuth credential carries the host's client.** The cloud
   refreshes with it until the person reconnects through the cloud's own
   client (§5.4). A bearer key travels as it is.
5. **A pull's reconcile never deletes before the cloud confirms** (§5.4 case
   4), including when the host cannot export an OAuth token (no refresh
   token): that connection stays on the host, counted as kept.

### Not done, or limited

- Not run end to end against a cloud host or the console; the proof of the
  cloud plan §9 is open.
- Open item 1 (an owner's delegation on a personal host) stands: a linked
  personal host pulls for its owner only while a client of theirs is connected
  (`personAccessToken` holds the owner's token), not from a delegation.
- `components/settings/integrations.store.svelte.ts` grew past the 600-line
  review mark with the cloud sign-in flows (§5.3); the sign-in flows are the
  natural split when it is next touched.

### Signed in means the cloud (2026-10-09)

A sign-in to a PlanetScale server on a person's own managed host ran on the
host, because the server was the host's (`ownerUserId` null) and the client
sent only a person's own server to the cloud. The browser came back to the
host's tunnel URL, where the callback was not offered. The rule is now one
fact:

- **Signed in, the sign-in runs at the cloud** for any server the host shows
  the person, shared or their own, with or without profile sync. A
  `client-required` server stays on the host: only the host holds its
  administrator's client. Signed out, nothing changes.
- **The cloud takes the auth from the request** when the profile does not name
  the server (`profileConnectStartRequestSchema.auth`, the host's probe;
  `profileConnectKeyRequestSchema.scheme`). The profile was already a document
  the person writes, so this trusts nothing new. A requested server and its
  metadata address must be public HTTPS. The pending sign-in seals its server
  and metadata address with the verifier, so the callback no longer reads the
  profile.
- **The reconcile adopts a connection the account holds** when the host has
  none, or one that is not connected. Before this, only a connection already on
  the host moved to the cloud, so a fresh cloud sign-in never reached a host.
  It walks every integration the person sees (`IntegrationStore.list`), and a
  pull reconciles even when the account holds no synced profile.
- **The client waits for this host's pull** (`CloudSignInPort.pullHosts(serverId)`)
  before it reads the host's rows. Mobile's conversation sheet reads the record
  (`integrationGet`) so it can route to the cloud too.
- **The tunnel offers the OAuth callbacks** (`/oauth/integration/callback`,
  `/oauth/google/callback`). A signed-out sign-in through a tunnel URL lands
  there; the `state` names the flow.

### Consolidation (2026-10-08, later the same day)

Review found the first cut over-built. The second cut, with no users to keep
compatible:

- The profile is the plain entries map. The `{ version, entries }` wrapper and
  the key-names-its-entry refinement are gone; every writer derives keys with
  `agentProfileKeyOf`, and a host applies entries by their content. The one
  rule that needed a check — a registry skill and a hand-written skill of one
  name — moved to the host's apply, where it refuses before writing.
- The OAuth protocol is one class, `McpOAuth`, that owns fetch, the clock, and
  the metadata cache. The host flow and the cloud services construct one each.
- The pull lives in `AgentProfileManager` (`pull`, `pullQuietly`,
  `startPeriodic`) and takes the account as one optional dependency.
- The reconcile lives in `IntegrationConnections.reconcile`; the exports and
  adoptions it needs are private to that class. `ProfileIntegrationOwner` is
  also the reconcile's subject, because a person's personal records and their
  connections share one owner key.
- `AgentProfileCopy` is the one shape for a read and a push.

### Signed in is synced (2026-10-12)

Maintainer decision: signed in to Solus Cloud, the agent profile always syncs
through the account, and the account is the one list of the person's MCP
servers, skills, and instructions. It replaces the per-client opt-in of §3 for
the profile. Personal settings followed on the same day (below).

- **No toggle.** A client enables profile sync when the person signs in:
  "use synced" when the account has a profile, else the computer's profile
  (desktop) or the device's copy as the first copy.
- **Write-through.** `integrationCreate`, `integrationUpdate`, and
  `integrationRemove` on a host tell `AgentProfileManager` when the record is
  the caller's own (the owner's host records, or a member's personal ones).
  Saves merge into the account at `POST /v1/agent-profile/entries`; a removal
  leaves the profile before the record goes, and is refused when the cloud is
  unreachable, so the next pull cannot restore it.
- **Adoption.** A pull writes the target's own records that no entry names,
  and that no pull put there, into the profile. That is how a server added
  before sign-in, such as PlanetScale, joins it. From the account, the
  owner's own records are the profile's to manage, so a later removal or
  disable reaches the host that first had them.
- **Disable.** Every entry carries an optional `disabled`. A disabled entry
  stays in the document and is on no host: apply skips it, and adoption does
  not bring its record back because the profile still names its URL.

### One account, one policy (2026-10-12, later the same day)

Grilled with the maintainer; plan 018 decision 9 is the twin record.

- **Policy.** Personal settings sync the same way the profile does: signed in
  is synced, no switch per device. The settings switch guarded the theme and
  the font while the profile, the more sensitive material, synced on sign-in;
  that guarded nothing and made two models.
- **Seed.** Both documents follow one silent rule at sign-in: an account
  document with content is adopted; an absent or empty one is created from
  this device. "Clear synced settings" and "Clear synced profile" stay two
  actions, each the explicit "replace with this device" for its document: a
  person who starts their instructions again keeps their theme.
- **Two documents.** They stay apart. No host reads the settings document;
  every host reads the profile with a delegated token, on each seat and every
  five minutes. One document would make every host read the theme, and a font
  change would bump the revision every host watches and re-apply the profile.
  The 16 MB bound and the few-KB bound stay separate, as do the conflict
  units (one entry, one field).
- **Engine.** `DocumentSync` loses the opt-in: `prepareEnable`, `enable`, the
  offer and choice types, `turnOff`, the `off` state, the stored `enabled`
  flag, and `stoppedReason`. Its ports gain `localCopy(purpose)`: for `seed`,
  this device's copy as the account's first (the desktop reads this computer's
  profile); for `replace`, this client's own copy, which the account's replaces
  key by key. `setAccount` starts sync by itself, and a generation another
  device advanced is the same path again, not a stop. `clearCloud` stays and
  reseeds from the clearing device. The status carries the `generation` this
  device is on, so the owner knows when the device moved onto a copy.
- **One owner per client.** One account sync owner holds the two engines and
  gives Settings → Account & sync one status: the worst state of the two in the
  order error, conflict, offline, pending, loading, synced; conflicts listed
  with their document. `AccountSyncStore` (`contexts/account/
  account-sync.store.svelte.ts`) on desktop and web, `AccountSync`
  (`features/account/account-sync.ts`) on mobile; the per-document sync stores
  went. The settings store and the profile store keep their content role and
  read remote changes from their own engine. The hosts pull when the profile's
  generation moves (a start, a clear here or elsewhere) and after a confirmed
  write. The desktop main process's two request clients were already one
  adapter each over the same requester, so they stay.
- **Settings → Account & sync** (the tab's existing label; its component is renamed from Personal): who is signed in; one sync status
  with both documents' conflicts, each resolved in place on its own tab, and
  the two clear actions; one row per host with its account link (uplink) and
  what it holds of the profile, with Pull, Copy when signed out, and Remove.
  "This computer" is the first row on the desktop. The host detail Access page
  keeps its link control. The Agent profile tab holds only content. Mobile
  mirrors this as an Account screen; its Host access screen keeps its link
  section. Extra instructions stay where they are; moving them under the
  profile is out of scope.
- **Cloud.** One account-document service (`account-document/document.ts`:
  `AccountDocument`, given the table's rows, a schema, a byte bound, the
  conflict codes, and the response's field name) behind the two unchanged
  routes, with one HTTP helper (`account-document/http.ts`); `settings/http.ts`
  keeps only the organization settings' errors. The console keeps its
  sub-pages; the console is the account, so no sync status there. Route paths
  and shapes do not move, so either side deploys first.
- **Hosts.** Nothing changes: the pull, the write-through, the adoption, the
  reconcile, and the vault stay.

### Instructions are a setting; the home's instruction files are not profile (2026-10-14)

Maintainer decision: `CLAUDE.md` and `AGENTS.md` leave the agent profile. An
instructions file belongs with a project, not with a person, so a home's copy
is not read, not carried, and refused as a profile path (`AGENT_PROFILE_ENTRIES`
names only `skills`, `agents`, `commands`, and `prompts`). The person's own
instructions are the extra instructions of their personal settings, which
every prompt already carries and which sync with the account:
they are edited on the Agent profile page on desktop, web, and mobile, and on
the console's agent profile page, which writes `extraInstructions` to the
settings document against the revision it read. The Settings → Instructions
tab went; the Agent profile tab holds the editor. Clients list the copied
`agents/`, `commands/`, and `prompts/` files under "Files". The per-model
instructions (`modelInstructions`) went with it, from the settings contract,
the run input, and the system prompt: one instruction text per person.
