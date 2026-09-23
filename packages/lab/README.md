# The Lab

The Lab tests multiplayer without a room full of people (docs/plans/multiplayer-sharing.md §8). One process boots:

- an **issuer**: an in-process ES256 key with a JWKS endpoint on loopback, which mints the grant the Solus cloud would sign for each persona;
- a **host**: the built standalone Solus server on a temporary data directory, linked to that issuer by a hand-written link record, so its proxied listener admits grants only and its verifier trusts only the Lab's key;
- one **LabClient** per persona, which walks the real admission path: a fresh grant per dial, exchanged at `/auth/ws-ticket` for a one-use ticket, then a Socket.IO connection with typed RPC and host events;
- **scenarios**: scripted proofs, one file per exit test, run against a personal and a managed host.

The host never sees `~/.solus`; the daemon refuses a data directory outside a temp location.

## Run

```bash
bun run build:test                       # mock agent backends; rebuild after server changes
bun lab run all                          # every scenario, both host flavors
bun lab run share-matrix --host managed  # one scenario, one flavor
bun lab run guest-revoke --keep          # keep the data directory and lab.log for diagnosis
```

`bun lab` is `scripts/lab.ts`. Each run prints every check and a report; the exit code is non-zero on any failed check. The timeline of every dial, call, event, and check is `<dataDir>/lab/lab.log` (NDJSON), the host's own log is `<dataDir>/dev.log`, and its stdout is `<dataDir>/lab/host.log`.

The `cloud-workspace` scenario boots its own **workspace service** (`src/workspace.ts`: the same build in workspace mode, `SOLUS_WORKSPACE=1`, on a temporary data directory, SQLite by default) and its own **runner** (a personal host the issuer links and attaches to the organization). It runs once on SQLite, and once more on Postgres when `POSTGRES_ADMIN_URL` names a server the Lab may create a database on (one fresh database per run, dropped after):

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
| carol | owner of another organization | on the workspace service, sees nothing of the Lab organization |

`--host personal` makes alice the machine's owner too: the issuer mints her an owner grant, and `ctx.client('alice', { route: 'local' })` reaches the ordinary listener credential-free. `--host managed` has no owner person; alice reaches the host only through grants.

## Scenarios

- `uplink-admission` — grant per dial, ticket one-use, credential-free refused on the tunnel route, expiry disconnect.
- `share-matrix` — every persona against the role matrix on one work; guest admission with the link secret; host administration by flavor; ownership transfer.
- `guest-revoke` — regenerating or removing the link ends every guest socket within a second; a removed member's next call fails and they are told who did it.
- `ownership` — the creator owns a work and a session; only the owner transfers; a managed host has no owner person.
- `presence` — the host names every participant; a session's room is its connected watchers; typing and focus reach the other watcher; a guest gets its one room and never the host roster; a dropped socket leaves every room at once.
- `task-share` — a task shared with a person by name opens its page, the session under it, and the document linked to it at the task's role; the person's own row survives a scope change; a guest with a task link reaches exactly the task and its contents, prompts as an editor on the sharer's seat, and is ended when the link is turned off; only the owner deletes.
- `seats` — a member with no provider seat is refused with `SEAT_REQUIRED` and nothing is spawned; a pasted token seat rides the run; a guest runs on the sharer's seat; two members run at once on their own seats; only the administrator removes a seat. The mock backend records every run it is handed in `<dataDir>/lab/mock-runs.ndjson`, which `src/oracle.ts` reads.
- `cloud-sessions` (personal flavor only; cloud-service-model.md §18–§19, the P2 exit test) — a runner streams a slow turn whose rows reach the service as they land; the runner is killed mid-turn; the transcript so far is readable and the session listed with the runner dead; the runner restarts on its data directory and its owner prompts it locally; the new turn's rows reach the service and the record settles to idle; bob reads the same rows.
- `host-auth` (personal flavor, SQLite and Postgres workspace services) — the service refuses seat RPCs and the removed credential lease route; Claude and Codex seats stay on the selected host. Two hosts use independent logins; disconnect on A leaves B usable; another member cannot use either seat. Providers are mocked, never real accounts.
- `cloud-workspace` (personal flavor only; docs/plans/cloud-service-model.md §15–§16) — alice and bob reach the workspace service with workspace grants; alice's task reaches bob live; a runner linked to the organization runs a mock-agent turn (`__MOCK_AGENT_TOOLS__`, the real `create_task` and `create_work` tools) whose task and work land on the service and not in the runner's own tables; the runner's session record is listed by the service, which keeps all three after the runner stops; carol, of another organization, sees none of it; execution methods answer `PLANE_DISABLED`.

A scenario is `scenario(name, async (ctx) => { ... })` in `scenarios/`; `ctx.as('bob')` is a connected client, `ctx.client(...)` a fresh one, `expectOk` and `expectRefused` record checks, and `src/oracle.ts` holds the invariants scenarios call between steps.

## Cross-repository proof

`scripts/lab-cloud-proof.ts` boots a host that trusts a running Solus cloud dev server instead of the Lab issuer, links it there, and proves that cloud-minted owner, member, and guest grants are admitted by the host with the right principals.

## Browser proofs

`scripts/lab-guest-proof.ts` walks a share link through the built web client in headless Chromium against a Lab host. It builds the client into `.solus-local/` and serves it at `/`, as the account origin does, and puts screenshots in `.solus-local/artifacts/`.

## Not yet

`lab up`, `lab as <persona> …` (a daemon behind a Unix socket for a fleet of subagents), the mock Codex backend and prompt directives, the browser lane, and the convergence and presence invariants arrive with the phases that need them. The seat scenario uses pasted tokens; the relayed browser login is a real-provider proof done by hand.

### Cloud sharing (P4)

`cloud-sharing` proves work snapshot push, offline work/task reads, cross-organization
refusal and the absence of a runner guest door. `cloud-sessions` additionally proves
an offline guest transcript and an online prompt under the sharer's execution-host seat.
`share-matrix`, `guest-revoke` and `task-share` now run against the workspace service,
not the personal/managed host. Set `POSTGRES_ADMIN_URL` to a disposable Postgres
server to run both workspace engines. `bun scripts/lab.ts run all` is the command.

The optional browser proof is `bun scripts/lab-guest-proof.ts` after `build:test`;
run it only when browser verification is authorized. It checks `/w/<id>#<secret>`
on laptop and phone sizes with no runner. Never run `build` while Lab processes
use the test bundle.


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
