# Simplify auth, admission, connection, and sync

Status: implemented 2026-10-23 (both repositories, not yet deployed). Changes ADR 0001 (§2.2 rules, §3, §5) and replaces
parts of `instant-share-open.md` §4.2–4.4, `host-reach.md` §3.1, and
`cloud-service-model.md` §16. Covers this repository and solus-cloud.

## 1. Problem

Opening a shared session took four passes to make fast, and each pass found the
same pattern: a second or third mechanism beside the first, not in place of it.

- Every access token of a client came from a refresh that rotates the grant: one
  rotation per resource (account, API, each host). A rotation is 5–6 database
  waits in Better Auth, and a replayed refresh token ends the grant, so a client
  ran its refreshes one at a time across every tab. Four resources waited in one
  queue.
- The account site's database pool had `prepare: false` (left over from
  Hyperdrive), so every query with parameters was two network round trips. Fixed
  2026-10-23 (`instant-share-open.md` §4.5).
- A principal can be admitted eight ways. Every token path signs a ws-ticket and
  spends it at once in the same process, only to build a principal.
- Five functions answer "can this person reach this host", and they disagree:
  the directory lists personal hosts a member then gets no token for
  (`reachableBy` ignores `allowPersonalHosts`), and `delegationStanding` treats
  the creator of a managed host as its owner (`hostReach` does not).
- A host sends to the Solus API on three routes with three schemas, three
  cursors, and three acknowledgements over one queue, and sends on every write:
  one request per second in production.
- Mobile copies `ServerConnections` line for line, and the copies drifted.

## 2. Decisions

- **No backward compatibility.** No dual paths, no data migration of tokens or
  queues. Every person signs in again once; every host makes its delegation again.
- **LAN pairing stays** (pair code, pairing session token, `/auth/refresh`). It
  moves onto the shared signed-token code.

## 3. Rules

1. **A client holds one grant.** One rotating refresh, about once an hour, gives
   one token for our own servers: `aud: [account, api]`.
2. **A token for a host is an exchange.** A person's client presents its token
   for our servers, or a host presents its delegated token, and names one host.
   The answer is that host's token. No rotation, no queue: tokens for several
   hosts are minted at the same time. One claims builder, one reach rule.
3. **Hosts keep their delegation**: their own refresh, for work done while the
   person is away, checked against the grant at every refresh.
4. **A socket has one credential, in its handshake**: an access token, a pairing
   session token, or a share secret with the guest's name. The server builds the
   principal from it directly. No internal tickets.
5. **One reach function** answers who reaches which host, through which
   organization, for tokens, the directory, and delegations alike.
6. **A host delivers to the Solus API on one route**, `/runner/deliver`: one
   queue, one cursor, a collect window of about one second, one transaction for
   each batch.
7. **One host link on every client**: web, desktop, and mobile share one
   client-core implementation of routes, dialing, and status.

## 4. Changes

### 4.1 Tokens (solus-cloud `auth/`, client-core `oauth-session.ts`)

- `signInTokenClaims`: accept `[account, api]` in one request; drop the
  `one_resource` refusal. API claims as today (`organizations[]`).
- One host audience, `host:<id>`. The host-reach audience goes; its exchange
  becomes the general host exchange in `token-exchange.ts`, with one claims
  builder for a person's client and for a delegation. A host token lives one
  hour either way (the eight-hour host-reach life existed because it had no
  cheap renewal).
- Delete the Solus API's OAuth client (`registerSolusApiClient`,
  `solus-api-key.ts`, `solusApiClientKey`, the `solus-api` actor and its
  exchange branch): its account token is now part of rule 1.
- Delete `client-resources.ts` linking (every host client to every host),
  `ensureHostResources`/`registerHostResource` for reach audiences, and the
  `StableResources` prefix rule. Keep `enforcePerClientResources` only if the
  remaining resources still need it; the claims hooks enforce reach.
- Remove the Better Auth `refreshResources` patch if a test shows a refresh for
  `[account, api]` keeps both resources without it.
- `OAuthSession`: `serversToken()` (refresh, under the existing cross-tab lock)
  and `hostToken(hostId)` (exchange, no lock, no queue, cached per host until a
  minute before its end). Delete `renewalTimers`/`scheduleRenewal`, the `fresh`
  option, `refusals` counting, and `GrantSharing` for host tokens.
- Web boot: delete `requestFirstToken` and the runner pre-mint
  (`apps/client/src/main.ts`); keep dialing the runner first.

### 4.2 Admission (`packages/server/src/admission/`, `transport/`)

- `ticketForGrant`, `ticketForShareSecret`, `ticketForDelegatedMember`, and
  `hostReachTicketFor` become one `principalForClaims(claims, organizationId)`
  plus `guestPrincipalFor(secret, guestId, displayName)`, returning a
  `Principal`. Device-revocation and replay checks move into them.
- Delete from `auth.ts`: ticket interfaces, payload schema, sign, issue, verify,
  consume, and `GrantMembership`. `AdmissionEvidence` becomes
  `Principal | 'credential-free'`.
- Delete `/auth/ws-ticket` (server and `exchangeForTicket` in client-core), the
  runner tickets nothing accepts, `CREDENTIAL_REFUSED`, and
  `WorkspaceCredentials` (the second bearer from `/v1/auth/session`): an API
  token admits HTTP callers directly.
- `local-owner` and `remote-owner` become one `owner` with `via: 'local' | 'grant'`.
- Pairing moves onto `signed-token.ts`; delete its own HMAC code, the legacy
  revoked-devices format, and `pairToken ?? code`.
- Move admission out of `http.ts` into `admission/doors.ts`.

### 4.3 Reach (solus-cloud `host-access.ts`, `uplink/hosts.ts`)

- One `reachOf(db, { userId, hostIds?, organizationId? })`: one query over
  `host`, `host_organization`, `member`, and the host policy, returning for each
  host whether the person owns it and the memberships it is allowed through.
  `hostReach`, `delegatedHostReach`, `delegationStanding`,
  `hostReachesOrganization`, `reachableBy`, and `managedRowFor` read it.
- Fix the two disagreements: the directory lists only hosts a token would be
  given for; only a personal host has an owner.
- `readDelegatedDirectory` reads every host in one call (no N+1).
- Drop `managed_host.organization_id`; the organization is the `via = 'managed'`
  row of `host_organization`.
- One membership reader replaces the 13 `from(member)` queries.

### 4.4 Connection (client-core, `apps/client`, `apps/mobile`)

- One `HostLink` in client-core: transport, supervisor, route choice, facts.
  `ServerConnections` (web, desktop) and mobile `host-connections.ts` use it.
- One route policy: `chooseRoute` (all routes probed in parallel) before each
  dial, and a short socket connect timeout. Delete round-robin `advanceRoute`
  redials, `HANDSHAKE_ANSWER_MS`, and `dialSerial`.
- The guest's mirror is one more route; delete `HOST_DIALS_BEFORE_MIRROR` and its
  eight-second timer.
- One token timer for each socket (present a new token before `exp`).
- One status source, `HostPhase`; delete `connection-state.ts` and the duplicate
  web state.
- Delete migration-only code: old workspace-service rows in `loadServers`,
  `savedServerRoutes` for hosts saved before Uplink.
- `tests/benchmarks/cloud-connect.ts` dials through `chooseRoute`, as production
  does.

### 4.5 Sync (`packages/server/src/sync/`, `sharing/`, `data/sessions/`)

- One `/runner/deliver` route with `items: [{ seq, kind, payload }]`, one cursor
  for each (host, actor), and a collect window of about one second before a send.
  The API applies a batch in one transaction with one cursor write. A permanent
  failure skips and names its item; a transient one stops the batch.
- Delete the cloud outbox: the six queued writes (task comment, link, link
  session, link PR, session link, worktree) call the Solus API directly, as task
  and work creation already do.
- The session record is written when the API admits the session; status and
  title travel as coalesced items in the same stream. Delete
  `runner_session_reports`, `deliverSessionReport`, and the ten-second wait in
  `remote-operations.ts`.
- Share rows go only when they change, not again with each transcript.
- Insights go once for each turn, as one item.
- As built (cut C): the host's one queue is `delivery_queue`; the item kinds are
  `session`, `transcript`, `activity`, `shares`, and `insights`. An agent's
  organization writes call the Solus API: `PUT /v1/links` and `DELETE /v1/links`
  (body `{ from, to, title?, role?, originSessionId? }`, one rule for each pair in
  `data/links/api-operations.ts`) carry task links, task sessions, session item
  links, and session pull requests; `POST /v1/tasks/:taskId/comments` carries a
  task comment.

### 4.6 Update required

- Removed 2026-10-23. `SOLUS_PROTOCOL`, the `solus-protocol` header, and the
  `update_required` answer are gone: Solus keeps no backward compatibility, so
  clients, hosts, and the cloud ship together and need no version check.

### 4.7 Structure

- Split solus-cloud `uplink/hosts.ts` (1,383 lines) into registration,
  directory and reach, owner operations, and host-control routes.
- `/v1` routes by resource, not by caller: one vault route, one agent-profile
  route, one seats route, now that one token shape reaches each.

### 4.8 Delegations are rows (2026-10-24)

A host's delegation for a person was its own rotating refresh token: 9 queries in 8
waits for each token (Better Auth's confidential-client refresh), a lock that serialized
refreshes, and refresh tokens in the host's secret store. Now the exchange makes a
`host_delegation` row (host, person, scope, grant) and the host asks for each token with
its control token at `POST /v1/hosts/:hostId/delegation-token`: one statement, one wait.
The host keeps only whom it acts for (`delegations.json`, no secret). The live checks of
a host's call for a person (grant, standing, row) are one statement, and a host's vault
read runs them beside the credential read: one wait. Migration `0014_host_delegation`
deletes every host refresh and access token; each host makes its delegations again.

## 5. Data reset

At deploy, with no conversion:

- solus-cloud: delete every OAuth refresh token and delegation; drop host-reach
  resource rows and `oauth_client_resource` links; drop the Solus API client;
  drop `managed_host.organization_id`.
- Solus API and hosts: drop `runner_session_reports`, the cloud columns of
  `outbox_ops`, and the three runner cursors; create the delivery queue and
  cursor. Each host sends its session records once at boot.

## 6. Order

| Cut | Contents | Repositories | Depends on |
|---|---|---|---|
| A | Reach (§4.3), with its two fixes | solus-cloud | none |
| B | Tokens, admission, connection, update required (§4.1, §4.2, §4.4, §4.6) | both | A |
| C | Sync (§4.5) | solus | none; can run beside B |
| D | Structure (§4.7) | solus-cloud | B |

Each cut is one pull request, deployed with its data reset.

## 7. Proof

Each rule has a test that fails when the rule breaks:

1. A refresh returns one token whose `aud` is `[account, api]`; both servers
   admit it.
2. Tokens for three hosts are minted at the same time with no refresh; a person
   who cannot reach a host gets no token for it; a sign-out refuses the next
   exchange.
3. A delegation refresh is refused after its grant ends.
4. A socket admits each credential kind from its handshake alone.
5. For every host and person in a fixture, the directory lists a host if and
   only if the exchange gives a token for it; a managed host's creator is not its
   owner.
6. Ten writes within the window go in one request; a permanent failure skips
   one item and delivers the rest.
7. Web and mobile run the same `HostLink` tests.

Database waits are measured as in `instant-share-open.md` §4.4 before and after
cut B, and production is tailed after each deploy.

## 8. What this removes

About 2,500–3,000 lines, most of them in `auth.ts`, `http.ts`,
`workspace-credentials.ts`, `ws-transport.ts`, `server-connections.ts`, mobile
`host-connections.ts`, `runner-delivery.ts`, `runner-intake.ts`,
`outbox-store.ts`, `token-exchange.ts`, `client-resources.ts`, and
`host-access.ts`. Three things added on 2026-10-22 and 2026-10-23 go with it:
the background renewal timers, `cachedHostRoutes`, and the ticket fallback for
older hosts.
