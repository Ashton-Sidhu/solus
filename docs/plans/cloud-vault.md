# Cloud vault — one store for a person's credentials in Solus Cloud

Status: decided 2026-10-14 (maintainers). Builds on `docs/plans/access-model.md`
§2.6 (the host vault) and changes solus-cloud. Solus has no users and cloud hosts
can be restarted: old rows are dropped, not migrated, and there are no
compatibility routes.

## 0. Why

Solus Cloud keeps a person's credentials in three stores. Each has its own table,
sealing binding, version rule, auth, routes, error codes, and audit:

| Store | Table | Key | Refreshed by | Executor route |
|---|---|---|---|---|
| Account integrations (GitHub, Google, Atlassian) | `integration_credential` | user, provider | the cloud, on read; no status | `POST /v1/integrations/:provider/credential` (read only) |
| MCP profile connections | `agent_profile_credential` | user, sha256(server URL) | the cloud, through discovery; records `needs-sign-in` | `POST`/`PUT /v1/agent-profile/credential` |
| Agent seats (Claude, Codex) | `agent_seat_credential` | user, provider | the CLI on the host, which writes back | host worker only: `GET /v1/orgs/:id/agent-seats`, `PUT /v1/agent-seats/:user/:provider` |

TypeSafe has no store. A new kind of credential needs a new table, route, and
client on both sides. The host vault (`packages/server/src/vault/vault.ts`)
already names every credential with one `CredentialRef`; the cloud should too.

## 1. Vocabulary

- **cloud vault** — the one solus-cloud module and table that hold a person's
  credentials: `src/lib/server/vault/`.
- **credential ref** — what a credential is for, the same type on both sides
  (`packages/contracts/src/vault.ts`):
  `{ kind: 'provider', provider: 'github' | 'google' | 'atlassian' }`,
  `{ kind: 'mcp', serverUrl }`, `{ kind: 'typesafe' }`,
  `{ kind: 'seat', provider: 'claude-code' | 'codex' }`.
- **ref key** — the canonical string of a ref, the table key: `provider:github`,
  `mcp:<sha256 of new URL(serverUrl).href>`, `typesafe`, `seat:claude-code`.
  One function, `refKeyOf`, in the contract.
- **material** — what is stored: `oauth` (a token and what refreshes it),
  `key` (a pasted key), or `cli-login` (a CLI's login file).
- **delivery** — what an executor receives for one use: never a refresh token.
- **executor** — a host or the Solus API acting for the person with their
  delegated token (ADR 0001 §2.2 rule 7).

## 2. Decisions

### 2.1 One table, one sealing

```
vault_credential(
  user_id     → user.id ON DELETE cascade,
  ref_key     text,             -- refKeyOf(ref)
  ref         jsonb,            -- the ref itself, for display (an MCP server URL)
  material    text,             -- 'oauth' | 'key' | 'cli-login'
  ciphertext  text,             -- seal(material JSON, ['vault', userId, refKey])
  version     integer,          -- +1 on every write by a person, an upload, or a write-back
  status      text,             -- 'connected' | 'needs-sign-in'
  label       text,             -- the account name the provider reported
  updated_at  timestamptz,
  PRIMARY KEY (user_id, ref_key)
)
vault_sign_in(id = sha256(state), user_id, ref_key, ticket_hash UNIQUE,
              authorize_url, verifier sealed, return_to, expires_at)
```

`authorize_url` is where the start page sends the browser (it holds no secret).
The sealed verifier also carries the ref, and for MCP the metadata address, since
an MCP server need not be in the person's profile. `return_to` is a page of the
website (the Connections page, the welcome data step); a sign-in an app started
has none and ends on a self-contained page.

- One sealing binding, `['vault', userId, refKey]`, with `INTEGRATION_VAULT_KEY`
  (a sign-in's verifier: `['vault-sign-in', userId, refKey]`).
- A refresh by the cloud does **not** change `version` (as the MCP store does
  today), so an upload's `expectedVersion` check stays meaningful.
- `integration_credential`, `integration_oauth_state`, `agent_profile_credential`,
  `mcp_oauth_state`, and `agent_seat_credential` are dropped.
- `mcp_oauth_client` stays: it holds the cloud's own registered client for each
  MCP server, not a person's credential. The migration empties it: every client
  was registered with the old callback, so each is registered again on first use
  (an owner-entered client is entered again).
- `status` is `needs-sign-in` also for a seat whose CLI login file was signed
  out (its tokens cleared after the provider refused a refresh).
- Every browser connect uses `vault_sign_in` with a ticket cookie (the MCP
  flow), so GitHub, Google, Atlassian, and MCP have one sign-in path.

### 2.2 One rule per ref kind

| Ref | Material | Connected by | Refreshed by | Uploadable by an executor | Delivered to |
|---|---|---|---|---|---|
| `provider:*` | oauth | the website (the cloud's OAuth app) | the cloud on read | no: a token belongs to the client that issued it | the person's executors |
| `mcp:*` | oauth or key | the website, or an executor upload | the cloud through discovery | yes | the person's executors |
| `typesafe` | key | the website (paste), or an executor upload | — | yes | the person's executors |
| `seat:*` | cli-login | a host login relay, or a host write-back | the CLI on the host | yes (write-back, `expectedVersion`) | the person's executors, and the host worker of their organizations' managed hosts |

Disconnect revokes at the provider where the kind has a revocation endpoint
(GitHub's grant API, Google's revoke endpoint, `mcp:*` OAuth; Atlassian publishes
none for 3LO), and notifies managed hosts for `seat:*`. An MCP upload is proved
first (a key by one `initialize`, OAuth by one refresh); a TypeSafe key is not
checked against TypeSafe.

### 2.3 One API

Executor routes (delegated bearer, `executorCaller`, no cookie):

| Route | Body | Answer |
|---|---|---|
| `POST /v1/vault/read` | `{ ref }` | 200 `VaultDelivery`; 404 `not_connected`; 409 `reconnect_required` |
| `PUT /v1/vault/credential` | `{ ref, material, expectedVersion, label? }` | 201 `{ version }`; 409 `{ error: 'credential_held', currentVersion }`; 422 `credential_refused`; 403 `not_uploadable` |

`VaultDelivery` is a union on the ref kind:
`provider` → the provider's access token and identity (today's `deliveryCredential`
shapes); `mcp` → `{ authorization, expiresAt, label }`; `typesafe` → `{ key }`;
`seat` → `{ file, version }`.

Account routes (account session or account token, `requireAccountSession`):

| Route | Use |
|---|---|
| `GET /v1/account/vault` | every connection's status: ref, status, label, updated |
| `POST /v1/account/vault/connect` `{ ref, auth? }` | start a browser sign-in: `{ kind: 'browser', url }`, `{ kind: 'key' }` for a ref that takes a pasted key, or `{ kind: 'none' }` for an open MCP server. `auth` is for an MCP server the person's profile does not name (a host probed it; public HTTPS only) |
| `PUT /v1/account/vault` `{ ref, key, scheme? }` | save a pasted key (`typesafe`, an MCP bearer key); `scheme` as for `auth` |
| `DELETE /v1/account/vault` `{ ref }` | disconnect |
| `GET /oauth/vault/start?ticket=`, `GET /oauth/vault/callback` | the one browser sign-in |

Host-worker routes (`isHostWorker`, the hosts token) — **seat refs only**:

| Route | Use |
|---|---|
| `GET /v1/orgs/:organizationId/vault/seats` | every member's `seat:*` file and version |
| `PUT /v1/vault/seats/:userId` `{ organizationId, ref, file, expectedVersion }` | a write-back after the CLI refreshed: 200 `{ version }`; 409 `credential_held`; 403 `not_a_member` |

The hosts token never reads a `provider`, `mcp`, or `typesafe` ref.

The Solus API (the record service in the cloud process) reads through the same
`Vault.read(userId, ref)` in-process: `useAccountCredentialSource` takes a ref and
answers the delivery or null (built in step 4). The pinned `record-service.cjs`
still calls `accountCredential(userId, provider, schema)`, which
`src/server/main.ts` adapts; when the record service is rebuilt from step 4,
`main.ts` passes `(userId, ref) => Vault.read(userId, ref)` (null on a vault
refusal) instead. The Lab does not build the record service from that source (its
Solus API reads the account over HTTP), so this is a release-time change.

Error bodies are `{ error, message? }` with the codes of `vaultErrorCodeSchema`
(`packages/contracts/src/vault.ts`); `credential_held` is
`{ error, currentVersion }`.

All new routes go into `SITE_API_ROUTES` (`src/server/routing.ts`) and
`routing.test.ts`. The old routes are removed.

### 2.4 Audit

Every connect, upload, write-back, and disconnect records `vault_credential_saved`
or `vault_credential_removed`, with the ref key; for MCP the subject is the
server's host, never the full URL. The ref key is the row's detail; the subject is
the ref key, or the MCP server's host. The row is written in the same transaction
as the write. `profile_connection_made` and `profile_connection_removed` are gone.

### 2.5 The host

- **One client.** The host vault's `account` location calls `POST /v1/vault/read`
  and `PUT /v1/vault/credential` for every ref. `vault.ts` loses its
  per-provider and MCP-only account paths.
- **Signed in means the account** (maintainers, 2026-10-14). The location rule
  in `access-model.md` §2.6 changes: the host's user uses the account when this
  host is linked to them (the host user has an account); the machine's host store
  only when it is not. A member always uses their account; a guest has none.
- **At sign-in (link):** the host uploads what it can (`mcp:*`, `typesafe`) and
  deletes its copies of everything, `provider:*` included. A `provider:*`
  connection is made again once on the website.
- **At sign-out (unlink):** the host keeps nothing for the person; they connect
  again on that machine. On a standalone server the unlink is the end of the
  registration (the account removed the host, or another copy superseded it);
  on the desktop it is also the sign-out.
- **Runtime logins** (seat files, `gh`, git, SSH) are unchanged
  (`access-model.md` §2.6). A managed host's seat files come from the
  host-worker seat routes above.
- The host worker (`host-worker/src/host-seats.ts`) uses the new seat routes.

## 3. Steps

Steps 1 to 3 are built (2026-10-14). As built in solus-cloud:

- `src/lib/server/vault/vault.ts` is one `Vault` class, constructed per call with
  the database and configuration, as the three stores it replaces were (not an
  Effect service). `providers.ts` (the provider OAuth apps), `mcp-clients.ts`
  (`mcp_oauth_client`), `mcp-identity.ts` (the `initialize` proof),
  `seat-logins.ts`, `sign-in-page.ts`, `connections-view.ts`, and `http.ts` (error
  to response) sit beside it. Migration `drizzle/0010_cloud_vault.sql`.
- The website signs in through `/oauth/vault/start` and `/oauth/vault/callback`
  with `return_to`, so each provider's OAuth app must register
  `<origin>/oauth/vault/callback` as its redirect.
- `POST /v1/agent-profile/read` answers `connections` as the vault's statuses
  (`VaultConnection[]`, step 4); the old `ProfileConnection` shape is gone.
- The Connections page lists TypeSafe as a pasted key.


1. **Contract** — `packages/contracts/src/vault.ts`: the ref schema, `refKeyOf`,
   material and delivery schemas, request and response schemas. solus-cloud
   imports it live through the `@solus/contracts` alias.
2. **Cloud vault** — `src/lib/server/vault/` (store, sealing binding, the rule
   table of §2.2, refresh per kind, revoke per kind, audit); the migration that
   creates the two tables and drops the five old ones; the executor, account,
   sign-in, and host-worker routes; the in-process read; remove the old modules
   and routes; the website's connections and agent-profile pages and the
   welcome steps use the account routes; tests.
3. **Host worker** — seat sync on the new routes.
Steps 4 and 5 are built (2026-10-14). As built in Solus:

- `packages/server/src/vault/vault.ts`: one client, `POST /v1/vault/read` and
  `PUT /v1/vault/credential`, for `provider`, `mcp`, and `typesafe` refs (the host
  reads no seat ref; the host worker does). The host's refs are the contract's;
  an MCP ref also carries the host's integration id, its host store key.
  `credentialLocationOf` is the one location rule. `settleLinked` (at the link,
  and again when the owner's personal delegation is made) uploads the TypeSafe
  key and deletes every host login; `forgetPerson` (at the unlink) deletes
  everything of the person's. The host keeps the TypeSafe key in the account's
  shape, `{ key }`.
- `host-user-rows.ts`: at the link, the MCP tokens move to the account key and
  `settleLinked` runs; at the unlink, the person's Local MCP connection rows and
  every host credential of theirs go. `boot-server.ts`: an ended registration
  is an unlink.
- The reconcile reads the vault statuses from `POST /v1/agent-profile/read` and
  uploads key and OAuth material with `PUT /v1/vault/credential`. A failed account
  read writes no status row for a connection the host never saw.
- `packages/contracts/src/integrations/profile-credentials.ts` is gone. Clients
  call `accountVault`, `accountVaultConnect`, `accountVaultSaveKey`, and
  `accountVaultDisconnect` (`/v1/account/vault`, client-core
  `agent-profile-requests.ts`); `cloudAccount().readAgentSeats()` reads the seat
  refs of `GET /v1/account/vault`.
- Settings: a signed-in person sees the account's status for GitHub, Google,
  Atlassian, TypeSafe, and MCP, and "Connect on your account"; a signed-out owner
  keeps the local flows. Mobile has a GitHub screen, MCP, and the host settings
  row; it has no Google, Atlassian, or TypeSafe settings.
- solus-cloud: `vite.config.ts` reads `SOLUS_REPO` (default `../solus`), and the
  profile read answers the vault statuses.
- Proof: the Lab's `vault` scenario (`packages/lab/README.md`). The Lab loads the
  cloud's provider fixture so a website GitHub sign-in completes; it cannot set
  the hosts token without moving managed hosts to Cloudflare, so the hosts token's
  seat-only rule stays proved by solus-cloud `seats.test.ts`.

4. **Solus host** — the one client; signed in means the account; upload and
   delete at link; nothing at unlink; Settings shows "Connect on your account"
   for `provider:*` and the account's status for the others; client-core
   (`agent-profile-requests.ts`, `cloud-account.ts`) on the account routes.
5. **Proof** — the Lab in cloud mode: `account-reads` and
   `profile-across-hosts` on the new API; a new `vault` scenario: a TypeSafe key
   uploaded at link reaches a second host; GitHub connected on the website reaches
   the person's host; the host's own copies are gone after link and nothing is
   left after unlink; the hosts token cannot read a `provider` ref.
