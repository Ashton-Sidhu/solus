# Member users

On a managed host each member runs as their own Linux user (docs/plans/member-isolation.md). The host object in the cloud makes the user and lists it in the users file; the server reads only that file. A member not in it yet sees "Setting up your workspace for the first time" and their turns are refused with `WORKSPACE_PREPARING`; once listed they alone hear that they are ready, and their turns run as their uid, in folders named by their username. A member the host object removes waits again.

## Sub-features

- `member-preparing` — server info says `memberWorkspace: 'preparing'`; a prompt and a seat paste are refused with `WORKSPACE_PREPARING`; nothing runs.
- `member-ready` — `connection.memberWorkspaceReady` reaches that member only; server info no longer says preparing.
- `member-user` — the run's launch options carry the uid and gid from the users file, its seat folder and `HOME` are named by the username, and a file Solus writes for the member is written as them (group read added).
- `member-removed` — leaving the file makes the member prepare again; other members are untouched.

## How to get to it (user POV)

- Accept an invitation to an organization with a cloud host, then open a new draft (desktop, web: the draft's connect-host page) or Home (mobile) before the host has made the user.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Run.** `bun lab run member-users --host managed`. The Lab plays the host object: it writes the users file (`SOLUS_MEMBER_USERS_FILE`) as its script would, last and by rename. Every member's uid is the developer's own, so the switch needs no privilege.
- **Proof.** 0 failed checks; the recorded run (`mock-runs.ndjson`, `seat.launch`) carries the uid and `HOME`.

## Gotchas

- PASS (2026-10-15). Real uids, folder owners and modes, and the host object's reconcile are proved in the host worker's Linux container proof (`bun run proof` in solus-cloud `host-worker`), not here: macOS cannot make users.
- The scenario's managed host has its own host id (`labhostmemberusr`). With the Lab's default id it shared the Lab host's delegations with the issuer, and the managed `seats` scenario that runs after it failed (`ORGANIZATION_AUTHORITY_MISSING` for cara).
- The Lab plays the member switch with a shell script (`SOLUS_MEMBER_SWITCH`) that records each start; the real switch's refusals and capabilities are proved in Linux, not here.
- The client screens are not driven; unit tests: `tests/unit/draft-host-gate.test.ts`, `tests/unit/native-mobile-host-terms.test.ts`.
