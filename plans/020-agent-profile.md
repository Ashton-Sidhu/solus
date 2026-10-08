# Plan 020: The agent profile follows the person

Status: PLAN (2026-10-08). Not started. The cloud half is
`solus-cloud/docs/plans/agent-profile.md`; the two are one feature and ship together.

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

type AgentProfileDocument = { version: 1; entries: Record<AgentProfileKey, AgentProfileEntry> }
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
  agent profile" row of Settings → Providers. It lists the three parts, the
  sync state ("Synced", "Local only", a conflict per entry with both values),
  the hosts the profile applies to with "Copy now" and "Remove", and on desktop
  only "Import from this computer". The sync engine is a second
  `SettingsSyncEngine` instance over the profile document, with its own
  storage key and `SettingsCloudRequests`-shaped port. Nothing in the engine
  changes.
- **Mobile**: the same page in React Native under Account, with
  `use-agent-profile.ts`. Mobile has no agent profile UI today; this is new.
- **Not signed in, or sync off**: `AgentProfileStore.copyOnce` stays. The
  push now carries integration entries.
- **Signed in with sync on**: after a local write is confirmed by the account,
  the client calls `agentProfilePull` on every connected host where
  `profileAppliesTo` is true. That is the nudge of decision 8.
- **First copy**: when sync turns on and the account document is empty, offer
  this computer's profile as the first copy. The same choice settings sync
  makes.

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
- `agent-profile-pull`: a revision equal to the manifest's does nothing; a
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
   token through `ownerAccessToken` while a client is connected. The cloud
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
