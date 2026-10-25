# The Lab

The Lab tests multiplayer without a room full of people (docs/plans/multiplayer-sharing.md §8). One process boots:

- an **issuer**: an in-process ES256 key with a JWKS endpoint on loopback, which mints the grant the Solus cloud would sign for each persona;
- a **host**: the built standalone Solus server on a temporary data directory, linked to that issuer by a hand-written link record, so its proxied listener admits grants only and its verifier trusts only the Lab's key;
- a **Solus API** for the run (`src/solus-api.ts`, SQLite), which every link the issuer issues names, so a host can admit organization work (plans/009-organization-vms.md §4). The personal host is shared with the organization and holds its key (`runnerOf`), so it acts for members; a host owner's connection names the organization;
- one **LabClient** per persona, which walks the real admission path: a fresh grant per dial, exchanged at `/auth/ws-ticket` for a one-use ticket, then a Socket.IO connection with typed RPC and host events;
- **scenarios**: scripted proofs, one file per exit test, run against a personal and a managed host.

The host never sees `~/.solus`; the daemon refuses a data directory outside a temp location.

## Run

```bash
bun lab build                            # the host the Lab boots; rebuild after server changes
bun lab run all                          # every scenario, both host flavors
bun lab run share-matrix --host managed  # one scenario, one flavor
bun lab run guest-revoke --keep          # keep the data directory and lab.log for diagnosis
```

`bun lab` is `scripts/lab.ts`. When the Lab exits, it stops every host it started and did not stop (only those PIDs), so a scenario that fails part way leaves no server behind. Each run prints every check and a report; the exit code is non-zero on any failed check. The timeline of every dial, call, event, and check is `<dataDir>/lab/lab.log` (NDJSON), the host's own log is `<dataDir>/dev.log`, and its stdout is `<dataDir>/lab/host.log`.

The `cloud-workspace` scenario boots its own **Solus API** (`src/solus-api.ts`: the same build in API mode, `SOLUS_API=1`, on a temporary data directory, SQLite by default) and its own **runner** (a personal host the issuer links and attaches to the organization). It runs once on SQLite, and once more on Postgres when `POSTGRES_ADMIN_URL` names a server the Lab may create a database on (one fresh database per run, dropped after):

```bash
docker run -d -e POSTGRES_PASSWORD=solus -p 54335:5432 postgres:17
POSTGRES_ADMIN_URL=postgres://postgres:solus@localhost:54335/postgres bun lab run cloud-workspace --host personal
```

## Personas

| Persona | Kind | Standing |
|---|---|---|
| alice | organization owner (host owner on a personal host) | founded the organization |
| bob | organization member | in no team |
| cara | organization member | in team A |
| dan | organization member | in no team |
| maya | guest | a visitor with a share link and no account |
| carol | owner of another organization | on the Solus API, sees nothing of the Lab organization |

`--host personal` makes alice the machine's owner too: the issuer mints her an owner grant, and `ctx.client('alice', { route: 'local' })` reaches the ordinary listener credential-free. `--host managed` has no owner person; alice reaches the host only through grants.

## Scenarios

- `uplink-admission` — grant per dial, ticket one-use, credential-free refused on the tunnel route, expiry disconnect.
- `share-matrix` — every persona against the role matrix on one work; guest admission with the link secret; host administration by flavor; ownership transfer.
- `guest-revoke` — regenerating or removing the link ends every guest socket within a second; a removed member's next call fails and they are told who did it.
- `guest-roles` (docs/plans/custom-roles.md) — a session link with a custom role: the default link watches, sees changes, and suggests, and is refused prompts and file reads; maya's suggestion runs as alice's turn, prefixed with who wrote it; prompting does not bring approval; a change of leaves keeps the socket; an expired link ends the guest and admits nobody. Run it alone: after `cloud-workspace` attaches the host, guest turns are refused (features/sharing.md, Gotchas).
- `ownership` — the creator owns a work and a session; only the owner transfers; a managed host has no owner person.
- `presence` — the host names every participant; a session's room is its connected watchers; typing and focus reach the other watcher; a guest gets its one room and never the host roster; a dropped socket leaves every room at once.
- `seats` — a member with no provider seat is refused with `SEAT_REQUIRED` and nothing is spawned; a pasted token seat rides the run; a guest runs on the sharer's seat; two members run at once on their own seats; only the administrator removes a seat. The mock backend records every run it is handed in `<dataDir>/lab/mock-runs.ndjson`, which `src/oracle.ts` reads.
- `member-users` (managed flavor only; docs/plans/member-isolation.md §4, §8) — the Lab plays the host object and writes the users file (`SOLUS_MEMBER_USERS_FILE`). bob, not in it, reads `memberWorkspace: 'preparing'` and is refused with `WORKSPACE_PREPARING`; added, he alone receives `connection.memberWorkspaceReady`, and his run's `seat.launch` carries the file's uid and his username's `HOME`; removed, he prepares again.
- `access-roles` (docs/plans/access-model.md step 5) — bob's automation is his and the administrator's: dan cannot list, read, change, run, cancel, or delete it, and hears none of its events; alice lists and changes it. Its run's notification is bob's alone. In Insights dan reads only his own turns and cannot open bob's; alice reads both, and only she runs SQL. Every member lists bob's project; dan cannot change or remove it, alice can. maya, a guest, is refused all of it.
- `cloud-sessions` (personal flavor only; cloud-service-model.md §18–§19, the P2 exit test) — a runner streams a slow turn whose rows reach the service as they land; the runner is killed mid-turn; the transcript so far is readable and the session listed with the runner dead; the runner restarts on its data directory and its owner prompts it locally; the new turn's rows reach the service and the record settles to idle; bob reads the same rows.
- `host-auth` (personal flavor, SQLite and Postgres Solus API instances) — the service refuses seat RPCs and the removed credential lease route; Claude and Codex seats stay on the selected host. Two hosts use independent logins; disconnect on A leaves B usable; another member cannot use either seat. Providers are mocked, never real accounts.
- `cloud-workspace` (personal flavor only; docs/plans/cloud-service-model.md §15–§16) — alice and bob reach the Solus API with workspace grants; alice's task reaches bob live; a runner linked to the organization runs a mock-agent turn (`__MOCK_AGENT_TOOLS__`, the real `create_task` and `create_work` tools) whose task and work land on the service and not in the runner's own tables; the runner's session record is listed by the service, which keeps all three after the runner stops; carol, of another organization, sees none of it; execution methods answer `PLANE_DISABLED`.

A scenario is `scenario(name, async (ctx) => { ... })` in `scenarios/`; `ctx.as('bob')` is a connected client, `ctx.client(...)` a fresh one, `expectOk` and `expectRefused` record checks, and `src/oracle.ts` holds the invariants scenarios call between steps.

## Light build

`bun lab build` (`src/build.ts`) bundles the standalone server in one esbuild pass into `.solus-local/lab-build/standalone.js`, with its migrations beside it. It replaces the agent backends and the skills provider with the test mocks in `tests/e2e/mock/`, as `BUILD_TARGET=test` does. It does not build the renderer, the preload, or Electron, and it does not write to `dist/`. It takes less than one second and about 500 MB at its peak. Do not use `bun run build:test` for the Lab. `SOLUS_LAB_ENTRY` names another server file.

## Cloud mode

Cloud mode tests account and host features against the real Solus cloud, not the Lab issuer. It needs the `solus-cloud` checkout beside this one (or `SOLUS_CLOUD_DIR`). It needs no Docker, and it does not touch production.

The cloud reads `@solus/contracts` (and the other Solus packages) from `SOLUS_REPO`, default `../solus`. To run it against this checkout when it is not `../solus` (a worktree), set `SOLUS_REPO` to this checkout for every Lab cloud command: `up` passes its environment to `vite dev`.

```bash
export SOLUS_CLOUD_DIR=/path/to/solus-cloud SOLUS_REPO=$PWD
```

```bash
bun lab build
bun lab up --cloud                    # start the local cloud and one host; leave them running
bun lab run cloud-signin --cloud      # a scenario of scenarios/cloud/ against them
bun lab run all --cloud
bun lab down                          # stop them; keep the logs
```

`bun lab up --cloud` (`src/local-cloud.ts`) does these steps:

1. It starts PGlite on a temporary data directory and serves it on the Postgres wire protocol on a free loopback port (`src/pglite-server.ts`). The server gives the one PGlite session to one connection for each whole exchange (to `Sync`, and for the length of a transaction).
2. It applies the cloud's migrations with `bun run db:migrate` in the checkout.
3. It starts the cloud's `vite dev` on a free port with `ENVIRONMENT=development`, a random `BETTER_AUTH_SECRET` and `INTEGRATION_VAULT_KEY`, a new `SOLUS_API_CLIENT_KEY`, `SOLUS_API_URL` (the Solus API of step 4), and `DEVELOPMENT_ACCESS_TOKEN_TTL_SECONDS=90`. It sets every key of the checkout's `.env` files that the Lab does not set to empty, so mail goes to the console, tunnels are stubs, and managed hosts stay in memory. It loads the cloud's own provider fixture (`scripts/e2e/integration-provider-fixture.mjs`, `SOLUS_INTEGRATION_PROOF=1`, the `proof-client` OAuth apps; `LAB_PROVIDER_CLIENT`), so a website sign-in to GitHub, Google, or Atlassian completes with no real provider.
4. It starts the **Solus API** (the record service) as production runs it beside the account site (solus-cloud `src/server/main.ts`): the Lab build with `SOLUS_API=1` (`src/solus-api.ts`), on its own SQLite file in the scratch directory, on the port the cloud names, with `SOLUS_CLOUD_ISSUER` the cloud's origin, `SOLUS_CLOUD_JWKS_URL` its `/api/auth/jwks`, and the same `SOLUS_API_CLIENT_KEY`. A host registered to this cloud gets this URL in its registration (`apiUrl`), so organization work has a home.
5. It makes the personas real accounts through the website's HTTP routes: alice signs up and names her organization "Lab"; she invites bob, who signs up and accepts; carol signs up and names her organization "Elsewhere". The Lab reads each verification link from the console mailer's output. The passwords are random for each stack.
6. It starts one host from the Lab build: personal, not registered, on a temporary `SOLUS_DATA_DIR`, with `SOLUS_TUNNEL_PORT` on a free port and `SOLUS_DEV_LOG` in that directory.

It writes the facts (origin, database URL, the Solus API's URL, the access-token life, PIDs, directories, persona emails, passwords, and user ids) to `.solus-local/lab-cloud/stack.json`. `bun lab down` stops only the PIDs in that file, copies the host's and the Solus API's logs to `.solus-local/lab-cloud/evidence/<start time>/`, and removes the temporary directories.

Every Lab host gets its own `HOME` and `CODEX_HOME` in its data directory. An owner's agent profile pull writes to the host login's homes (`~/.claude`, `~/.codex`), and a Lab host must never write the developer's own.

### A cloud run

`bun lab run <scenario|all> --cloud` writes one evidence directory per run, `.solus-local/lab-cloud/evidence/run-<time>/`, which `down` keeps:

- `lab.log`: every step, check, and clean-up of the run (NDJSON);
- `<scenario>/host-<n>/`: the log and Lab files of each host the scenario booted;
- `cloud.log`: the cloud's output at the end of the run;
- `summary.json`: each scenario's checks, failures, clean-up failures, and time.

The run ends with one table: `PASS|FAIL  <scenario>  <checks>  <failed>  <seconds>`.

Each scenario starts clean and ends clean, so the scenarios run in any order. It boots its own hosts (`ctx.bootHost`), not the host of `up`, and stops them at its end. What it changes on the account, it undoes with `ctx.defer` (remove the host, remove the profile entry and the vault key). Its sign-ins are signed out at its end.

### Helpers

`src/cloud-sign-in.ts`:

- `signIn(stack, persona, client?)` signs in with the website password over HTTP, then does the real authorization code + PKCE flow with client-core's `OAuthSession`, as `solus-desktop` (default) or `solus-mobile`. The Lab's `BrowserAuthorizer` calls the authorize endpoint with the website cookie and takes the code from the redirect. No browser and no listener are necessary. Use `oauth.accessToken({ kind: 'host', hostId })`, `{ kind: 'account' }`, or `{ kind: 'api' }`, and `oauth.state()` for the identity. `store` holds the refresh token; `revocations` records the status of each revocation.
- `registerHost(stack, host, signedIn)` does what the desktop does for its own host: it gets an enrollment ticket with the account token and gives it to the host with `uplinkRegister` over the trusted local connection.
- `hostClient(host, signedIn, hostId, { asOwner, organizationId? })` is a `LabClient` that dials the host's ticket door with the person's access token for the host. The door makes the person's delegation.

`src/cloud-fixtures.ts`: `accountApi` (a call with the person's account token), `directory`, `removeHost` (the website's "Remove host"), `localRpc` and `uplinkStatus` (as the trusted local owner), `hostKeyOf` and `controlTokenWith` (the host's key, and a client credentials request signed with a given key), `ownedRegisteredHost` (alice signs in, registers a new host, and dials it), `profileMcpServer` (a local fake MCP server that takes one bearer key, put in alice's profile), `accountMcpServer` (the same, and its key in her vault with `PUT /v1/account/vault`), `deferVaultRemoval` (a ref leaves her vault at the end), and `pullAndRead`.

`src/cloud-mode.ts`: the context. `ctx.signIn`, `ctx.bootHost({ flavor?, environment? })`, `ctx.restartHost(host)`, `ctx.defer(name, work)`, `ctx.until(read, accept, ms)`, `ctx.step`, `ctx.check`, and `host.log()`, the host's log entries.

A cloud scenario is `cloudModeScenario(name, async (ctx) => { ... })` in `scenarios/cloud/`.

### Scenarios

- `cloud-signin`: alice signs in with no browser; her identity comes from the ID token and `/userinfo`; she registers a host with no link; she dials it with her host token as its remote owner; the host holds her `personal` delegation.
- `registration`: a host registered with no link is in the directory with no route; `uplinkStatus` says registered and not linked. "Remove host" ends the registration: the directory drops it, its key gets no token, and after a restart the host reads as not registered and forgets its key. Registering again keeps the host id, advances the generation, and makes a new key; the token endpoint refuses the old key (401 `invalid_client`) and takes the new one.
- `account-reads`: a key for an MCP server in alice's account vault (`PUT /v1/account/vault`) reaches the server through her host. The host pulls her profile with her personal delegation, adopts the connection from the cloud (`connected`, source `cloud`), and lists the server's tools with that key.
- `link`: before the link, while linked, and after unlink, the host id, the generation, the delegations, and an account read do not change. The directory route appears and goes. In development the route is the host's own proxied listener on loopback; `GET <route>/health` answers 200, and alice dials the host there.
- `cloud-machine`: bob, a member, creates a managed host through `POST /v1/hosts`. The development provider prints the machine's `SOLUS_HOST_LINK` in the cloud log; the Lab boots a host with it. The host registers its own key with the one-time ticket. The directory lists it with a route for the members. alice and bob get 300 s host tokens that list the organization, and pass its ticket door as members. carol gets no token (`invalid_target`, `host_not_found`).
- `sign-out`: alice's desktop signs out (revocation 2xx). The revoked refresh token gets nothing; an account read with the host's delegation is refused at once. The host's next delegation refresh is refused (`GRANT_REVOKED`), and the host forgets the delegation, within one access-token life (`stack.accessTokenTtlSeconds`, 90 s in the Lab: about 30 s). After a restart, the host does not send the key again. Her mobile sign-in goes on, and gives the host a new delegation.
- `delegation-kept-alive` (ADR 0001 §5 "Delegations kept alive", §6 item 5): alice's desktop dials the host with its token; her mobile client reaches it on the trusted local route and calls `accountPresent` with its host token (`delegated: true`, no second delegation). The desktop signs out; the host learns it only from the refused refresh (`GRANT_REVOKED`) and forgets the delegation; an account read fails. Mobile presents again: a new delegation from the mobile grant, and the account read (account-reads' fake MCP server) works again. Mobile signs out too: its refresh is refused, a token from the ended grant makes no delegation, and account reads fail.
- `settings-sync` (plans/018 §4, plans/020 §2): alice as `solus-desktop` patches `themeMode` through `PATCH /v1/account/settings`; `solus-mobile` reads it at the same revision; a patch against the old revision answers 409 `settings_conflict` with the current document and changes nothing. A file entry (`skills/<name>/SKILL.md`) patched into her agent profile is applied by her host at `agentProfilePull` under the host's own `HOME` (inside its data directory), and not under the developer's `~/.claude`.
- `organization-work` (plans/009 §1, §4, §5): alice registers a host (its registration names the stack's Solus API), shares it with her organization (`POST /v1/hosts/:id/organizations`), and restarts it, so it reads itself attached. She dials it naming the organization; the door makes her organization delegation. Her new session (window organization set) is admitted, and the mock agent's real `create_task` and `create_work` (`__MOCK_AGENT_TOOLS__`) write through the delegation to the Solus API. bob reads the task, the work, and the session record (owner alice, runner her host) there with his own API token; the host's own tables hold none of it; carol sees none of it, and the Solus API's door refuses her when she names alice's organization.
- `profile-across-hosts` (docs/plans/access-model.md §0, §2.1, §2.6; plans/020 §2, §5): alice registers two hosts. Her profile holds an MCP server (`accountMcpServer`; it refuses an anonymous list) and a skill file. Each host pulls the profile: the server is hers (`ownerKey`, `role: 'owner'`), `connected` from the cloud, and the file is under the host's own `HOME`. Host B restarts, so no tool list is cached; alice prompts a new session on it through its ticket door, and the run the mock agent records (`mock-runs.ndjson`, `tools`) has the server's tool, listed with her key only. She shares host B with her organization; bob, a member on his own token seat, cannot list or read her server, and his run has none of its tools.

- `vault` (docs/plans/cloud-vault.md §2.5, signed in means the account): host A is not linked; its local owner keeps a TypeSafe key and the key of an MCP server of alice's profile on it. alice registers and dials host A: the host uploads both into her account vault (`GET /v1/account/vault`) and keeps no provider, TypeSafe, or MCP credential in its `secrets/`; it reads both from the account. Host B reads both from the account with no copy. GitHub connected on the website (the cloud's start page and callback, with the provider fixture in place of GitHub) reaches host A's `providerStatus`. A non-delegated bearer (the hosts token) reads no `provider` and no `typesafe` ref (401). "Remove host" and a restart unlink host A: it keeps nothing of alice's.

There is no `desktop-owner` scenario. The desktop's main process presents its sign-in to its own host through `LocalClient` (`presentToken`, `signedOut`), which only the desktop composition has; the standalone server has no door for it. `tests/unit/local-client.test.ts` and `tests/unit/desktop-local-host-client.test.ts` cover it.

### Development-only parts of the cloud

- `DEVELOPMENT_ACCESS_TOKEN_TTL_SECONDS` (solus-cloud `src/lib/server/config.ts`): in development only, the account, Solus API, and host control tokens live this long (61 to 3600 s; the Lab uses 90). Host tokens keep one hour. Staging and production never read it (`config.test.ts`). A host still learns of a sign-out only from its refused refresh; the shorter life only brings that refresh sooner.
- The directory route of a link made by the development stub tunnel is `http://127.0.0.1:<proxiedPort>`, the host's own listener (solus-cloud `stubTunnelRoute`). A real tunnel keeps `https://<hostname>`; staging and production never use the stub (`tunnels.test.ts`, `hosts.test.ts`).
- `MANAGED_HOST_RELEASE` is set, so the in-memory provider accepts a managed host. It never downloads the release.

### Limits

- A running host learns that it was removed only when it next asks for its own token, or at boot; until then it ignores a new enrollment ticket. `registration` restarts the host to get there.
- After a sign-out, a host keeps using the key it read from the cloud until its delegation's refresh is refused (up to about four minutes deployed; about 30 s in the Lab). This is the limit that ADR 0001 stage 4 accepts.
- A running host reads its standing every five minutes and at boot: `organization-work` restarts the host after the share so that it reads itself attached.
- The Lab build is one directory for every agent on the checkout. A `bun lab build` while a cloud run boots a host makes that boot fail ("No sqlite migrations found"); run again.
- A managed host stays in its organization after `cloud-machine`; only the organization's owner deletes it, on the website. Each run makes a new organization.
- Sign-up depends on the network: the cloud checks each new password with a breach service. `up` asks again after a 5xx.
- The first request to `vite dev` compiles the server routes; `up` waits for it.

## Browser proofs

`scripts/lab-guest-proof.ts` walks a share link through the built web client in headless Chromium against a Lab host. It builds the client into `.solus-local/` and serves it at `/`, as the account origin does, and puts screenshots in `.solus-local/artifacts/`.

## Not yet

`lab as <persona> …` (a daemon behind a Unix socket for a fleet of subagents), the mock Codex backend and prompt directives, the browser lane, and the convergence and presence invariants arrive with the phases that need them. The seat scenario uses pasted tokens; the relayed browser login is a real-provider proof done by hand.

### Cloud sharing (P4)

`cloud-sharing` proves server-owned work publication through `publicationStart`,
including history, comments, and source removal, offline work reads, the refusal of a
task share link, cross-organization
refusal and the absence of a runner guest door. `cloud-sessions` additionally proves
an offline guest transcript and an online prompt under the sharer's execution-host seat.
`share-matrix` and `guest-revoke` now run against the Solus API,
not the personal/managed host. Set `POSTGRES_ADMIN_URL` to a disposable Postgres
server to run both workspace engines. `bun scripts/lab.ts run all` is the command.

The optional browser proof is `bun scripts/lab-guest-proof.ts` after `bun lab build`;
run it only when browser verification is authorized. It checks `/w/<id>#<secret>`
on laptop and phone sizes with no runner.


### Cloud work change checks

`cloud-sharing` checks the version RPC over the real transport, editor saves,
stale-save refusal and organization access. Run on SQLite and disposable
Postgres using `POSTGRES_ADMIN_URL`. Live-work and listener-recovery scenarios
were removed with P5 live editing. Session multiplayer scenarios remain.

### Account integration callback proof

The sibling `solus-cloud/scripts/e2e/integration-flow.ts` drives real account
forms and callbacks with simulated upstream providers, a disposable Postgres,
and a real isolated Solus host. It verifies direct account delivery and host
reads after disconnect. `scripts/prove-account-integrations-host.ts` supplies
the host half. No real credentials or production state are used.
