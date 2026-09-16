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

## Personas

| Persona | Kind | Standing |
|---|---|---|
| alice | organization owner (host owner on a personal host) | founded the organization |
| bob | organization member | in no team |
| cara | organization member | in team A |
| dan | organization member | in no team |
| maya | guest | a visitor with a share link and no account |

`--host personal` makes alice the machine's owner too: the issuer mints her an owner grant, and `ctx.client('alice', { route: 'local' })` reaches the ordinary listener credential-free. `--host managed` has no owner person; alice reaches the host only through grants.

## Scenarios

- `uplink-admission` — grant per dial, ticket one-use, credential-free refused on the tunnel route, expiry disconnect.
- `share-matrix` — every persona against the role matrix on one work; guest admission with the link secret; host administration by flavor; ownership transfer.
- `guest-revoke` — regenerating or removing the link ends every guest socket within a second; a removed member's next call fails and they are told who did it.
- `ownership` — the creator owns a work and a session; only the owner transfers; a managed host has no owner person.
- `seats` — a member with no provider seat is refused with `SEAT_REQUIRED` and nothing is spawned; a pasted token seat rides the run; a guest runs on the sharer's seat; two members run at once on their own seats; only the administrator removes a seat. The mock backend records every run it is handed in `<dataDir>/lab/mock-runs.ndjson`, which `src/oracle.ts` reads.

A scenario is `scenario(name, async (ctx) => { ... })` in `scenarios/`; `ctx.as('bob')` is a connected client, `ctx.client(...)` a fresh one, `expectOk` and `expectRefused` record checks, and `src/oracle.ts` holds the invariants scenarios call between steps.

## Cross-repository proof

`scripts/lab-cloud-proof.ts` boots a host that trusts a running Solus cloud dev server instead of the Lab issuer, links it there, and proves that cloud-minted owner, member, and guest grants are admitted by the host with the right principals.

## Not yet

`lab up`, `lab as <persona> …` (a daemon behind a Unix socket for a fleet of subagents), the mock Codex backend and prompt directives, the browser lane, and the convergence and presence invariants arrive with the phases that need them. The seat scenario uses pasted tokens; the relayed browser login is a real-provider proof done by hand.
