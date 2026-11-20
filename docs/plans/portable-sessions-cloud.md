# Portable sessions phase 3 design

Status: proposed design for phase 3 and phase 5 of docs/plans/portable-sessions.md, 2026-11-18. Not implemented.

Date: 2026-11-18. Read-only investigation. No file in Solus or solus-cloud was changed.

Sources: Solus checkout `solus/portable-sessions` (paths below are relative to it; `S/` means `packages/server/src/`) and `/Users/sidhu/solus-cloud` (paths start with `solus-cloud/`).

Marks on each claim:

- **V** — I read the lines.
- **VA** — a read-only subagent of this session read and quoted the lines. I did not open the file.
- **I** — inferred. The text says from what.

---

## Summary

### The recommended design in ten lines

1. **Cloud scope.** Publication decides where a session repository lives in the cloud. A published organization session uses `organization:<organizationId>`. Each other session of a signed-in person uses `person:<accountId>`. The Solus API computes the repository name, `session-<48 hex of sha256([cloudScope, sessionId])>`. A host never names a cloud repository.
2. **One new table on the Solus API,** `session_repositories`, with the key `(cloud_scope, session_id)`. It holds the owner, the repository name, `head`, `synced_turn`, `last_run_host_id`, `running_host_id`, and a small list card. It is the one owner of the four record fields in the cloud.
3. **The token route is in the Solus repository,** in the record service, at `POST /runner/session-repositories/token`. solus-cloud already sends `/runner/*` to the record service. The route has its own admission, as `/runner/deliver` has. It accepts the organization delegation, and (new) the personal delegation. It gives a 15-minute Artifacts token for one repository: scope `write` for a push, scope `read` for a fetch.
4. **Push.** The host pushes directly from the local bare copy: `git push --force-with-lease=refs/heads/main:<remote head> <url> <commit>:refs/heads/main`, with the token through askpass. There is no scratch repository. A push queue separate from the commit queue. New columns in `session_storage` hold the state.
5. **Fetch.** A second source behind the `fetchBundle` seam: `git fetch` from Artifacts into a temporary bare repository. `SessionSync` gets one more argument (the wanted head) and no other change. A host that can act for the person uses Artifacts first. The last run host is the fallback for turns that are not pushed.
6. **Head report.** After a confirmed push the host posts `head` and the turn count to `POST /runner/session-repositories/head`. The API accepts a larger turn count only, and broadcasts `session.headChanged`. At turn start the host posts `running` and does not wait.
7. **Clients.** `WorkspaceSession`, `SessionRecord`, and `SessionMeta` get the four fields. The list is: the records of connected hosts, plus the cloud entries of sessions that no connected host has (`GET /v1/me/sessions`).
8. **Refused push, first version.** The host stops the push for that session, keeps its turns, refuses new prompts for that session with a typed reason, and offers Fork. No automatic fork in phase 3.
9. **Read-only open (phase 5).** The Solus API reads `manifest.json`, `rows/<n>.jsonl`, and `diff/<n>.patch` from Artifacts at the recorded head with the REST file read. The rows are the projected wire rows (no tool result bodies). The API serves them through the history RPC names it has, plus one diff method.
10. **Gate.** One host setting and one new policy key (`sessions.limits.sessionCloudSync`). Organization work fails closed when its policy is not available.

### Decisions the maintainers must make

| # | Decision | Recommendation |
|---|---|---|
| D1 | Which cloud scope holds a session that is not published (all sessions born on a personal machine today)? | `person:<accountId>`, reached with the personal delegation. Do not put it in an organization: an invited person's only organization is their employer's (answer 1). |
| D2 | Does the home of such a session change to the Solus API when the person is signed in (plan §9), or stay on its machines? | Phase 3: the home stays on the machines. The cloud holds only the four facts and a list card. A full home on the API (archive, snooze, settle, pull requests under a person scope) is a later phase. This conflicts with plan §9 as written; see answer 5. |
| D3 | May a host that is not the person's own (a managed host, a shared personal host) get a token for a `person:` repository? | Phase 3: no. Only a personal delegation opens a `person:` repository. Phase 4 adds an explicit grant that the person's client makes when it selects the host in Run on (answer 1). |
| D4 | Which standing gets a token for an `organization:` repository? | `edit` on the session (the check of `admitSessionTurn`), for read tokens and write tokens. A repository holds tool result bodies and code that is not committed; `read` is too wide (answer 2, answer 7). |
| D5 | Is the upload on by default with no gate? | Default on for a signed-in person, as the plan says, but with a host setting to turn it off and the policy key `sessions.limits.sessionCloudSync` that an organization or an MDM policy can lock to `false`. Ship hosts that know the key before a console can set it (answer 7). |
| D6 | One Artifacts namespace or more? | One namespace for sessions for each environment, separate from works (`SOLUS_SESSION_ARTIFACTS_NAMESPACE`), with `storage_scope` saved on each row as works do. Not one namespace for each organization. |
| D7 | The refused push: automatic fork (plan §7.3) or a stop? | A stop with Fork as the person's action in phase 3. Automatic fork comes with the phase 4 UI (answer 3). |
| D8 | Do the rows in a turn commit hold tool result bodies? | No. Store the projected rows (`WireSessionLoadMessage`). The bodies are in the thread files already. This keeps the 2026-09-19 rule for every reader that is not a run host (answer 6). |
| D9 | Retention and delete of cloud session repositories. | Not decided anywhere. Decide before default-on ships to all accounts: at least delete with the account, and a size cap for each repository (answer 4, answer 7). |
| D10 | Raise the phase 2 gate of `sessionRepositoryBundle` from `read.transcript` to `drive.prompt`? | Yes. Today a reader gets the full bodies through the bundle, but not through the history RPC (answer 7, item 9). |

### The biggest risk

**No Artifacts limit is known.** No file in either repository states a limit for a file, a push, a repository, a request time, or a rate. The first push of a long session holds the full provider transcript as one blob (`threads/<threadId>/<key>/0`), which can be hundreds of megabytes. The vendored Cloudflare types show a `MEMORY_LIMIT` error on file reads and imports (solus-cloud `cloud-worker/node_modules/@cloudflare/workers-types/index.d.ts:12605, 12635, 12749`, **V**). Plan test 5 (push 300 MB) was not run (`docs/plans/portable-sessions.md:617`, **V**). If a large blob cannot be pushed, the layout of `threads/` must change (split large ranges into parts) before any host code ships. Run the measurement of answer 4 first.

The second risk is the privacy default: phase 3 uploads full transcripts and code that is not committed, and three documented rules that the plan does not list say that sign-in publishes nothing (answer 7).

---

## 1. Identity and organization of a session's repository in the cloud

### 1.1 What exists

**The organization of a session.**

- On a personal machine a new session takes the organization of the sending window once, or stays `local` (`admitOnPersonalMachine`, `S/execution/sessions/turn-organization.ts:228-234`; `wantedOrganization`, `:258-264`). **V**
- The assignment publishes nothing: "It is a fact about the session, not its home and not a share; only publication makes it organization work" (`turn-organization.ts:37-43`). `isOrganizationWork` is `organizationId !== 'local' && publication === 'published'` (`S/data/sessions/session-records.ts:253-255`). **V**
- A session is born published only on a machine attached for organization work, after the Solus API admitted it (`admitOnAttachedMachine`, `turn-organization.ts:140-175`; `published: true` at `:174`). **V**
- `markSessionPublished` has no caller outside tests. **VA**. So today no session that was born on a person's laptop is published.
- The local repository name is fixed at the first ended turn from the organization of that moment (`S/sync/sessions/session-archive-writer.ts:133-134`; the organization comes from `rt.turnOrganization` in `archiveTurn`, `S/execution/sessions/run-lifecycle.ts:257-275`). A later assignment does not rename it. **V**

**The Solus API.** There is one Solus API for all organizations.

- "one Postgres serves every organization" (`S/host/api-mode.ts:14-15`). **V**
- A host calls the API that its registration names: `Delegations.apiClient` reads `registration.apiUrl` (`S/sync/delegations.ts:243-255`). **V**
- Production: `SOLUS_API_URL` is `https://app.solus.sh` (solus-cloud `cloud-worker/wrangler.jsonc:25`, **V**). One container runs the account site and the record service (solus-cloud `CLAUDE.md:7-15`, `docs/deploy-cloudflare.md:69-73`, **VA**).

**Delegations.** A delegation lets a host act for one person in one scope: `'personal'` or `{ organizationId }` (`packages/contracts/src/uplink.ts:1050`; `S/sync/delegations.ts:26-47`). **V**

- A connection of the owner always makes the `personal` delegation, and also the delegation of the organization the connection works in (`delegationScopesFor`, `delegations.ts:478-482`). **V**
- The host asks the account plane for a token for each use: `POST /v1/hosts/{hostId}/delegation-token` with its control token (`delegations.ts:333-358`). The token lives 3600 s (`uplink.ts:1054`). The resource can be the Solus API (`{ kind: 'api' }`, `delegations.ts:182-191`). **V**
- **The personal delegation.** In solus-cloud the exchange accepts `delegation_scope: 'personal'` (`src/lib/server/auth/token-exchange.ts:76`). It is given only when the host kind is `personal` and the person owns the host (`src/lib/server/auth/delegations.ts:171-177`). Its claims are `{ access: 'owner' }` with no organization (`delegations.ts:192-193`). The exchange answers a token for the audiences of the Solus API and the account plane (`token-exchange.ts:177`). **V**
- Uses of the personal delegation today: the owner's reach to their other hosts (`ownerReach`, `S/boot-server.ts:1110-1113`; `S/execution/orchestration/remote-hosts.ts:193, 213`) and account reads. "A personal delegation carries no session" (`delegations.ts:266-270`). **V**
- **The Solus API refuses the personal delegation today.** `principalForClaims` answers `member-required` when a delegated token is not `org-member` and the place is `api` (`S/admission/doors.ts:68-69`). The runner route refuses it with the log reason `personal-delegation` (`S/transport/runner-routes.ts:42-45`). `/v1` gives a home only to an `org-member` or a guest (`S/transport/solus-api/admission.ts:18-25`). **V**
- The owner of a personal host gets an organization delegation for each organization they are a member of. The checks `host_not_in_organization` and `personal_hosts_not_allowed` do not apply to the owner (solus-cloud `delegations.ts:176-182`). **V**

**Personal workspace.** It does not exist.

- Sign-up makes an ordinary first organization named "<first name>'s organization" (solus-cloud `src/lib/server/new-organization.ts:9-14, 52-55, 65-77`; called from `src/lib/server/auth/create-auth.ts:244`). **V**. A person who signs up with an invitation gets none of their own and joins the inviter's organization (`new-organization.ts:9-14`). **V**
- The `organization` table has no kind or personal column (solus-cloud `src/lib/server/db/schema.ts:132-154`). **VA**
- The directory lists "one entry per organization the caller belongs to" (`docs/plans/workspace-and-machines.md:178`). **V**
- "the Solus API refuses a person with none" (solus-cloud `src/lib/server/auth/sign-in-clients.ts:207-209`). **V**

So plan open decision 2 ("every account has a workspace on the Solus API", `docs/plans/portable-sessions.md:539-540`) is not true as a personal workspace. Each account is in one organization or more, but that organization can be an employer's.

### 1.2 What phase 3 can push with what exists today

| Session | Delegation the host holds | Record on the API | Push possible today (with the new route only) |
|---|---|---|---|
| Published organization session (attached machine, managed host) | Organization delegation of the session owner (`deliveryActorOf(record.ownerKey)`, `S/sync/delivery-queue.ts:83-85`, **V**) | Yes (`session_records`, by admission and runner delivery) | **Yes** |
| Organization assigned, not published (personal machine, window had an organization) | Organization delegation of the owner, and the personal delegation | No | Only into the organization scope, which the rules forbid (it "shares nothing and moves nothing", `docs/plans/organization-scope.md:145`, **V**) |
| `local` session of a signed-in person | Personal delegation | No | **No.** The API refuses the token. |
| Any session when nobody is signed in | None | No | No (phase 2 host-to-host path) |

### 1.3 The smallest change for "every session of a signed-in person"

1. **Accept the personal delegation on the new route family only.** The route does its own admission from the verified claims, as `admitRunner` does (`runner-routes.ts:31-47`). `claims.access === 'owner'` with `claims.act.host_id` gives the scope `person:<claims.sub>`. `claims.access === 'org-member'` gives `organization:<claims.organizationId>`. `/v1` and `/runner/deliver` stay as they are. No new principal kind. No personal organization in solus-cloud.
2. **Key the cloud row by the scope.** A `person:` row can be addressed only by a token whose subject is that person. No other access rule is necessary for it.
3. **The host selects the scope from publication.** Published: organization scope, organization delegation. Not published: person scope, personal delegation. The host saves the scope in `session_storage` at the first push.

Limits of this first version, to state in the plan:

- A `person:` repository is reachable only from the person's own personal hosts (the only hosts that can hold a personal delegation). A managed host cannot fetch or push one. D3 covers the next step: when the person selects a host in Run on, their client (their own token, no `act`) records "host H may open session S" on the API, and the token route then also accepts an organization delegation of the same person from that host. Do not accept any delegation of the person without that grant: a co-worker's shared host that the person used one time holds a live delegation for them.
- A session on a personal machine that must also run on a managed host needs publication. The publication operation was removed (maintainer decision 2026-10-07, `organization-scope.md:224-226`, **V**).
- A person in no organization cannot connect a client to the Solus API, so they get the push but not the client list from the cloud. Sign-up always gives an organization, so this is rare.

The alternative, a personal organization for each account in solus-cloud, needs a new organization kind, a directory entry, a policy row, and changes in each read that filters on `organization_id`. It is larger and it changes `recordScopeOf`. I do not recommend it for phase 3.

---

## 2. The token route

### 2.1 Where it must live

**In the Solus repository, in the record service.** Reasons, all **V**:

- The Artifacts credentials reach only the record service process. It reads them in `startWorkStorage` (`S/sync/works/work-storage-runtime.ts:17-22, 43`), started from `S/boot-solus-api.ts:130`.
- The token verifier for delegated tokens is there (`AccessTokenVerifier` with `SOLUS_API_AUDIENCE`, `boot-solus-api.ts:109`).
- The session records and the share rules for the access check are there (`createWorkspaceOperations(shares)`, `boot-solus-api.ts:140`).
- solus-cloud already sends each path under `/runner` to the record service (`RECORD_PATH_ROOTS`, `packages/contracts/src/solus-api/routes.ts:18`; `routeOwner`, solus-cloud `src/server/routing.ts:86-91`). A new path under `/runner/` needs no routing change in solus-cloud.

The plan text "The route and its storage settings are in solus-cloud" (`portable-sessions.md:224`) is correct only for the settings and the release pin.

Do not put it under `/v1`. `/v1` admission cannot admit a personal delegation (`admission.ts:23-24, 41`), and `/v1` is the documented public API (`docs/api/`).

`docs/plans/cloud-work-artifacts-integration.md:57-58` says: "Reuse the private host control path where appropriate, rather than creating a generic public Git-token endpoint." (**V**) This route is not generic: it gives one token for one repository to a host that acts for a named person. Tell the maintainers that it is a new endpoint that gives Git tokens to hosts.

### 2.2 What `CloudflareWorkRepositories.remote()` does (**V**, `S/sync/works/cloudflare-work-repositories.ts`)

- Base: `https://api.cloudflare.com/client/v4/accounts/<account>/artifacts/namespaces/<namespace>` (`:12`), bearer = the account API token (`:17`), 30 s for each request (`:18`), global `fetch` (`:21`).
- `GET /repos/<name>`; on 404 `POST /repos { name, default_branch: 'main' }`; a 409 reads again (`:30-34`).
- It checks the remote: `https`, host `<account>.artifacts.cloudflare.net`, no credentials (`:38`).
- `POST /tokens { repo, scope: 'write', ttl: 900 }` answers `result.plaintext` (`:39-41`).
- `GET /repos/<name>/file?ref=&path=` reads one file (`:44-49`). `DELETE /repos/<name>` removes (`:51-56`).
- Names must match `^work-[a-f0-9]{48}$` (`:25`).

Token scopes exist: `read` and `write`. "Read-scoped Artifacts tokens cannot push" (`docs/plans/cloudflare-artifacts-proof.md:79-80`, **V**). The binding types say TTL "default 86400, min 60, max 31536000" (solus-cloud `workers-types/index.d.ts:12578-12582`, **V**).

### 2.3 The routes

All calls: `Authorization: Bearer <delegated token for urn:solus:api>`, JSON.

**A. `POST /runner/session-repositories/token`**

Request: `{ hostId, sessionId, access: 'read' | 'write' }`

Response 200:

```json
{ "repository": "session-<48 hex>", "remote": "https://<account>.artifacts.cloudflare.net/…",
  "token": "art_v1_…", "expiresAt": "<ISO>",
  "head": "<40 hex>|null", "syncedTurn": 0, "lastRunHostId": "…|null", "runningHostId": "…|null" }
```

Errors: 401 (token not valid); 403 `forbidden` (wrong host, or no standing); 404 `no_repository` (`read` for a session with no row); 503 `storage_unavailable` (session storage is off on this API).

Access check, in this order:

1. The token verifies for the API audience and carries `act.host_id`. The body `hostId` equals it (the rule of `runner-routes.ts:42, 54`).
2. Scope from the claims: `owner` gives `person:<sub>`; `org-member` gives `organization:<organizationId>`.
3. `person:` scope. `write`: make the row if absent, `owner_user_id = sub`. `read`: the row must exist. Nothing more: the key holds the subject.
4. `organization:` scope. The session must be organization work on the API: a `session_records` row in that organization with `publication = 'published'`. The person (an `org-member` principal made as `principalForClaims` makes it) must pass `authorize(principal, 'edit', { kind: 'session', id })`, the check of `admitTurn` (`S/data/sessions/api-operations.ts:147-150`; `requireResource`, `S/data/workspace/context.ts:39-42`). **V**. Use it for `read` and for `write` (D4).
5. The API computes the name from the scope and the session id, opens or makes the Artifacts repository, and asks for a token with `scope: access` and `ttl: 900`.
6. A request budget for each person, as `/v1` has (`WorkspaceRequestBudgets`, `S/transport/solus-api/router.ts:61, 93`, **V**).

A client never calls this route: a person's own token has no `act` and fails step 1.

**B. `POST /runner/session-repositories/head`**

Request: `{ hostId, sessionId, event: 'running' | 'pushed' | 'idle', head?, syncedTurn?, card? }`. `card` is `{ title, provider, model, repositoryKey, branch, lastActivityAt }`, read from the manifest the host just wrote.

Rules: the admission of route A. `pushed` is accepted when `syncedTurn` is larger than the stored value, or equal with the same head; then `head`, `synced_turn`, `last_run_host_id = hostId` are written and `running_host_id` is cleared if it is this host. A smaller or equal count with another head answers 409 `{ head }`. `running` sets `running_host_id` and `running_since`. `idle` clears it for this host. Each accepted change broadcasts `session.headChanged`.

**C. `GET /v1/me/sessions`** (operation `listMySessions`, scope `sessions:read`): the `person:` rows of the caller (`owner_user_id = principal.userId`), each with the card and the four fields. The first segment `me` is already a record segment (`operations.ts:41-46`; `routes.ts:14-16`, **V**), so solus-cloud needs no change.

### 2.4 The namespace

Today there is one namespace for each environment, `solus-prod` (solus-cloud `cloud-worker/wrangler.jsonc:19`, **V**), and each work saves `storage_scope = <account>/<namespace>` (`work-storage-runtime.ts:44-46`, **V**). Recommend one namespace for sessions in each environment, separate from works, from a new variable `SOLUS_SESSION_ARTIFACTS_NAMESPACE`. Save `storage_scope` on each `session_repositories` row, and refuse a configuration that differs from the saved rows, as works do (`work-storage-runtime.ts:46`). Isolation between organizations comes from the token (one repository), the access check, and the name. It does not come from the namespace. The limit on the number of repositories in one namespace is not known (answer 4).

### 2.5 What solus-cloud must change

| Change | File | Mark |
|---|---|---|
| Pin a Solus revision that has the routes and the migrations | `solus-cloud/release-inputs.json` (today `ec7d86c7…`) | **V** |
| Add `SOLUS_SESSION_STORAGE=cloudflare-artifacts` and `SOLUS_SESSION_ARTIFACTS_NAMESPACE` to the Worker variables | `solus-cloud/cloud-worker/wrangler.jsonc:18-20` | **V** |
| No change: the account id and the token are already given to the container | `solus-cloud/cloud-worker/src/application-env.ts:16-17`; update its test `application-env.test.ts` for the new variable | **V** / **VA** |
| No change: routing | `solus-cloud/src/server/routing.ts` | **V** |
| No change: the token permission (it has Artifacts Edit) | `solus-cloud/docs/deploy-cloudflare.md:421-424` | **V** |
| Document the session storage and the check after a deploy | `solus-cloud/docs/deploy-cloudflare.md:411-437` | **V** |
| If D5 is accepted: the policy key in the organization policy editor and its validator | the routes `/v1/orgs/[organizationId]/policy` (`routing.ts` list); file paths not read | **I** |
| If D9 is accepted: delete session repositories with an account or an organization | not found; I did not find where solus-cloud deletes works with an organization | unknown |

The record service does not run Git for sessions. Hosts push directly to Artifacts. So the container needs no more disk or memory for this.

---

## 3. Host side push and fetch

### 3.1 Push directly from the local bare copy

The works transport builds a scratch repository because the record service has no local copy of the archive; it must fetch the head and build the commit there (`S/sync/works/git-work-transport.ts:39, 80-97`, **V**). A session has a real local bare copy with the commit already in it (`S/sync/sessions/session-repository.ts:169-197`, **V**). So a scratch repository is not necessary.

One push of one session:

1. Read `repository`, `head` (local) and `cloud_scope` from `session_storage`. Ask route A for a `write` token.
2. `git --git-dir <local> ls-remote <url> refs/heads/main` gives the remote head `R`.
3. `R` equals the local head: record it and stop (a lost response, or a sync from Artifacts).
4. `R` is absent, or `git merge-base --is-ancestor R <local head>` passes: `git push --force-with-lease=refs/heads/main:<R or empty> <url> <local head>:refs/heads/main`. Then `ls-remote` again; it must show the local head (the confirm of `git-work-transport.ts:99-100`).
5. Any other `R`: the push is refused (§3.4).
6. A failed push with an unchanged `R` is a transport failure: retry.

Notes:

- Push a fixed commit id, not the branch name. The next turn commit can move local `main` during the push.
- Do not write the remote or the token into the repository config. Give the URL on the command line. The token goes only through askpass.
- The ancestor rule accepts several turns that this host ran offline. It is the plan rule "the remote head is the head the turn started from" (`portable-sessions.md:88-91`) applied to a line of turns.
- The works proof shows that Artifacts obeys the expected-ref push: "Concurrent writers use the expected remote ref; one push succeeds" and "A competing upstream push is refused" (`cloudflare-artifacts-proof.md:46, 78-79`, **V**).
- The proof also saw an HTTP 500 on a first cloud transfer, and says a production transfer "must reconcile a successful remote write whose response was lost" (`:107-109`, **V**). Steps 2 and 3 do that.

### 3.2 What to share with `git-work-transport.ts`

Extract to one new module (for example `S/sync/git-remote.ts`):

- the askpass file and the Git environment: no prompt, no global or system config, no credential helper, no hooks, author identity, trace variables removed (`git-work-transport.ts:42-64`);
- the remote URL check (`archiveRemoteUrl`, `:133-137`; it accepts `https:` and `file:`);
- "read the remote head" (`:84-85`) and "checked push, then confirm" (`:98-100`).

Keep in the works transport: the scratch repository, the commit builder, string bodies, the 16 MiB output limit (`:69`), and the 120 s deadline (`:40`). Sessions give `--git-dir`, file streams, and their own limits. Use a stall limit (`-c http.lowSpeedLimit` and `http.lowSpeedTime`) and a long hard limit for a push, not the 10 minutes of `GIT_TIMEOUT_MS` (`session-repository.ts:20`).

Make the Cloudflare REST client usable for both: the name check accepts `work-…` and `session-…`, the token call takes the scope, and `fetch` is injectable for tests. Today it calls global `fetch` (`cloudflare-work-repositories.ts:21`).

The seam for sessions on a host is small: `SessionRemoteAccess.remote(sessionId, cloudScope, access) → { url, token?, head, … }`. The production one calls route A with `Delegations.accessToken(userId, scope, { kind: 'api' })`. A test one answers a `file://` URL.

### 3.3 Durable state, retry, and backoff

`session_storage` today: `session_id`, `repository`, `head`, `turn_count`, `error` (`S/db/host-tables.ts:363-371`, **V**). Add:

| Column | Meaning |
|---|---|
| `cloud_scope` | `person:<id>` or `organization:<id>`; null when the session never had a push |
| `pushed_head` | The remote head this host last confirmed (its own push, or a fetch from Artifacts) |
| `reported_head` | The last head the API accepted on route B |
| `push_due_at`, `push_attempts`, `push_error` | The next attempt, the count, and a safe text |
| `push_refused_head` | The remote head seen at a refusal; not null means "do not push this session from this host" |

No lease. One process writes a host data directory (`portable-sessions.md:591-593`, **V**). The lease of `WorkArchiveWriter` (`S/sync/works/work-archive-writer.ts:16, 95-105`, **V**) exists because the record service can have replicas.

Owner: a new `SessionPusher` in `S/sync/sessions/`. `SessionArchiveWriter.writePending` tells it after each row update (`session-archive-writer.ts:240-243`). It has its own queue with one push at a time. A long push must not hold the turn commits of other sessions.

- **Retry:** the wait doubles from 30 s to 30 minutes, as the writer does (`session-archive-writer.ts:103, 206-216`, **V**).
- **The host cannot act for the person now** (`ORGANIZATION_AUTHORITY_MISSING`, `delegations.ts:199`): wait, try every 5 minutes as runner delivery does (`WAITING_POLL_MS`, `S/sync/runner-delivery.ts:75`), and try at once on `onEstablished` (`delegations.ts:76, 168`). **V**
- **`GRANT_REVOKED`** (sign-out): stop. The state is "Not synced yet". The next sign-in starts again.
- **503 `storage_unavailable`:** the cloud has no session storage. Try again slowly (one time each hour).
- **Restart:** each row with `head` not equal to `pushed_head` and no `push_refused_head` is scheduled, next to `sessionArchive.resume()` (`boot-server.ts:627`).
- **Sign-in later** (plan §6.4 last paragraph): the same scan runs on `onEstablished` for the `personal` scope. One push at a time, newest activity first.
- **Report:** after a confirmed push call route B with `pushed`. Keep `reported_head`; retry the report with the same backoff. It is safe to send again.

### 3.4 A refused push: the smallest correct first version

The full rule of plan §7.3 makes a new session from the turns of this host. That needs a new record, a new lineage, and a native provider fork, and the thread import cannot make this host current again: "A divergent destination is a `conflict` result and is left unchanged" (`portable-sessions.md:709`, **V**).

First version:

1. Write `push_refused_head`. Never push this session again from this host. Nothing is deleted: the turns stay on local `main` and in the provider files.
2. Publish one status card on the session: "Continued on <host>. Your turns here are not synced." The host name comes from `lastRunHostId` in the answer of route A.
3. Refuse a new prompt for this session on this host with a typed refusal (`SESSION_DIVERGED`), so the second history does not grow.
4. The person's actions: continue on another host (it syncs from Artifacts), or Fork here. The existing fork makes a new session id on this host, where the thread files are. The fork has its own repository and pushes its full history.

This keeps decision 6: nothing is discarded, nothing is merged, and the cloud has one history. The automatic fork and the link in the conversation belong to phase 4.

### 3.5 Fetch for a sync

How `SessionSync` stages today (**V**, `S/execution/sessions/session-sync.ts`):

- `fetchBundle(sessionId, have, sourceHostId, outFile, signal, actor)` answers `ready` with a file, or `current`, `diverged`, `no-repository` (`:30-32, 45, 122-128`).
- It copies the local repository into a scratch root and runs `SessionRepositories.fetchBundle` there (`:129-137`). That method runs `git fetch <file> refs/heads/main`, checks that the local head is an ancestor, and moves `main` (`session-repository.ts:132-156`).
- After preflight, code restore, thread import, and record adoption, it runs the same `fetchBundle` on the real repository and writes `session_storage` (`:246-250`).

Recommendation: **a second implementation behind the seam, with a direct `git fetch`, and no bundle file.** `git fetch` accepts a repository path where it accepts a bundle file (**I**: standard Git; `SessionRepositories.fetchBundle` gives the path to `git fetch` unchanged at `:142, 149`). So the Artifacts source can answer `{ state: 'ready', file: <a temporary bare repository>, head }`:

1. Ask route A for a `read` token. 404 answers `no-repository`.
2. `git init --bare` in the scratch directory. Write `objects/info/alternates` to the local copy when one exists (as `session-repository.ts:138-141` does), so only new objects are downloaded.
3. `ls-remote`: no ref answers `no-repository`; equal to `have` answers `current`.
4. `git fetch <url> refs/heads/main` with askpass.
5. `have` is not an ancestor of the remote head: answer `diverged`.
6. Answer `ready` with the directory and the remote head.

Changes in `SessionSync`: give `request.knownHead` to the seam; rename `SourceBundle.file` to a name that covers both forms; when the source was Artifacts, write `pushed_head = head` with the final row update (`:249`).

### 3.6 "Another host" or "Artifacts"

The decision is in the `fetchBundle` dependency at `S/boot-server.ts:1335-1341`:

1. The host holds a usable delegation for the session's cloud scope (signed in): try Artifacts.
2. Artifacts answers `ready` and the fetched history contains `knownHead` (or the client sent none): use it.
3. Artifacts has no repository, or its history does not contain `knownHead`: the last run host has turns that are not pushed. Try the existing host path with `sourceHostId` (`S/execution/sessions/session-bundle-source.ts:8-46`). If that host is offline, fail with `source-offline` and the text "<host> has turns that are not synced yet".
4. Not signed in: the host path, as today.

`sessionPrepare` can also close the window of a late head report: when the session's last run host is not this host and the host is signed in, compare the head of route A's answer (or `ls-remote`) with the local head. This is not on the turn path, so decision 7 holds.

---

## 4. Size and limits

### 4.1 What the two repositories state

| Fact | Source | Mark |
|---|---|---|
| A works fixture: 40 revisions, 5 MiB of history; the next small save used 248 KiB of temporary Git storage and about 2 to 3 s | `docs/plans/cloudflare-artifacts-proof.md:53-55, 177-179` | **V** |
| A repository fixture of about 48 MiB (16 MiB old binaries, 8 MiB assets, 16 MiB dependencies, 8 MiB output) was pushed and partially cloned | `cloudflare-artifacts-proof.md:70-84` | **V** |
| "A Worker-only writer and Worker peak memory were not measured." | `cloudflare-artifacts-proof.md:123-124` | **V** |
| The works transport limits are Solus limits, not Cloudflare limits: 120 s for a push, 16 MiB of Git output, 30 s for a REST call | `git-work-transport.ts:40, 69`; `cloudflare-work-repositories.ts:18` | **V** |
| Token: scopes `read` and `write`; TTL 60 s to 1 year; default 86400 s | solus-cloud `workers-types/index.d.ts:12578-12582` | **V** |
| `readBlob` and `readFile` raise `MEMORY_LIMIT` "if the file cannot be buffered safely"; `import` raises it "if the import exceeds service memory limits" | solus-cloud `workers-types/index.d.ts:12605, 12635, 12749` | **V** |
| Wrangler marks the Artifacts token command "private beta" | solus-cloud `cloud-worker/node_modules/wrangler/wrangler-dist/cli.js:212086-212110` | **VA** |
| Code bundle limit in Solus: 200 MB (`CODE_BUNDLE_MAX_BYTES`) | `S/git/session-code-bundle.ts:21` | **V** |
| Plan test 5, "push a 300 MB session repository and read its limits": "Not run: no Cloudflare credential was available." | `portable-sessions.md:487, 617` | **V** |

No file in either repository gives an Artifacts limit for file size, push size, repository size, request time, rate, or the number of repositories. **VA** for the search of solus-cloud and of `docs/`, `tests/`, and the works code.

### 4.2 What is unknown

1. The largest single blob that a push accepts.
2. The largest single push (pack size), and the request time limit for one push.
3. The largest repository, and how the fetch time grows.
4. Whether a token that expires during a push stops that push.
5. The rate limits of `POST /repos` and `POST /tokens`, and the limit on repositories in one namespace. Each turn end needs one token; each new session needs one repository.
6. The size at which the REST file read fails (`MEMORY_LIMIT`). Answer 6 depends on it.
7. The pack size of a real transcript. JSONL compresses well with zlib, but the byte ranges do not delta against each other (**I**).

### 4.3 The measurement that settles it

Add one script beside the proof (`scripts/proof/artifacts/`, which has the cloud helpers and the askpass file; **V** by listing). It needs Workers Paid and a token with `artifacts:write` (`scripts/proof/artifacts/README.md`, **V**). Use a disposable repository in the proof namespace. Record for each step: result, HTTP status, wall time, bytes on the wire, and the peak memory of Git.

1. **One blob in one commit**, pushed with the production session transport: 1, 25, 50, 100, 250, 500, 1000 MB. Two data shapes: a real-shaped Claude JSONL (synthetic lines of real length) and random bytes.
2. **One push with a backlog:** 300 commits of 1 MB each (the "signed in later" case), then 300 separate pushes of one commit.
3. **Token expiry:** a `write` token with TTL 60 s and a push that is made slow to last longer than 60 s.
4. **Fetch:** a full fetch of the 300 MB and the 1 GB repository into an empty bare repository; then a fetch of one new commit with alternates.
5. **REST file read:** `GET /repos/<name>/file` for blobs of 1 KB, 1 MB, 8 MB, 32 MB, 100 MB.
6. **Rates:** 200 `POST /tokens` calls in one minute; 1000 repositories made in one namespace; then the list call.
7. **Refusal:** two local copies push from the same remote head; one must be refused, and the refusal must be visible as a remote head that is neither the local head nor an ancestor of it.
8. Delete each repository and check the 404.

Decision rule: if step 1 fails below 500 MB, split each thread byte range into parts of a fixed size (for example 32 MB: `threads/<id>/<key>/<n>.<part>`) before phase 3 code is written. The manifest `parts` list (`S/sync/sessions/session-manifest.ts:25-31`, **V**) can hold part names with a schema version 2. If step 3 fails, route A gives a longer TTL for `write`.

---

## 5. The session record at the home

### 5.1 How a host reports session facts today (**V** where I name my own reads; the rest **VA**)

- One route: `POST /runner/deliver`, body `{ hostId, items: [{ seq, kind, payload }] }` (`S/sync/runner-protocol.ts:91-103`, **V**). Kinds: `session`, `transcript`, `activity`, `shares`, `insights`, `webhooks` (`:74`, **V**). An unknown kind is skipped and named (`:83-87`, **V**).
- `RunnerDelivery.reportSession` hears each change of the host's own records. It stops unless the host is registered and `isOrganizationWork(record)` is true. It queues `{ ...record, runnerHostId: registration.hostId }` for the destination `{ organizationId, actorUserId }` (`S/sync/runner-delivery.ts:140-148, 182-192`, **V**).
- The token is the organization delegation of the delivering person. The route admits only `org-member` tokens with an acting host (`runner-routes.ts:31-47`, **V**).
- The intake writes `session_records` with `runnerHostId: runner.hostId` and `published: true` (`S/sync/runner-intake.ts:75-85`, **V**). It raises no event for a `session` item. Only transcript and activity items raise `session.transcriptChanged` (`:117-128`, **V**; `boot-solus-api.ts:145`, **V**).
- **Which sessions are reported:** only published organization sessions that this host owns (`runner-delivery.ts:182-185`; `emitChanged` drops records with a runner, `session-records.ts:390-394`). **V**. The transcript mirror has the same gate (`S/sync/mirror/transcript-mirror.ts:76-82`, **V**).
- A session of a personal machine never reaches the API today (answer 1.1).

### 5.2 How a client reads a session from its home

- `sessionHomeId`: the Solus API only for a published organization session on a managed host while the client is connected to that API; else the machine (`packages/client-core/src/session-home.ts:23-32`). The comment: "Every other session's home is its machine: a session on a personal machine is its owner's, published or not (plans/031 rule 1)" (`:15-18`). **V**
- Desktop and web: `SessionListStore.load` reads `sessionRecordList()` from each connected server. It keeps an API record unless a connected personal host runs it, and a machine's record only when that machine is its home (`packages/workspace-ui/src/contexts/workspace/session-list.store.svelte.ts:156-181`). `writeListed` sets `serverId` to the connected runner or to the API, and `runnerOffline` (`:223-252`). The list hears `session.stateChanged`, `session.viewChanged`, `session.titleChanged`, `session.becameLead`, `share.changed` (`:316-335`). There is no event for a changed record. **V**
- Mobile reads only its hosts (`apps/mobile/src/features/threads/thread-directory.ts:152-154, 175-177`, **V**). "Mobile does not connect to an organization's Solus API" (`docs/plans/session-archive.md:135`, **V**).
- `head` and `syncedTurn` exist only on a host's `SessionMeta`, read from `session_storage` when the server is not in API mode (`S/transport/handlers/history-handlers.ts:62-69`; `packages/contracts/src/types.ts:2584-2585`). `lastRunHostId` and `runningHostId` are in no code. **V** for the first; **VA** for the absence.

### 5.3 A conflict to decide (D2)

Plan §9 says that, signed in, "the home of each session is the Solus API of the person's organization" (`portable-sessions.md:372-376`). Three current rules say the opposite for a session of a personal machine: `session-home.ts:15-18`; `docs/plans/session-archive.md:22` ("Every other session's home is its machine"); `plans/031-host-owns-its-data.md:20-25` (rules 1 to 3) with D4 (`:86-91`). The plan's list of replaced rules (`portable-sessions.md:123-130`) does not name them. A full home on the API means that archive, snooze, settle, and pull request links of those sessions live on the API under a person scope (`session-archive.md:51-56`, decision 1). That is a large change in each store that filters on `organization_id`.

Recommendation for phase 3: do not change the home. Add the cloud row as an index.

### 5.4 How the four fields reach the home and the clients

**To the home.** The host sends them on route B (answer 2.3), not in the delivery queue. Reasons: the delivery queue is keyed by an organization and admits only `org-member` tokens, so it cannot carry a `person:` session; and the pusher already has a durable retry for the report.

| Field | Written when | Rule on the API |
|---|---|---|
| `head`, `syncedTurn` | `pushed`, after the push is confirmed | Accept a larger `syncedTurn` only. The checked push keeps the history a line, so the turn count orders the reports. |
| `lastRunHostId` | With the accepted `pushed` | The host id of the token (`act.host_id`), the id space of `runnerHostId` (`runner-delivery.ts:188`) |
| `runningHostId` | `running` at turn start, not awaited, beside `void admitTurnAtHome(sessionId)` (`S/execution/sessions/run-launcher.ts:768`, **V**); cleared by `pushed` or `idle` from the same host | A client ignores a `runningHostId` whose host is not online. At boot the host sends `idle` for the sessions its boot sweep marked interrupted. |

A problem that the fields solve: for a published session the intake overwrites `runner_host_id` with each delivering host (`runner-intake.ts:78`). When two hosts both hold the session, the boot report of an old host (`reportStoredSessions`, `runner-delivery.ts:170-175`) would name it as the runner again. `last_run_host_id` moves only with a larger turn count, so it stays correct. Clients must read the run host of a portable session from `lastRunHostId`, not from `runnerHostId`.

**To the clients.**

1. Contracts: add the four optional fields to `SessionRecord` (`packages/contracts/src/types.ts:2671`), to `workspaceSessionSchema` (`packages/contracts/src/solus-api/schemas.ts:330-381`, next to `runnerHostId` at `:339`), and to `SessionMeta` (it has two of them). `sessionMetaFromRecord` passes them (`packages/contracts/src/session-record-meta.ts:22` is the line to copy).
2. API reads: `SessionApiOperations.records` joins `session_repositories` for the listed session ids (`api-operations.ts:87-119`). The API handlers `getSessionInfo` and `getSessionInfos` do the same (`S/transport/solus-api/service-handlers.ts:75-82`).
3. Host reads: `withRecord` adds `lastRunHostId` and `runningHostId` from the host's own knowledge (this host, when it ran the last turn; else the value it got at the last sync).
4. Event: a new topic `session.headChanged { sessionId, head, syncedTurn, lastRunHostId, runningHostId }` in `packages/contracts/src/host-events.ts` (next to `:75-84`), broadcast in `boot-solus-api.ts` next to `:145`, filtered by `eventVisibleTo` as each topic is; for a `person:` row it goes only to that person's connections (the pattern of `publishSessionViewChanges`, `boot-solus-api.ts:154`).
5. The list store writes the fields into `ListedSession` in place (plain properties; no transcript read). The prompt sends `knownHead = listed.head` and `sourceHostId = listed.lastRunHostId`.

### 5.5 What must change so a client with no host online lists the session

| Session | Today | Change |
|---|---|---|
| Published organization session, desktop and web | Listed from the API with `runnerOffline: true` (`session-list.store.svelte.ts:223-252`) | Only the four fields |
| Published organization session, mobile | Not listed without its host | Mobile must connect to the Solus API of the active organization and read `sessionRecordList` there. This is the limit `session-archive.md:135-138` names. |
| Session in a `person:` scope | Not on the API | The API row with its card (answer 2.3, route B) and `GET /v1/me/sessions`. Each client merges: a session that a connected host lists is shown from the host with the highest `syncedTurn` (the plan rule for "not signed in", `portable-sessions.md:377-379`); a session that only the cloud lists is shown with "Last ran on <host>" and "<host> is offline". When the person selects a host, that host syncs and adopts the record, and the session is a normal host session again. |

Limits of the index, to state: archive and snooze of a session are still for each host, so a session archived on host A shows as active after a sync to host B; and a person with no organization has no API connection.

---

## 6. Read-only open with no host online (phase 5)

### 6.1 What exists

- The mirror sends the projected row: "the same projection the history RPCs apply before a row leaves a host, so a tool result's body never reaches the cloud" (`transcript-mirror.ts:39-42`, **V**). The projection keeps the size, the first 2 KiB of an error, and a sub-agent's report (`S/data/sessions/result-projection.ts:8, 18-47`, **V**).
- A host applies the same projection to its own history reads (`history-handlers.ts:55`, **V**). So a client never gets a tool result body from any server today. The row a client renders is `WireSessionLoadMessage`.
- The API serves a mirrored transcript with the history RPC names: `loadSession`, `loadSessionPage`, `loadSessionPreview`, `loadSessionToolInputs`, read from `session_transcripts` (`service-handlers.ts:87-107`, **V**). The RPC gate requires `read.transcript` (`packages/contracts/src/permissions.ts:385-389`, **VA** for the full list; `:389` **V**).
- The mirror holds no diff and no changed files, and the API registers no diff handler. **VA**
- The manifest has `turns[n].hasDiff`, `snapshots` with counts, and no rows yet (`session-manifest.ts:52-66`, **V**). Rows were deferred to phase 5 (`portable-sessions.md:582-585`, **V**).
- Artifacts can read one file at a ref without a clone (`cloudflare-work-repositories.ts:44-49`, **V**).

### 6.2 The smallest design

**Data.** Each turn commit adds `rows/<n>.jsonl`: the rows of turn `n` after `projectSessionHistory`, one JSON line for each row. The host that ran the turn makes them with the reader the mirror uses (`TranscriptMirrorDeps.loadSession`, `transcript-mirror.ts:53-57`, **V**), cut at the turn boundary. The manifest turn gets `rowCount`. Projected rows are small, and they put nothing in the repository that the thread files do not have. The data layer needs no provider parser.

**Who serves.** The Solus API. A client never gets a repository URL or a token (plan §6.3).

**How.**

1. The API resolves the `session_repositories` row and its `head`.
2. It reads `manifest.json` at `head` with the REST file read and keeps it in a small memory cache keyed by `(repository, head)`. Content at a commit never changes.
3. `loadSessionPage { sessionId, turnLimit, before }`: the cursor is a turn index. The API reads `rows/<n>.jsonl` for the turns of the page, newest first. `loadSession` and `loadSessionPreview` use the same reader. Tool inputs are in the rows, so `deferSessionToolInputs` works as today (`service-handlers.ts:96, 103`).
4. One new RPC on the collaboration plane, `sessionTurnDiff { sessionId, turn } → { patch, isTruncated }`: it reads `diff/<turn>.patch`. A patch over a limit (start: 2 MiB) answers the file list and counts from `manifest.turns[turn].snapshots` and `isTruncated: true`. The session total diff needs the bundles, so it stays a host feature.
5. Source choice on the API: a session with rows in `session_transcripts` (a mirrored organization session) keeps that source, because the mirror also covers a running turn. A session with none reads the repository. Old turns with no `rows/` file show "Open on a machine to read this turn".

**Access check.**

- `person:` row: the caller's `userId` must equal `owner_user_id`. The client connects to the API as a member of any of its organizations; the check does not use that organization.
- `organization:` row: `read.transcript` on the session through the share rules, as for a mirrored transcript today. This is correct for rows because they hold no tool result bodies (D8). `sessionTurnDiff` needs a decision: a turn diff shows code. Recommend the same standing that reads the diff on a host; I did not read which action the host diff RPCs need (unknown; read `permissions.ts` for the diff methods).

**Clients.** Desktop and web already open a session from the API when its runner is offline (`session-record.store.svelte.ts:55-59`, **VA**). They need the `person:` entries and the diff call. Mobile needs the API connection of answer 5.5 and its own read-only thread screen with the "Choose a machine" composer text (`portable-sessions.md:403-404`).

**Unknown:** the size limit of the REST file read (answer 4.2 item 6). Rows are split by turn, so one file is small, but one turn with very many tool calls can still be large. If the measurement shows a low limit, split `rows/<n>.jsonl` into parts of a fixed row count.

**Alternative, not recommended:** widen the transcript mirror to each pushed session. The readers exist, but `session_transcripts` is keyed by an organization, Postgres would hold each personal transcript, and the diff still needs another source.

---

## 7. Privacy and policy conflicts

### 7.1 Rules that the plan lists as replaced (`portable-sessions.md:123-130`, **V**)

1. "After a session starts, its host is fixed." (`docs/run-on.md:106`, **V**)
2. "machine … It does not change." (`docs/plans/session-archive.md:26-27`, **V**)
3. A forgotten machine closes its conversations (`docs/plans/workspace-and-machines.md:337`, **V**).
4. "a tool result's body never reaches the cloud" (decision 2026-09-19; the only source text is the comment at `transcript-mirror.ts:39-42`, **V**; no decision document exists in `docs/`, **VA**).
5. "No automatic commit of dirty code is introduced." (`docs/plans/cloud-work-artifacts-integration.md:20`, **V**)

### 7.2 Rules that the plan does not list, and that phase 3 breaks or touches

6. **Sign-in publishes nothing.** "Signing in, linking a host, and joining an organization do not publish Local sessions or works" and "Selecting an organization must not publish scratch work" (`docs/plans/organization-scope.md:41-43`; again at `:523`). **V**. Phase 3 uploads each session at sign-in. With D1 the upload is to the person's own scope, so it is storage and not publication. The maintainers must say that this is the meaning they accept.
7. **A session stays on its host** (maintainer decision 2026-10-07, `organization-scope.md:201, 224`). **V**
8. **The host owns its data**, and "While the owner is signed out, nothing is mirrored" (`plans/031-host-owns-its-data.md:20-25, 86-91`). **V**. See D2.
9. **A host must not get wide access:** "do not grant the machine unrestricted access to all organizations its owner belongs to" (`organization-scope.md:380`, **V**). Route A gives one repository for each call and checks the session each time. D3 keeps a `person:` repository away from hosts that are not the person's own.
10. **The phase 2 bundle gate.** `sessionRepositoryBundle` needs only `read.transcript` (`permissions.ts:389`, **V**), but it serves the thread files with tool result bodies, which the history RPC removes for the same reader. `sessionPrepare` needs `drive.prompt` (`:397`, **V**). Raise the bundle to `drive.prompt` (D10).
11. **No generic Git-token endpoint** (`cloud-work-artifacts-integration.md:57-58`, **V**). See answer 2.1.

### 7.3 Organization policy that exists in code today

The schema is strict: "Solus refuses a key that it does not know or cannot enforce" (`docs/managed-policy.md:129`; `.strict()` in `packages/contracts/src/policy.ts:107, 131`). **V**

| Key or rule | What it does | Does it gate this upload? |
|---|---|---|
| `sessions.limits.insights.syncAll` (`policy.ts:129`) | Sends Insights of the organization's sessions (`S/sync/mirror/insight-mirror.ts:43-49`) | No. Insights only. **V** |
| `host.cloudTunnel: false` (`policy.ts:100`) | No tunnel. "Registration with Solus Cloud still works" (`managed-policy.md:143`) | No. A delegation still works, so a push would still run. **V** |
| `host.remoteAccess: false` (`policy.ts:98`) | Loopback only, no pairing | No. It also stops the host-to-host path, so the cloud would be the only way to sync. **V** |
| `host.analyticsEnabled`, `host.otel` (`policy.ts:96-97`) | Telemetry | No. **V** |
| `sessions.limits.providers.allowed`, `models`, `maxPermissionMode` (`policy.ts:121-127`) | What may run | No. But a sync must obey them on the new run host. They are checked at each run (`runDenial`, **VA**), so this holds. |
| Host rule `allowsPersonalHosts` (`uplink.ts:161-171`) | "refuses no turn" (`organization-scope.md` §0 table); used for webhooks (`turn-organization.ts:300`) | No. But it raises a question: may an organization session sync to a member's personal host when the rule is false? Today the owner's delegation skips this check (solus-cloud `delegations.ts:181-182`, **V**). |
| Publication (`isOrganizationWork`) | The only gate of the transcript mirror and of session facts | It is the present "does anything leave this machine" gate. Phase 3 goes around it. **V** |
| MDM policy | "Personal work (`local`) gets only the MDM policy" (`managed-policy.md:44`) | A company that manages a laptop with MDM has no key today that stops the upload of personal sessions. **V** |

No key exists for: a transcript upload, cloud sync of sessions, data residency, code that leaves the machine, or session retention. **VA** (search for those terms), and **V** for the keys of `policy.ts:89-131`.

### 7.4 What to add (D5)

- A policy key `sessions.limits.sessionCloudSync: boolean` in `sessionLimitsSchema` (`policy.ts:121-131`). `false` means: no push and no fetch from Artifacts for that work; the host-to-host path stays. An MDM policy can set it for all work on the machine, personal work also, because the MDM policy governs "all work on it" (`managed-policy.md:17`, **V**).
- The pusher asks the work policy of the session's organization (`WorkPolicy.resolve`, `packages/contracts/src/host-policies.ts:143-158`, **V**). A refused policy (`POLICY_UNAVAILABLE`, `POLICY_UNENFORCEABLE`) means no push: fail closed, as the document says (`managed-policy.md:279-285`, **V**).
- A host setting for the person ("Sync sessions to Solus Cloud"), default on, shown as managed when the key locks it. The precedent for default on with sign-in is settings sync ("Signed in is synced", `account-sync.store.svelte.ts:28-31`, **VA**) and Insights (decision 2026-09-27, `organization-scope.md` Insights section, **V**).
- Rollout: a host on an old version refuses an unknown key and stops that organization's work (`host-policies.ts:155`, **V**). Ship the host that knows the key first; let a console set it later.

### 7.5 Other items to name

- **Secrets.** A tool result body often holds file content, a `.env` file included. Code bundles hold code that is not committed. The files that `.worktreeinclude` names stay out (plan open decision 3). There is no encryption (plan decision 2). The Cloudflare account token of the record service can read each repository.
- **Members and bodies.** For an organization session, each member with `edit` standing can make their host fetch the full bodies. On a managed host a new session that is not a chat is shared with the organization (`shareRunnerWrite`, `runner-intake.ts:84`, **V**). The mirror hid those bodies from the same people. D4 limits this to `edit`; the maintainers can choose owner only.
- **Chats.** A chat in an organization is its owner's alone until shared (`runner-intake.ts:82-84`, plan 004 D14). The `authorize` check of route A uses the same share rows, so a chat stays private (**I**).
- **Retention and delete.** "Nothing deletes a session repository" and "Retention is not decided" (`portable-sessions.md:599-601`, **V**). In the cloud this is storage with no end for each account. A person who leaves an organization keeps their `person:` repositories and loses the `organization:` ones.
- **Residency.** One Cloudflare account and one namespace. The application container is placed in `enam` (solus-cloud `cloud-worker/src/app-instance.ts:7, 13`, **VA**). Where Artifacts stores data is not stated in either repository.

---

## 8. Work breakdown

### 8.1 Parts

"Contract" below is one small file that the first worker writes and the others import: `packages/contracts/src/session-repositories.ts` (the request and response schemas of routes A and B, the cloud scope, the four fields, the event payload).

| Part | Repository and files (owner) | Content | Tests |
|---|---|---|---|
| **0. Limits** (needs Cloudflare credentials) | Solus `scripts/proof/artifacts/` (a new script and a result file) | The measurement of answer 4.3 | The script is the test. |
| **K. Contract** | Solus `packages/contracts/src/session-repositories.ts`; fields in `types.ts`, `solus-api/schemas.ts`, `session-record-meta.ts`, `host-events.ts`; `docs/api/openapi.json` | Schemas, the four fields, `session.headChanged`, `listMySessions` | The contract tests that exist for the operation registry and OpenAPI. |
| **A. Shared Git transport** | Solus `S/sync/git-remote.ts` (new); `S/sync/works/git-work-transport.ts`; `S/sync/works/cloudflare-work-repositories.ts` (generalized, injectable `fetch`) | Answer 3.2 | `tests/unit/work-storage.test.ts` passes with no change (it uses a `file://` remote at `:264-298`, **V**). New `tests/unit/git-remote.test.ts`: accepted push, refused push, lost response, no token in config or in an error text. |
| **B. API side** | Solus `S/data/sessions/session-repositories.ts` and its schema and migration for both engines; `S/transport/session-repository-routes.ts` (registered beside `registerRunnerRoutes`, `S/transport/http.ts:540`); a storage provider `S/sync/sessions/session-remote-provider.ts` with `cloudflare-artifacts`, `local-git`, and off; wiring in `S/boot-solus-api.ts`; the join in `S/data/sessions/api-operations.ts`; `listMySessions` in `S/transport/solus-api/router.ts` | Routes A, B, C; the event | `tests/unit/session-repository-routes.test.ts`: each row of the admission table (no `act`; personal delegation; organization delegation; wrong `hostId`; another person's session id; an organization session that is not published; reader against editor; a private chat); the name from the scope; the turn count rule and the 409; `storage_unavailable`; the event audience. A fake Artifacts through the injected `fetch`. `tests/unit/solus-api-composition` for the wiring. Both engines. |
| **C. Host push** | Solus `S/sync/sessions/session-push.ts` (new `SessionPusher`); `S/sync/sessions/session-remote-access.ts` (client of route A and B with `Delegations`); `S/sync/sessions/session-repository.ts` (`remoteHead`, `push`); columns in `S/db/host-tables.ts` and the generated migration; one call in `session-archive-writer.ts`; wiring in `S/boot-server.ts` | Answers 3.1 and 3.3 | `tests/unit/session-push.test.ts` with real Git, a `file://` remote, and a fake access: first push; next push; a stop after the push and before the row; a stop after the row and before the report; lost response; backoff; "cannot act for the person" then `onEstablished`; sign-out; restart; the backlog at sign-in; the policy key off. `tests/unit/data-model-baseline.test.ts` for the columns. |
| **D. Host fetch and source choice** | Solus `S/execution/sessions/session-artifacts-source.ts` (new); `S/execution/sessions/session-sync.ts` (the wanted head, the field name, `pushed_head`); `S/boot-server.ts:1335-1341` | Answers 3.5 and 3.6 | `tests/unit/session-artifacts-source.test.ts`: `current`, `diverged`, `no-repository`, `ready` with alternates; a remote that lacks `knownHead` falls back to the host path; a full `SessionSync` run from a `file://` remote (extend `session-sync-gate.test.ts`). |
| **F. Refused push** | Solus `S/sync/sessions/session-push.ts`, the refusal code in contracts, the prompt gate in `S/transport/handlers/session-sync-prompt.ts` or the launcher | Answer 3.4 | Two local copies, one remote: the second push is refused; nothing in the first session changes; the prompt is refused with the typed reason; Fork makes a session with its own repository. |
| **G. Policy and setting** | Solus `packages/contracts/src/policy.ts`, `host-policies.ts`, `S/host/settings.ts`, `docs/managed-policy.md`, the settings UI in `packages/workspace-ui/src/components/settings/` and in `apps/mobile/` | Answer 7.4 | Policy unit tests: the key locks the setting; MDM applies to `local`; a refused policy stops the push; an old schema refuses the key. |
| **E. Clients** | Solus `packages/workspace-ui/src/contexts/workspace/session-list.store.svelte.ts`, `packages/client-core/src/workspace-records.ts`, `apps/mobile/src/features/threads/thread-directory.ts` and the mobile API connection | Answers 5.4 and 5.5: the fields, the event, the merge with cloud entries. The Run on control and the states are phase 4. | `session-list-store` tests: one row for a session on two hosts; a cloud-only entry; `session.headChanged` writes in place. Mobile thread list tests. |
| **H. solus-cloud** | solus-cloud `release-inputs.json`, `cloud-worker/wrangler.jsonc`, `cloud-worker/src/application-env.test.ts`, `docs/deploy-cloudflare.md`; the policy editor if G is accepted | Answer 2.5 | `application-env.test.ts`; `routing.test.ts` stays green with no change. |
| **L. Lab** | Solus `packages/lab/scenarios/cloud/portable-sessions.ts` (new); `tests/e2e/mock/mock-backend.ts` (`threadFiles`, `importThread`); a project fixture in `packages/lab/src/` | The scenario below | The scenario is the test. |
| **Docs** | Solus `docs/plans/portable-sessions.md` (§9, §16, a phase 3 section), `session-archive.md`, `organization-scope.md`, `plans/031`, `cloud-work-artifacts-integration.md` | The decisions as made | — |

Phase 5 (answer 6) is a separate set: rows in the writer (`session-archive-writer.ts`, `session-manifest.ts`), the API reader, `sessionTurnDiff`, and the mobile read-only screen.

### 8.2 Order

1. **0 and K first.** 0 can change the layout of `threads/`. K fixes the wire shapes.
2. **A, B, G in parallel.** They share no file.
3. **C and D in parallel** after A and K. They need only the access seam, not a running API. Each owns its files; both touch `boot-server.ts` in different blocks and `session-repository.ts` in different methods, so one worker merges after the other.
4. **F** after C. **E** after K and B.
5. **L** after B, C, D.
6. **H** last, with the deploy. The API ships before a host release that calls it (plan §6.3). A host must read 404 and 503 from an old API as "cloud storage is not available".

### 8.3 The Lab

- The Lab runs real hosts with mock agent backends, real clients over RPC, and personas. In cloud mode it runs the real local solus-cloud (`vite dev` on PGlite) with a Solus API and one host (`.claude/skills/verify-multiplayer/SKILL.md:13, 31-34`, **V**; details in `packages/lab/README.md`, **VA**).
- Cloud mode makes the personal delegation for real: a fixture waits for `delegation_held` with the scope `personal` (`packages/lab/src/cloud-fixtures.ts:145`, **V**). So route A with a personal delegation can be tested end to end.
- The Lab has no stand-in for Artifacts. For works it uses real Cloudflare or local Git (`packages/lab/scenarios/work-git-storage.ts:25-49`, **V**). The `local-git` provider of part B is the stand-in for sessions: route A answers a `file://` remote under the API data directory and no token. All Lab processes are on one machine, so two hosts can use that remote. The API of cloud mode gets its environment from the Lab process (`packages/lab/src/solus-api.ts:68-70`, **V**), so `SOLUS_SESSION_STORAGE=local-git` passes through.
- What the Lab lacks for the scenario (**VA**, with my check of the mock): the mock backend has no `threadFiles` and no `importThread` (no match in `tests/e2e/mock/mock-backend.ts`, **V**); no project fixture with a Git origin; no scenario for portable sessions.

Scenario (cloud mode, two personal hosts of one person, one client): run a turn on host A; wait for `head` on the API; stop host A; `sessionPrepare` and a prompt on host B; check one session id, turn count 2 on the API, `lastRunHostId` = B, and equal tree ids; start host A; prompt on A; check that A syncs from the remote. Then the refused push: stop the network path of A to the API (an environment switch in the access client), run a turn on A and a turn on B, restore, and check that A is refused and B's history is the remote one. Then the organization variant with a managed host flavor, and a second member with `read` standing who must get 403 from route A.

### 8.4 What cannot be verified without real Cloudflare credentials

1. Each limit of answer 4.2.
2. That `read` and `write` tokens behave for session repositories as the works proof saw for works.
3. The behavior of a push when the token expires.
4. That a new namespace is made at the first repository (stated for works in solus-cloud `docs/deploy-cloudflare.md:416`, **V**; not proved for a second namespace).
5. The real remote URL form and the askpass prompt match on the real host (the works transport proves the pattern for `<account>.artifacts.cloudflare.net`).
6. The HTTP 500 that the proof saw on a first transfer, and the retry.
7. The REST file read of rows and patches at real sizes (phase 5).

An opt-in test, as works have (`tests/unit/work-storage.test.ts:311`, `ARTIFACTS_WORK_ADAPTER_CLOUD=1`, **V**), must cover items 2 to 5 with a disposable repository before the first deploy.

---

## Things I could not determine by reading

- Each Artifacts limit (answer 4). The measurement settles it.
- Where solus-cloud deletes cloud data of a deleted organization or account. A search of the delete paths in `solus-cloud/src/lib/server/` settles it.
- Which permission the host diff RPCs need, for the access rule of `sessionTurnDiff`. `packages/contracts/src/permissions.ts` settles it.
- Whether the pinned Solus revision in solus-cloud (`ec7d86c7…`) has the phase 1 and 2 code. `git merge-base --is-ancestor` on the two revisions settles it. It matters only for the deploy order.
- Whether a `git fetch` from a bare directory with alternates behaves as from a bundle in each case `SessionSync` has. A unit test in part D settles it.

### Part K as implemented (2026-11-18)

`packages/contracts/src/session-repositories.ts` exports these wire names:

- Paths: `SESSION_REPOSITORY_TOKEN_PATH`, `SESSION_REPOSITORY_HEAD_PATH`, `LIST_MY_SESSIONS_OPERATION_PATH`, and `LIST_MY_SESSIONS_PATH`.
- Scope: `sessionCloudScopeSchema`, `SessionCloudScope`, `parseSessionCloudScope`, and `formatSessionCloudScope`. The text is `person:<id>` or `organization:<id>`.
- Four facts: `sessionRepositoryFactsSchema` and `SessionRepositoryFacts` have `head: 40-hex|null`, `syncedTurn: nonnegative integer`, `lastRunHostId: string|null`, and `runningHostId: string|null`.
- Token route: `sessionRepositoryTokenRequestSchema` and `SessionRepositoryTokenRequest` have `hostId`, `sessionId`, and `access: read|write`. `sessionRepositoryTokenResponseSchema` and `SessionRepositoryTokenResponse` have the four facts plus `repository`, `remote`, `token`, `expiresAt`, and `storageScope`. `sessionRepositoryTokenRefusalSchema` and `SessionRepositoryTokenRefusal` have `code: unauthorized|forbidden|no_repository|storage_unavailable`.
- Head route: `sessionRepositoryCardSchema` and `SessionRepositoryCard` have `title`, `provider`, `model`, `repositoryKey`, `branch`, and `lastActivityAt`. `sessionRepositoryHeadRequestSchema` and `SessionRepositoryHeadRequest` are `running`, `idle`, or `pushed`; `pushed` requires `head`, `syncedTurn`, and `card`. `sessionRepositoryHeadResponseSchema` and `SessionRepositoryHeadResponse` are the four facts. `sessionRepositoryHeadRefusalSchema` and `SessionRepositoryHeadRefusal` have the accepted `head` for HTTP 409.
- Event: `sessionHeadChangedSchema` and `SessionHeadChanged` have `sessionId` and the four facts; `session.headChanged` is in `HostEventMap` and its definition registry.
- List: `listMySessionsResponseSchema` and `ListMySessionsResponse` have `items` with `sessionId`, card fields, and the four facts. The `listMySessions` operation has `sessions:read` scope.
- Prompt: `SESSION_DIVERGED` and `SessionPromptRefusalCode` name the refused-push prompt code. `StatusCardState.promptRefusalCode` can carry it beside `syncFailureReason`.

The four plain optional fields are on `WorkspaceSession`, `SessionRecord`, and `SessionMeta`. `sessionMetaFromRecord` copies them. The token response adds `storageScope` to the design's example because the work breakdown asks for it. The head report success uses the shared facts because the design did not give a success body. The list uses a flat item to carry the card and facts. The conflict body has only `head`, as answer 2.3 states. `unauthorized` names the token route's 401 case. The head request uses a discriminated event so `pushed` cannot omit its commit facts. The API route registry has no implementation in this part; the API worker owns it.

### Part A as implemented (2026-11-18)

`sync/git-remote.ts` exports `GitRemote`, `GitRemoteOptions`, and
`CheckedPushResult`. `GitRemote.open({ gitDir, remote, token?, signal?,
timeoutMs, outputLimitBytes?, authorDate? })` validates an HTTPS or file remote,
creates a temporary askpass file, and prepares a Git environment without
global or system config, hooks, credential helpers, or trace output. The token
is in the process environment only. `git(args, input?)` runs a command with
`--git-dir`; `remoteHead()` reads `refs/heads/main`; `checkedPush(commit,
expectedHead)` pushes the fixed commit with a lease and reads the remote head
again. Its result is `accepted` with the commit, `refused` with the remote head
(or `null`), or `failed` with a safe `transport` or `timeout` reason. `close()`
removes the askpass file. A caller must close it in `finally`.

The time limit covers the whole open transport lifetime. Works give 120 seconds
and a 16 MiB output limit, then build commits in a scratch bare repository as
before. Session callers must give a longer hard `timeoutMs` and an appropriate
`outputLimitBytes` for their operation. Git also uses a 60-second HTTP stall
limit. A `file://` remote needs no token. A retry that finds its commit at the
remote head returns `accepted`; a failed push reads the head again to distinguish
a lost response from a moved head. The shared module does not check ancestry;
the session writer must do that before it calls `checkedPush`.

`CloudflareWorkRepositories.remote(repository, scope = 'write')` accepts
`read` or `write` and validates both `work-<48 hex>` and `session-<48 hex>`.
Its constructor accepts an optional injected `fetch` as the fifth argument.
The account credential stays in that class. Local work repositories still
accept work names only. No API contract, host push, or deployment is part of
Part A.

### Part G as implemented

- Policy key: `sessions.limits.sessionCloudSync`. An absent key allows cloud sync. An explicit `false` stops push and fetch. The first rule in MDM, cloud host, organization order wins.
- Host setting: `hostConfig.sessionCloudSync`, shown as “Save sessions to Solus Cloud”, defaults to `true`, and is stored in `server-settings.json`.
- Gate: `sessionCloudSyncDecision(organizationId, actingPerson)` in the host policy store. It reads the host setting and `hostPolicies().forWork(organizationId)` at call time. No signed-in actor, a host switch that is off, an unavailable policy, and a policy that forbids sync each give a typed refusal.
- The host-wide switch shows an MDM lock. An organization limit applies to its sessions but does not disable the host-wide switch for Local work.
- An older host refuses a policy document that names the new key because its policy schema is strict. Hosts must ship before a console can set the key.

### Part B as implemented (2026-11-18)

The record service owns `session_repositories` on SQLite and Postgres. Its key is
`(cloud_scope, session_id)`. The row stores the owner, API-computed repository name,
storage scope, four cloud facts, running time, and list card. The existing
`session_records` table remains the home of organization session list state.

`POST /runner/session-repositories/token` accepts only a verified host delegation
whose `act.host_id` equals the request `hostId`. A personal delegation reaches
`person:<accountId>`; an organization delegation reaches only a published session
for which the person has edit standing. The API computes the repository name.
Read needs an existing row; write can create it. A successful answer has the Git
remote, one repository token, its expiry, storage scope, and the four facts.
The route answers `unauthorized` (401), `forbidden` (403), `no_repository` (404),
or `storage_unavailable` (503). A person request budget applies.

`POST /runner/session-repositories/head` uses the same admission. `running` sets
the running host and time. `idle` clears only the reporting host. `pushed` accepts
a larger turn count or the same count and head; a stale report gets 409 with the
accepted head. Accepted changes send `session.headChanged` to the owner's
connections for a personal scope, or to admitted readers of the published
organization session. `GET /v1/me/sessions` lists the caller's personal cloud
rows with a committed head and list card. Organization record reads join the
four facts from the cloud row.

`SOLUS_SESSION_STORAGE` is `off` by default, `local-git` for a file remote under
the API data directory, or `cloudflare-artifacts`. Artifacts uses
`SOLUS_ARTIFACTS_ACCOUNT_ID`, `SOLUS_ARTIFACTS_API_TOKEN`, and the session-only
`SOLUS_SESSION_ARTIFACTS_NAMESPACE`. A changed storage scope or invalid
configuration stops startup. The API never logs a repository token.

Phase 3 keeps the machine as the home of a personal session (D2). Only a
personal delegation reaches its repository (D3); both organization reads and
writes require edit standing (D4). Sessions use a namespace separate from works
(D6). Retention, size caps, and account deletion remain the D9 release gate.


### Part C as implemented (2026-11-18)

`session-remote-access.ts` exports `SessionRemoteAccess`, `SessionRemoteResult`, and `DelegatedSessionRemoteAccess`. It calls the token and head routes with the acting person's personal or organization delegation. HTTP 404 and 503 answer `unavailable`.

`SessionPusher` in `session-push.ts` owns one host-wide push queue, apart from the turn commit queue. `committed`, `resume`, `established`, `signedOut`, `idle`, `stop`, and `refusedHead` are its public operations. It checks `sessionCloudSyncDecision` before upload. It selects an organization scope only for published organization work; other sessions use the person's scope. It pushes a fixed commit from the local bare repository, confirms the result, then reports the head and turn count. A report is retried without a second push. A remote head that is not an ancestor stops the push for that session. The later prompt gate and Fork action are not in this part.

`session_storage` adds `cloud_scope`, `pushed_head`, `reported_head`, `push_due_at`, `push_attempts`, `push_error`, and `push_refused_head`. The SQLite migration is `0005_session_cloud_push.sql`. The Git push limit is one hour with a 60-second low-speed stall limit. No repository file is held in memory by the push.

### Part D as implemented (2026-11-18)

`execution/sessions/session-artifacts-source.ts` exports `SessionReadAccess`,
`fetchSessionArtifacts`, and `chooseSessionRepositorySource`. The source asks an
injected `SessionReadAccess(sessionId, actor, signal)` for a read token and
remote, fetches `main` into a temporary bare Git repository with `GitRemote`,
uses a local object alternate when one exists, and returns that repository path
to `SessionSync`. It never holds repository bytes in memory. `SessionSync` passes
the client's wanted head to its one source seam, accepts a bundle or bare
repository at `repositoryPath`, and records a cloud head as `pushed_head` when
Part C's column exists. The boot seam is `BootOptions.sessionReadAccess`; Part C
must connect its route client there.

A signed-in host with cloud sync allowed by the host setting and work policy
tries cloud first. It uses cloud only when its history contains the wanted
head. A missing cloud repository or wanted turn uses the last run host. If that
host is offline, `source-offline` says that the cloud copy is behind. Without
sign-in, the host path remains; without a last run host, the result is
`not-signed-in`. A missing repository gives `no-repository`; unrelated local
and cloud histories give `diverged`. A policy refusal or disabled host setting
forbids cloud download as well as upload. A host connection can still fetch.

The source host waits up to 30 seconds for that session's pending capture and
commit before it serves a bundle. An error or timeout answers the typed
`commit-failed` state. Both the bundle request and each chunk now require
`drive.prompt` standing, because thread files contain full tool result bodies.
The cloud token route client and the `pushed_head` migration belong to Part C.
No Cloudflare credential, deployment, or live service was used for this part.

### Part F as implemented (2026-11-18)

`session-cloud-scope.ts` owns the cloud scope rule for push and read. A host with
no local session record reads in the acting person's scope. The boot composition
uses `DelegatedSessionRemoteAccess` for reads; test injection remains available.

`PromptDispatch.admitTurn` checks the durable refused head before it starts a
provider. It returns `SESSION_DIVERGED` for every prompt route that admits a
turn. `SessionMeta.pushRefused` exposes the state to clients. A remote-head sync
keeps the previous local head at `refs/solus/refused/<sha>`, then adopts the
cloud head and clears the refusal. The local turns remain in that Git history.

### Part E as implemented (desktop and web)

Desktop and web (`packages/workspace-ui/`, `packages/client-core/`). No server
change, no mobile change. The client extends phase 4A (`portable-sessions.md`
§20).

- **The four facts.** `CloudSessions` (`contexts/workspace/cloud-sessions.svelte.ts`,
  `sessionListStore.cloud`) keeps `head`, `syncedTurn`, `lastRunHostId`, and
  `runningHostId` for each session. It learns them from the records a Solus API
  answers (`sessionRecordList`, `sessionRecordGet`), from `listMySessions`, and
  from `session.headChanged` on each Solus API connection. Each value is a
  `$state` object, and the event writes only the properties that changed; the
  row objects and the list stay the same. An unknown session id in the event
  reads `listMySessions` once, because the event has no card.
- **`listMySessions`** is the record method `sessionCloudList()` on the host
  API (`contracts/host-api.ts`, `client-core/workspace-records.ts`). The list
  calls it only on a Solus API connection. An older API that has no route
  answers no entries.
- **The list.** The rows of the connected homes, plus a `cloudOnly` row for
  each cloud entry that no home lists. A cloud entry whose last run host is
  connected and does not list it gets no row (that host archived it). One row
  for one session id: a home's record always wins over a cloud entry. The row
  opens on the saved host that ran the last turn (`savedRunnerFor`), else on the
  Run on host. `forgetHost` of a Solus API (sign-out) removes its entries and
  facts.
- **Opening a cloud-only row** (`SessionOpening.openCloudSession`, from the
  sidebar and `revealSession`) makes a tab with the session id, the card's
  title, provider, and model, and no conversation. It calls
  `RunHostChanges.opened`, so an online run host that is behind prepares from
  the cloud at once. The conversation shows `ConversationAwaitsMachine` ("The
  conversation shows here when you select a machine in Run on.") while
  `conversationAwaitsMachine` is true. When the run host is current
  (`sessionPrepare` answers `current`, or the sync card ends `done`), the owner
  loads the conversation with `resumeSession(meta, { intoTabId })`. A host
  that comes back (`hostReady`) does the same for its tabs.
- **The source rule** (`sessionSyncOrigin` in `client-core/session-heads.ts`).
  The newest head is the larger `syncedTurn` among the connected hosts and the
  cloud; a tie goes to the hosts. When the cloud is newer, the prompt and
  `sessionPrepare` carry `knownHead` = the cloud head and `sourceHostId` =
  `lastRunHostId` as the cloud names it, though this client may not reach that
  host. A run host that has the cloud head, or that ran the last turn, gets no
  head. `afterTurnSettled` counts past the cloud's `syncedTurn`.
  `newestSessionServer` gives the host that the row and the Run on note name.
- **States** (`sessionCloudState` in `client-core/session-cloud-state.ts`), in
  the places phase 4A chose. The Run on row under the composer shows one note
  (`runHostRowNote`): "Running on <host>" first, then "<host> is offline", then
  "Not synced yet". "Not synced yet" shows when a host has a larger
  `syncedTurn` than the cloud and the cloud has a copy; it ends when
  `session.headChanged` reports the count. "Running on <host>" counts only a
  `runningHostId` that names a connected host other than the run host; Run on
  is locked then, and `promptTab` first moves the tab to that host
  (`RunHostChanges.followRunningHost`), so the prompt joins that turn's queue.
- **The refused push.** `PushRefusedCard` takes the place of the setup card:
  "This session continued on <host>. The turns on this machine are not in it."
  with **Fork** (`forkTab`) and **Use the newer copy**
  (`RunHostChanges.useNewerCopy`: a `sessionPrepare` with the cloud head, then
  the conversation is read again). It shows when the run host's session info
  has `pushRefusedHead` (read as optional; the contract does not declare it
  yet), when a prompt is refused with `SESSION_DIVERGED` (the text goes back to
  the composer), or when the status card has `promptRefusalCode:
  'SESSION_DIVERGED'`.

#### Client-core for mobile

- `session-heads.ts`: `SessionHostTurn.pushRefused?`, `SessionCloudHead`,
  `SessionSyncOrigin`, `sessionSyncOrigin(turns, runServerId, cloud)`,
  `newestSessionServer(turns, preferServerId, cloud)`, and
  `afterTurnSettled(turns, serverId, cloudTurn = 0)`.
- `session-cloud-state.ts`: `SessionCloudState`, `sessionCloudState(input)`,
  `sessionCloudStateText(state, hostLabel)`, `conversationAwaitsMachine(input)`.
- `workspace-records.ts`: `sessionCloudList()`.

#### Decisions

1. **The refused-push property is `pushRefusedHead`** on `SessionMeta`, after
   the column `push_refused_head`. The client reads it as optional and does not
   add it to the contract, because the server worker owns that change.
2. **A running host that this client cannot reach is not counted** (design
   §5.4): its fact can be stale after a crash. The prompt then goes to the run
   host as before.
3. **A cloud-only row opens on the saved last run host when this client keeps
   it**, so the composer says that host is offline, as phase 4A does. Else it
   opens on the Run on host, which prepares from the cloud at once. With no
   host at all, a toast says "Connect a machine to continue this session".
4. **"Not synced yet" needs a cloud copy.** Before the first push, or with
   cloud sync off, nothing shows: the client cannot tell "waiting" from "off".
5. **Tie to the hosts.** An equal `syncedTurn` uses the host's copy.
6. **Cloud-only rows are personal** (`organizationId: 'local'`): they show in
   every organization window, as a personal host's sessions do.

#### Limits

- No search or picker result for a cloud-only session (phase 5 reads).
- Archive and snooze of a cloud-only row go to the Solus API, which keeps no
  list state for a `person:` session (D2), so they are not kept.
- A prompt sent before the conversation of a cloud-only tab loads shows only
  the new turn; the older turns show after the session is opened again.
- After "Running on <host>" moves the tab, the transcript shows the turns this
  client had; that host's own older turns show after a reopen.
- A reload of a cloud-only tab before a host has it restores an empty tab on
  the same host; a pick in Run on or a prompt makes a host current and loads it.
- Mobile is not changed.

### Integration fixes (2026-11-19)

- The shared sync card has typed text for `not-signed-in` and `commit-failed`. Desktop, web, and mobile use it.
- A sync gate test now passes the bundle output path in the correct callback position. The path is absolute and lies in the sync's removed temporary directory. The repository writer rejects a relative bundle path.
- A refused-push test uses two local copies and `file://` remotes. The fork has a separate repository. Its provider fork file contains the second host's earlier turn and the fork turn. The original remote stays at the first host's head.
- A cloud prepare test checks that the host adopts the newer head, clears the refused state, admits a prompt, and keeps the old local head under `refs/solus/refused/<sha>`.

### Part E as implemented (mobile)

Mobile (`apps/mobile/`). No server, client-core, or Svelte change. The phone
uses `session-heads.ts` and `session-cloud-state.ts` from client-core, as
desktop and web do.

- **The connection.** The phone already has a Solus API connection for an
  organization (`HostConnections.solusApi`, the one webhooks use). When the
  person is signed in and works in an organization whose Solus API the account
  directory lists, `SolusApp` follows that connection for the cloud's
  sessions. `listMySessions` answers the person's own `person:` sessions on
  any organization's Solus API, so one connection is enough.
- **The four facts.** `CloudSessions` (`features/threads/cloud-sessions.ts`,
  `app.cloudSessions`) keeps one thread record for each session that
  `listMySessions` answers. `head`, `syncedTurn`, `lastRunHostId`, and
  `runningHostId` are plain properties of that record. `session.headChanged`
  writes the properties that changed in place, and the record object stays.
  An event for a session with no record lists again, because the event has no
  card. A list read with the same card keeps the record; a new card is a new
  record, so its row draws again. The list is read when the connection is
  ready and again on each accepted connection, so a reconnect has no stale
  fact. The cloud names hosts by account host id; the phone finds its saved
  host by `uplink.hostId`.
- **The list.** `ThreadDirectory` adds one `cloudOnly` row for each cloud
  record that no host lists (in or out of the list). A host's record always
  wins. A record whose last run host is connected gets no row, because that
  host archived it. The row opens on the saved last run host, else on the first
  connected host, else on the first saved host. With no host at all there is
  no row. The row's host line is the last run host's label, or "Solus Cloud"
  when the phone keeps no host that ran it.
- **Opening a cloud-only row.** The thread opens with `fromCloud`. When the
  host answers `describeSession` with no copy, the conversation reads no
  history and shows a calm empty state, "This session is in Solus Cloud. The
  conversation shows here when a host has it. Select a host in Run on, or send
  a prompt." (`conversationAwaitsMachine`). The open calls
  `SessionRunHosts.opened`, which prepares the host from the cloud at once.
  When `sessionPrepare` answers `current`, or the sync card ends `done`, the
  conversation reads the host's history in the folder the host keeps the
  session in. A cloud-only thread is not saved as the last route.
- **The source rule.** `SessionRunHosts` reads the cloud head
  (`cloudHeadFor`). `promptFields`, `opened`, and `prepare` use
  `sessionSyncOrigin`; `newestHostOf` uses `newestSessionServer`;
  `noteTurnSettled` counts past the cloud's `syncedTurn`. When the cloud is
  newest, `sourceHostId` is `lastRunHostId` as the cloud names it.
- **States.** `useRunHostRow` computes `sessionCloudState` and
  `runHostRowView` takes it. The row under the composer says "Running on
  <host>" first, then "<host> is offline", then "Not synced yet". The cloud
  note shows also when no other host can be chosen. "Running on <host>" locks
  the host control, and the composer sends the prompt to the conversation on
  that host (`useRunningHostSend`, `ThreadRouteScreen.followHost`): the thread
  moves there at once, as a pick does.
- **The refused push.** `SessionPushRefusedCard` shows above the row: "This
  session continued on <host>. The turns on this machine are not in it." with
  **Use the newer copy** (`ConversationController.takeNewerCopy`: a
  `sessionPrepare` with the cloud head, then the history is read again). It
  shows when the host's session info has `pushRefused`, when a prompt is
  refused with `SESSION_DIVERGED`, or when a status card has
  `promptRefusalCode: 'SESSION_DIVERGED'`. The phone has no session fork, so
  there is no Fork action (portable-sessions.md §16 decision 5).
- **Sign-in, sign-out, reconnect.** A new connection (sign-in, another
  organization) drops what the old one gave, then lists again. Sign-out
  follows no connection: the cloud records and the cloud-only rows go, and the
  phone ends that Solus API connection, because it belongs to the account.

#### Decisions

1. **The controller method is `takeNewerCopy`** and the run host owner's is
   `prepareNewerCopy`. The React compiler reads a name that starts with `use`
   as a hook.
2. **A cloud-only row with no saved last run host opens on the first
   connected host**, which prepares from the cloud at once. The row says
   "Solus Cloud", not a host it did not run on.
3. **The cloud note shows without a host choice.** "Not synced yet" is a fact
   of the session, not of the choice.
4. **The phone sends no repository** with a prepare from the cloud, as phase
   4B decided. A host with no checkout of the project fails with
   `no-project-checkout`.

#### Limits

- A person with no organization, or an organization whose Solus API the
  directory does not list, has no Solus API connection on the phone: no cloud
  facts and no cloud-only rows. The same limit applies to desktop and web.
- The phone reads no organization session records from the Solus API
  (`session-archive.md`, Limits), so the cloud facts of a published
  organization session are not on the phone.
- No search result for a cloud-only session. Settle, snooze, archive, and
  rename of a cloud-only row say "Open this session on a host first": Solus
  Cloud keeps no list state for a personal session (D2).
- No person checked the screens on a phone; the states are covered by unit
  tests only.

### Phase 5A as implemented (archive slice, 2026-11-19)

The host archive writer now accepts an injected history read. Boot supplies the
lineage-aware, one-turn history page and applies `projectSessionHistory`, the
projection used by the transcript mirror. At turn capture, the writer saves the
projected rows in its durable pending-turn record. The background Git job writes
one JSON object per line to `rows/<n>.jsonl`. It marks the manifest turn with
`hasRows` and the cumulative `rowCount`. Both fields are optional so an older
manifest still parses. A failed or oversized row read leaves `hasRows: false`
and does not stop the thread-file commit.

The host reads one history page for each ended turn. It does not parse the
whole transcript for each Git commit. The pending row file has a 4 MiB cap;
an over-limit turn has no row file. The page reader can cut inside a very long
turn. If its first row is not a user turn, the writer omits the rows rather
than saving an incomplete turn. This phase does not yet add the API reader,
read-only history fallback, turn-diff RPC, or client contract. Those remain
open before a client can read an offline session.

### Part L as implemented (2026-11-19)

The Lab now has a bare Git project origin and one clone for each host. Its mock
backend writes a small provider thread file at each turn, exports and imports
that file, and records whether the next run starts, resumes, or forks a thread.
`packages/lab/scenarios/cloud/portable-sessions.ts` drives two signed-in
personal hosts through the real local cloud and Solus API. The API uses
`SOLUS_SESSION_STORAGE=local-git`. The latest run wrote evidence to
`.solus-local/lab-cloud/evidence/run-2026-11-20T04-08-32-750Z/`.

| Step | Result | Evidence |
|---|---|---|
| Host A commits turn 1 and pushes it | PASS | API row has `synced_turn=1` and A's `last_run_host_id`. |
| Host B prepares while A is stopped, then runs turn 2 | PASS | Same session id; API has two turns and B's host id. Both repositories have the same turn 1 tree. B has the same imported thread file and its mock run records `resume`. |
| Host A restarts, syncs, and runs turn 3 | PASS | API has three turns and A's host id. |
| Host B forks from A's newest turn | FAIL | B logged `session_sync_failed`, `reason=source-offline`: the cloud source said it was behind the requested head. The Lab's stub host route could not supply the fallback. |
| Cloud sync off, host B transfers from A while A is online | FAIL | B logged `session_sync_failed`, `reason=source-offline`: its cloud directory route points at the Lab's stub tunnel hostname, so it cannot dial A. |
| Cloud sync off, A stopped | PASS | B's client received a status card with `syncFailureReason=source-offline`. |
| Refused push and divergence recovery | NOT RUN | The scenario has no test-only API outage seam yet. |
| Organization read-standing refusals | NOT RUN | The scenario has no organization variant yet. |

The host fallback failures expose a Lab topology limit, not a proven product
defect: the Lab cloud uses a stub tunnel URL and provides no dialable route
between its two spawned hosts. The fork failure needs a separate check after
the Lab can dial the source. No feature code was changed. The first fork run
also showed a scenario error: `forked` belongs in `SessionCtx`, not prompt
options; the scenario now sends it there. The first B resume run showed the
same kind of input error: `agentSessionId` must name the imported provider
thread. The scenario now sends it. The final run has 16 passing and two
failing checks. Focused unit tests passed 16/16 in three files; one new test
checks that the project origin gives independent clones with the same tree.

### Phase 5A as implemented (API reader, 2026-11-19)

The host records the wall time when a turn settles. The archive history reader
uses one provider history page at a time, starting with the newest. If a later
turn is present, it follows the page cursor until it finds the user turn that
started before the saved settlement time. It saves the projected rows in the
pending database row before Git starts. A restart uses those saved rows. The
normal cost is one provider page per ended turn; a late capture reads one extra
page for each later turn. It never parses the whole transcript for each commit.
A provider page cut inside a long turn gives `hasRows: false`.

The API reads `manifest.json`, `rows/<index>.jsonl`, and
`diff/<index>.patch` only at `session_repositories.head`. A repository commit
that the API has not accepted is not visible. The API uses the injected
Cloudflare Artifacts REST file read or `git --git-dir` for local Git. It sends
only projected `WireSessionLoadMessage` rows or patch text. The row file has
one JSON object per line, in provider history order. The API parses the named
wire fields and projects again if a tool row has a body.

The existing `loadSessionPage` RPC uses repository rows when no mirrored rows
exist. Its `before` cursor is the next older turn index as a string. A call
returns one whole turn, even if `turnLimit` is greater than one. The optional
`availability` is `available` or `not-available`; the latter has
`unavailableTurns: [index]` for an old or omitted row file. A session with no
repository has empty messages, a null cursor, and `not-available`. The
existing `loadSession`, `loadSessionPreview`, and `loadSessionToolInputs` also
use the repository fallback. Preview reads the first and last available turn
and uses the manifest's cumulative `rowCount` for its total. Mirrored rows win when they
can include a running turn. The repository fallback is read only.

The new Solus API operation is `sessionTurnDiff`: `GET
/v1/sessions/:sessionId/turns/:turnIndex/diff`, with `sessions:read` scope and
no query or body. It answers `{status:"available",patch:string}`,
`{status:"too-large",filesChanged:number,additions:number,deletions:number}`,
or `{status:"not-available"}`. A missing repository, turn, or patch answers
`not-available`. The counts of a large patch are sums of the turn snapshots.
No repository remote, token, thread file, or code bundle reaches a reader.

Caps: one manifest read is at most 1 MiB; one row file and RPC history page is
at most 4 MiB; one patch response is at most 2 MiB. Both storage providers
stop reading after the file cap. The writer already caps one pending row file
at 4 MiB. The API keeps no manifest cache, so a history or diff request holds
only its bounded files. Preview reads two row files in sequence. A personal repository requires the caller's user id to equal
its owner id. An organization repository requires a published session and the
same `read.transcript` standing as the mirror. The diff uses that standing too:
the patch can contain code, and a person who can read the transcript
can also see the turn's code changes. These are Phase 5A choices that the plan
left open.

#### Verification continuation (2026-11-19)

The cloud's development directory gives each host its real loopback port, but
labels the route `tunnel`. `RemoteHosts.safeHostDialRoute` rejected that cleartext
route by its label. It now accepts a route whose URL is local, using the same
local route rule as a paired host. A focused test covers the Lab's exact route.
The two failed Lab steps still need a new run; the cloud could not start in this
checkout. Vite reported `TSCONFIG_ERROR: Failed to load tsconfig
'expo/tsconfig.base'`. The sibling cloud checkout is read only for this work.

The source choice also failed immediately when the cloud was behind and the
source host was offline. It now retries the cloud for up to 15 seconds after
that host error. Stop aborts the retry. Real Git tests prove a delayed push
becomes the fetched head and Stop ends the wait. The sync stays on `fetch`
because the source choice does not return before the retry ends.

| Step | Result in this continuation | Evidence |
|---|---|---|
| Host A commits turn 1 and pushes it | NOT RUN | Cloud startup stopped before a scenario could start. |
| Host B prepares while A is stopped, then runs turn 2 | NOT RUN | Same startup block. |
| Host A restarts, syncs, and runs turn 3 | NOT RUN | Same startup block. |
| Host B forks from A's newest turn | NOT RUN | Same startup block; route and delayed-push fixes have unit proof only. |
| Cloud sync off, host B transfers from A | NOT RUN | Same startup block; loopback route has unit proof only. |
| Cloud sync off, A stopped | NOT RUN | Same startup block. |
| Refused push and divergence recovery | NOT RUN | Same startup block; no test-only API outage seam was added. |
| Organization read-standing refusals | NOT RUN | Same startup block; no organization variant was added. |

Evidence: `.solus-local/lab-cloud/evidence/2026-11-20T04-21-22-553Z/cloud.log`.
The Lab startup command was `SOLUS_CLOUD_DIR=/Users/sidhu/solus-cloud
SOLUS_SESSION_STORAGE=local-git bun lab up --cloud`. Its owned child processes
were stopped by the Lab's error cleanup.
