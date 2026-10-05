# 010 Standard OAuth for accounts, hosts, and the Solus API

Status: IMPLEMENTED (uncommitted), 2026-09-29; see §11. Workers support is not
proven yet. It replaces the credential design of plan 009
§4 (run authority, remembered grants, runner grants). The product rules of 009 do not
change: attachment, new root versus continuation, API admission before the provider,
agent tools that follow the record home, and the setup wizard.

## 1. Outcome

app.solus.sh becomes a standard OAuth 2.1 and OpenID Connect authorization server
(Better Auth `@better-auth/oauth-provider`). Every organization action is done as a
person, with that person's own tokens:

- A person signs in once to the app, with GitHub, Google, or email. Nothing else is
  visible to them.
- A client opens a host with the person's access token for that host.
- A linked host is a confidential OAuth client. The first time a person works on it
  for an organization, the host trades the person's token for its own delegated
  tokens (token exchange, RFC 8693). The host keeps the refresh token. Only that
  host can use it.
- A prompt carries no token and causes no call to app.solus.sh.
- The host refreshes about every 5 minutes, only while it has work for that person.
  The refresh is the one live check: is the person still a member, and is the host
  still attached to the organization.
- The Solus API and every host check access tokens offline against the JWKS of
  app.solus.sh. The API issues no tokens of its own for accounts.

Credentials we designed ourselves go: the host grant, the workspace grant, the
runner grant, the run authority, and the account branch of the API credential.

## 2. Accepted decisions (2026-09-29)

1. A person always starts organization work. Organization work always uses that
   person's own credentials. There is no machine identity that writes organization
   records (the runner grant goes).
2. An automation runs with the delegated tokens of the person who created it, on the
   host where it is scheduled.
3. Removal ends everything. When a refresh is refused, the host stops that person's
   runs and automations for that organization and deletes their output that is still
   waiting to be sent.
4. The access token is a JWT of about 5 minutes. The first-party token that a client
   dials a host or the Solus API with lives 8 hours: a host closes a socket when its
   token ends, and a short life dropped every connection every 5 minutes. A token
   cannot be revoked; its life is the limit. The refresh token rotates and has no fixed expiry; revocation and the live
   check at refresh end it.
5. Delegation is token exchange (RFC 8693), not a sign-in redirect on each host. The
   client connects to many hosts from one app, so a per-host redirect is worse UX
   (a popup on the web, a system sheet on mobile).
6. Users keep every sign-in method they have: GitHub, Google, email and password, and
   two-factor. The GitHub, Google, and Atlassian *connections* that agents use stay a
   separate token vault at app.solus.sh.
7. No compatibility layer and no migration of old credentials (maintainer decision
   for plans 007 to 010). Solus and solus-cloud release together; existing links link
   again.

## 3. Standard roles

| Party | Standard role | How it authenticates |
|---|---|---|
| app.solus.sh | Authorization server, OpenID Connect provider, token vault for connections | Better Auth, `oauth-provider`, `jwt` keys (the same JWKS URL hosts use today) |
| Desktop, CLI | Public clients | Device authorization grant (RFC 8628), as today, through the provider's `oauthDeviceAuthorization` |
| Web and mobile client (`apps/client`, served from app.solus.sh) | Public client | Authorization code + PKCE; silent because the person is already signed in on the same origin |
| Linked host (VM, self-hosted server, personal computer, managed host) | Confidential client and resource server | `private_key_jwt` (RFC 7523): the host makes a key pair at link time and registers its public key |
| Solus API | Resource server; confidential client for connections | Checks JWTs offline; uses token exchange to read a person's connections |

## 4. Tokens after the change

| Token | Standard | Issued by | Held by | Life | Audience |
|---|---|---|---|---|---|
| Account session | Better Auth session | app.solus.sh | browser, desktop main process | until sign-out | app.solus.sh |
| Access token (person) | JWT access token (RFC 9068) | app.solus.sh | client | 5 min | one host, or the Solus API (RFC 8707 `resource`) |
| Delegated access token | JWT, with `act: { sub: <host client id> }` | app.solus.sh | host | 5 min | the Solus API, connections |
| Refresh token (person or delegated) | OAuth 2.1, rotated, bound to the client | app.solus.sh | client, or host | until revoked or refused | — |
| Host client key | `private_key_jwt` | the host (public key registered at link) | host | until unlink | — |

Unchanged: the link code, the host token for link and tunnel management, the socket
ticket, pairing and host session tokens, guest tokens, and connection tokens.

Claims on every person token: `sub` (`user:<id>`), `organizationId`, `organizationRole`,
`teamIds`, `email`, `displayName`. Delegated tokens add `act` and the host id. The
claims come from `customAccessTokenClaims`, which reads the organization plugin
tables; the organization plugin does not add role or teams by itself.

## 5. Flows

**Sign-in.** Desktop and CLI: device code, approved in a browser where the person
signs in with GitHub, Google, or email. Web and mobile: authorization code + PKCE on
the same origin. Each client gets an access token and a rotating refresh token.

**Opening a host.** The client asks for an access token with `resource` = that host.
It presents it at `/auth/ws-ticket`, as it presents a host grant today. The host
checks the signature, the issuer, the audience (itself), and the expiry, then issues
the socket ticket. The principal comes from the claims, as `ticketForGrant` does now.

**First organization work for a person on a host.** When the person's turn is
admitted for organization O on an attached host, and the host holds no delegated
refresh token for (person, O), the host calls the token endpoint:

```
POST /oauth2/token
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<the person's access token for this host>
subject_token_type=urn:ietf:params:oauth:token-type:access_token
resource=<Solus API>   scope=offline_access organization:<O>
client_assertion=<private_key_jwt of this host>
```

Our grant handler (the only protocol code we own) accepts it when all of these hold:
the host client is authenticated and linked; the subject token is valid and its
audience is this host; the person is a member of O now; the host reaches O (shared,
or its managed organization); O's personal-host policy allows this host category. It
then calls `issueTokens` with the person as user and the host as client. The host
stores the refresh token in its secret store, keyed by (person, O).

**Each prompt.** The prompt travels on the socket. The host finds the delegated
tokens for (person, O) and uses the current access token for API admission, record
writes, delivery, and connections. No call to app.solus.sh is needed while the access
token is valid.

**Refresh.** When the access token has less than a minute left and there is work for
that person, the host refreshes. app.solus.sh refuses the refresh if the person left O,
the host left O, or the host was unlinked. The host then applies decision 3.

**Delivery.** Transcript, Insights, task, and work delivery use the delegated token
of the person who produced the output. Queued rows carry (person, O); the API's
runner routes take the principal from the token (`sub` and `act`), not from a runner
grant.

**Connections.** A host sends the delegated access token to
`/v1/integrations/:provider/credential`. The route checks the token and the `act`
host, and checks membership live, as `delegatedUser` does now. The Solus API gets a
person's connection by its own token exchange (client credential of the API), which
replaces `SOLUS_INTEGRATION_SERVICE_KEY`.

**Removal.** app.solus.sh revokes the refresh tokens of (person, O) at once and
refuses connections at once. The person's current access tokens still work until
they expire: 5 minutes for a delegated token, 8 hours for the first-party token a
client dials with. Token exchange checks standing live, so the person's tokens give
no new delegation. At the next refresh the host stops the work.

## 6. What changes, by file

Line counts are from the working trees on 2026-09-29; "~" means an estimate of part
of a file.

**solus-cloud**

| Area | Today | After |
|---|---|---|
| `src/lib/server/auth/create-auth.ts` (363) | `jwt`, `deviceAuthorization`, `bearer`, `organization` | Add `oauthProvider({ resources, customAccessTokenClaims, extensions })` and `oauthDeviceAuthorization`; remove `deviceAuthorization`; keep social sign-in, email, 2FA |
| `uplink/grants.ts` (202) | all grant claims and signing | Delete; claims move to `customAccessTokenClaims` (~60) |
| `uplink/hosts.ts` `issueHostGrant`, `issueWorkspaceGrant`, `issueRunnerGrant`, `issueRunAuthority` (~230) | four token issuers | Delete |
| Routes `v1/hosts/[hostId]/grant`, `runner-grant`, `run-authority` (~98) | token routes | Delete; `/oauth2/token` replaces them |
| `auth/device-clients.ts` (18) | device client list | Replace with registered public clients |
| New `auth/token-exchange.ts` | — | RFC 8693 grant handler on `extendOAuthProvider` (~150) |
| `uplink/hosts.ts` enrollment and attach | host token only | Also registers the host as a confidential client (`adminCreateOAuthClient`, its public key, `skip_consent`); unlink and delete also revoke the host's client and its refresh tokens |
| `integrations/authorization.ts` (86) | grant or run authority + executor token | Verify the delegated access token and `act`; keep the live membership check (~40) |
| `v1/workspace/guest-grant` | guest grant | Unchanged in this plan |

**Solus**

| Area | Today | After |
|---|---|---|
| `admission/host-grants.ts` (214) | our JWKS verifier and grant rules | `jose` `createRemoteJWKSet` + `jwtVerify` with issuer, audience, and claim checks (~50) |
| `transport/http.ts` `/auth/ws-ticket`, runner routes (~210) | grant verdicts, runner bearer | Access tokens; runner routes take the person principal from `sub` and `act` |
| `admission/workspace-credentials.ts` (97), `data/workspace/grant-receipts.ts` (17) | API credential exchange for grants and pairing tokens; grant replay store | The API accepts access tokens directly. The exchange stays only for paired devices (the desktop's local API). Delete the grant replay store |
| `sync/run-authority.ts` (162) | run authority minting | Replace with `host/delegation.ts`: token exchange, refresh, persisted refresh tokens by (person, organization), refusal handling (~150) |
| `sync/runner-delivery.ts` grant handling (~180) | one runner grant per organization | Token per (person, organization) from the delegation store; queued rows carry the person |
| `vault/account-integrations.ts` (77) | remembered grants and run authorities | Delegated access token from the delegation store (~30) |
| `execution/sessions/turn-organization.ts` | run authority per turn and answer | Delegation lookup; exchange only when none is held; a refused refresh ends the work |
| client-core `uplink-session.ts`, `uplink-account.ts`, `server-connection.ts`, `ws-transport.ts`, desktop `account/uplink-client.ts` (~210) | grant per connection | One OAuth client (PKCE, device grant, refresh) that asks for an access token per resource |
| client-core `device-authorization.ts` (123), desktop `account/account-session.ts` (252) | Better Auth device flow, bearer session | Same device flow through `oauthDeviceAuthorization`; stores OAuth tokens |
| `packages/contracts/src/uplink.ts` (725, copied to solus-cloud) | grant, runner grant, run authority schemas | Access-token claims schema; delete the three request/response schemas |
| `packages/lab/src/issuer.ts` (328) | fake grant issuer | Fake OAuth token endpoint (code, device, refresh, exchange) for tests |

Estimate: about 1,450 lines deleted and about 600 added, most of it configuration.

## 7. Stages

Each stage ends with its focused tests green in both repos.

**Stage 0: prove the provider (spike, no product change).** On a branch of
solus-cloud, upgrade `better-auth` to 1.7.6 and add `@better-auth/oauth-provider`
1.7.6. Prove each of these with a test, or record the fallback:

1. It runs on Workers with Hyperdrive and the current Drizzle adapter.
2. Resources can be added per host at link time, so a host token's `aud` is that host.
   Fallback: one host audience plus a `host_id` claim that the host checks, and an
   exchange rule that the subject token names the requesting host.
3. A refresh can be refused by our live check (a `before` hook on the token endpoint,
   or the claims callback). This is required; without it decision 3 cannot hold.
4. Claims added at exchange (`act`, organization) are present again after refresh
   (from a `claims.accessToken` contributor keyed on the host client).
5. `oauthDeviceAuthorization` replaces the current device flow for the desktop and the
   CLI client ids.
6. The `jwt` plugin keys sign the access tokens, so the JWKS URL does not change.

**Stage 1: the authorization server.** Configure the provider, register the public
clients (desktop, CLI, web), add `customAccessTokenClaims`, and write the
token-exchange handler. Enrollment and attach register the host client; unlink and
delete revoke it. Tests: exchange accepted for a member on an attached host; refused
for another host's subject token, a non-member, an unattached host, a disallowed
personal host, and a wrong client key; the refresh token works only for its host;
rotation reuse is detected; refresh is refused after removal, detach, and unlink.

**Stage 2: hosts and the API accept access tokens.** Replace the verifier; open
sockets with access tokens; the API admits access tokens directly; runner routes take
the person from the token. Delete the grant replay store and the grant branch of the
API exchange. Tests: wrong audience, wrong issuer, expired token, a token without
`act` on a runner route, and a delegated token for another organization are all
refused.

**Stage 3: delegation on the host.** `host/delegation.ts` with persisted refresh
tokens; turn admission, answers, agent tools, delivery, and connections use it.
Delete `sync/run-authority.ts` and the runner-grant code. Tests: two prompts cause one
exchange and no other call to app.solus.sh; a refresh happens only when work needs
it; a restarted host resumes an automation with the stored refresh token and no
turn; a refused refresh stops runs, pauses the person's automations for that
organization with a visible reason, and deletes their queued output, while another
person's output on the same host is kept.

**Stage 4: clients.** One OAuth client in client-core for desktop, web, and mobile;
the desktop and CLI keep the device flow; the web and mobile client use code + PKCE.
Delete per-connection grant fetching. Check each surface: sign in, open a personal
host, open an organization host, send a prompt, sign out.

**Stage 5: remove the rest and document.** Delete the old contract schemas, the old
routes, and the fake grant issuer; update `docs/api/README.md`, plan 009 §4 and §9,
the codebase map, and the setup docs. Run `bun run contracts:sync` and the full
focused suites in both repos, SQLite and Postgres.

## 8. Open items

- **Host token.** This plan keeps the host token for link, tunnel, and standing
  routes. The host's OAuth client could replace it later (client credentials for the
  host's own calls). Recommended as a follow-up, not part of this plan.
- **Guests.** Guest grants stay. Moving them to the provider is possible but not
  needed for the outcome.
- **DPoP.** Not in this plan. The refresh token is already bound to the host client;
  DPoP would also bind the access token. Add it if a copied 5-minute access token is
  a real risk.
- **Token exchange upstream.** Better Auth issue #8023 tracks RFC 8693. When it ships,
  replace our handler with it.
- **Workers support** is inferred from the provider's source, not documented. Stage 0
  proves it.

## 9. Stage 0 findings and the concrete protocol (2026-09-29)

Read from `@better-auth/oauth-provider` 1.7.6 source, installed with `better-auth` 1.7.6.

- **First-party apps keep Better Auth sign-in.** `oauthDeviceAuthorization` cannot run
  with `deviceAuthorization`, and its own documentation keeps first-party device
  login on `deviceAuthorization` and `/device/token`. So the desktop and the CLI keep
  the device flow and the Better Auth session; the web keeps its cookie. This
  replaces the client part of §3 and Stage 4.
- **First-party tokens come from the account plane (token-mediating backend).**
  `POST /v1/hosts/:hostId/access-token` (the account session authenticates it)
  checks access as the host grant did, then mints through the provider's
  `issueTokens` for the first-party public client `solus-app`. The result is the
  same OAuth JWT access token everything else uses: one format, one JWKS, one
  issuer. `hostId` may be a Solus API id (`workspace:<org>`), which gives a
  token for the Solus API with that organization.
- **Resources (RFC 8707)** are rows (`oauthResource`), made at run time:
  `urn:solus:host:<hostId>` for each host (made at enrollment, removed with the
  host), `urn:solus:api` for the Solus API, `urn:solus:account` for the
  account plane's own routes that hosts call (connections).
- **Host clients.** Enrollment registers the host as a confidential client
  (`client_secret_basic`; secret returned once, stored by the host like its host
  token; client metadata names the host). Unlink and delete remove the client.
- **Token exchange** is an extension grant. It authenticates the host client, reads
  the subject token with `validateAccessToken`, requires its audience to be this
  host, checks membership, attachment, and policy, then calls `issueTokens` with the
  person, `offline_access`, resources `[workspace, account]`, and `referenceId` =
  the organization.
- **Claims survive refresh.** The refresh token keeps `referenceId` and the client.
  An access-token claims contributor derives `organizationId`, `organizationRole`,
  `teamIds`, `act`, and `host_id` again on every issue, and on `refresh_token` it runs
  the live check (member now, host linked and reaching the organization). A refusal
  is `invalid_grant`, raised before the refresh token rotates.
- **"No expiry" refresh tokens.** Rotation sets `expiresAt` to issue time plus the
  lifetime, so a long lifetime rolls forward on every use; revocation and the live
  check end it.
- **`sub` is the user id** in provider tokens (the provider owns `sub`); guests keep
  their `guest:` subject. Runner (`host:`) subjects go.
- **Delivery keeps a person per row.** `outbox_ops`, `runner_session_reports`, and
  `mirror_log` get `actor_user_id`: the owner of the session the row came from, or
  the publisher. The API's `runner_cursors` key adds the person, because rows of
  different people interleave in one organization's sequence.
- **Workers support** is still inferred, not proven: it needs a build or a deploy.

## 10. Verification rules

Use the isolated test runner and disposable data (`bun scripts/test-unit.ts <filters>`;
solus-cloud Vitest with PGlite). Never touch live Solus data or real provider
credentials. Do not run `bun run build`. Solus and solus-cloud must pass their focused
suites in the same change, and the contract copy must be identical.

## 11. What was built (2026-09-29)

No compatibility: old grants, the runner grant, and the run authority are deleted, not
kept beside the new tokens.

**solus-cloud**

- Better Auth and `@better-auth/oauth-provider` 1.7.6. `auth/oauth.ts` configures the
  provider (resources `urn:solus:api` and `urn:solus:account`, host resources on
  demand, no dynamic registration, hashed client secrets, 300-second access tokens (8 hours for the first-party mint),
  refresh tokens with no practical expiry, rotated on use) and the server-only
  first-party mint (`issueSolusAccessToken`), which the token-mediating routes call
  with the person's Better Auth session.
- `auth/token-exchange.ts`: the RFC 8693 grant (host client with `client_secret_basic`,
  subject token for this host's resource, `organization_id`) and a claims contributor
  that adds the membership facts and `act` again at every refresh. A refresh whose
  standing fails answers `invalid_grant`.
- `auth/host-access.ts` `delegationStanding`: linked, member, organization policy for
  personal machines, and the host shared with the organization **or owned by the
  person** (organization-scope §6: a person's own laptop delivers their Insights and
  publications without sharing the machine).
- `auth/host-clients.ts`: enrollment registers `host_<hostId>` and returns its secret
  (`oauthClient`); unlink and delete remove the client, and its tokens go with it.
- Routes: `v1/hosts/[hostId]/access-token` replaces `grant`; `runner-grant` and
  `run-authority` are deleted; the connection credential route takes `{ accessToken }`
  and admits delegated tokens through `delegationStanding`.
- Migration `0010_oauth_provider.sql` (OAuth tables; drops `account.issuer`, which
  Better Auth 1.7 removed).

**Solus**

- Contracts (`uplink.ts`): `accessTokenClaimsSchema` (`aud` string or list, `client_id`,
  `act`), `hostAudience`, `ACCOUNT_AUDIENCE`, `tokenEndpoint`, the exchange constants,
  `oauthClient` on enrollment, the access-token route schemas. The runner grant and
  run authority schemas are deleted. `sub` is the user id; a guest keeps `guest:`.
- `admission/access-tokens.ts` replaces `host-grants.ts`: JWKS verification, audience
  check, lifetime at most 8 hours (10 minutes for a guest grant), nothing spent.
- `sync/delegations.ts` replaces `run-authority.ts`: one delegation per person and
  organization, exchanged once with the token the person's client presented
  (`vault/account-integrations.ts` remembers it; on the desktop the owner's token
  comes from the account session), refreshed within a minute of its end, persisted in
  the secret store. A refused refresh stops the person's sessions, drops their queued
  rows, and pauses their automations.
- Delivery: `outbox_ops`, `runner_session_reports`, and `mirror_log` carry
  `actor_user_id`; each (organization, person) queue is sent with that person's token;
  a person with no delegation here waits, a refused one is dropped. The API's
  `runner_cursors` key includes the person. Migrations: SQLite `0019_delivery_actor`,
  Postgres `0008_delivery_actor`, and the local migration in `db/migrations.ts`.
- The runner routes accept only delegated tokens; the runner principal is the host in
  `act` acting for `sub`. The record API maps a delegated token to the member and a
  `delegation: { hostId }` context; session admission requires it.
- Automations record the creator's user id, so a refused refresh pauses that person's
  automations. Automation sessions stay Local, so they deliver nothing to an
  organization themselves.
- Clients (client-core, desktop main and preload) call the access-token route.
- The Lab issuer answers the token endpoint (exchange and refresh) and issues host
  clients; runner scenarios connect the owner through the tunnel so the runner acts
  for her.

**Verification**

- solus-cloud: Vitest 33 files, 220 tests, including `auth/oauth.test.ts` with the
  real provider on PGlite; `svelte-check` clean.
- Solus: the focused suites for admission, delegation, delivery, intake, publication,
  mirrors, API mode, and the organization VM flow pass on SQLite. The Lab typechecks; its
  scenarios need a standalone build and were not run.
- Not proven: Better Auth's provider on Cloudflare Workers (needs a deploy).

