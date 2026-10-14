# Seats

Every turn runs on its author's own provider login (seat). A member with no seat is refused before anything starts; a guest runs on the sharer's seat; two members run at once on their own seats; only an administrator removes a seat. Provider credentials stay on the host where they were made.

## Sub-features

- `seat-required` refuses a member with no seat (`SEAT_REQUIRED`) and spawns nothing.
- `seat-own` runs each member's turn on their own seat, also at the same time.
- `seat-guest` runs a guest's turn on the sharer's seat.
- `seat-admin` lets only an administrator remove a seat.
- `seat-host-local` keeps Claude and Codex logins on each execution host; another member cannot use them.

## How to get to it (user POV)

- Settings → Agents (seats); sending a prompt on a shared host.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Run.** `bun lab run seats` and `bun lab run host-auth`. The mock backend records every run in `<dataDir>/lab/mock-runs.ndjson`; `src/oracle.ts` reads it.
- **Proof.** Each run's report has 0 failed checks.

## Gotchas

- PASS (2026-10-13), after the triage in `TRIAGE.md`. Providers are always mocked; real provider logins are proved by hand.
- A member's turn on a shared host needs the host to act for them (a delegation) and the Solus API to admit a new session. The Lab's personal host is shared with the organization and holds its key (`runnerOf` in `src/cli.ts`); the owner's client names the organization (`src/scenario.ts`).
- On a host attached for organization work, the owner's new root needs the window's organization, or it is refused with `ORGANIZATION_REQUIRED` (plans/009 §1). The owner's turn still runs on the host login.
- A member's seat lives in their member folder, `<dataDir>-seats/<provider>/<name>-<id slug>` (commit 010992d89).
- The Solus API has no seat methods: `seatConnectToken` there answers `Unknown method` (`expectNotServed`).
