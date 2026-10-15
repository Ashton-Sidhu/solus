# Solus multiplayer and cloud: verification map

This directory is the maintained source for verifying every Solus feature that involves more than one person, device, or host, or the cloud. Read this index before driving anything, then use the feature file as the recipe. The account and host design is `docs/adr/0001-standard-authentication.md`; sharing is `docs/plans/host-sharing.md` and `docs/plans/cloud-sharing.md`; organization work is `plans/009-organization-vms.md`; sync is `plans/018` and `plans/020`.

## Baseline preconditions

- `bun lab build` is current: `scripts/doctor.sh` prints `DOCTOR OK`.
- Cloud features: a stack from `bun lab up --cloud`, and `scripts/doctor.sh --cloud` prints `DOCTOR OK (cloud mode)`. Persona emails and passwords are in `.solus-local/lab-cloud/stack.json`.
- Personas: `alice` (owner; organization "Lab" in cloud mode), `bob`, `cara`, `dan` (members), `maya` (guest, Lab-issuer mode), `carol` (another organization).
- Never drive a stack this run did not start or that the doctor refuses. Never drive production.

## Driving conventions

- Every scenario starts clean (its own hosts, its own sign-ins) and ends clean (`ctx.defer` undoes account changes; the Lab stops its hosts).
- Prove a multiplayer effect from the other person's side: what bob, maya, or carol can or cannot see or do after alice acts.
- Assert user-visible results: RPC answers, events a client receives, cloud answers, host log events. Never an internal setter.

## Proof and skip reporting

- Report the PASS/FAIL table and the evidence location (see `SKILL.md`, Evidence).
- A failed precondition is a FAIL with its reason, recorded in that feature's `Gotchas`. Never weaken a check.
- An entry point the Lab cannot reach (a client screen) is reported as "not driven; unit tests: <files>".

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with the Lab`, `Gotchas`.

## Features

Status is the result of the last full run (2026-10-13). A failing scenario is the product's current state against its scenario, not a reason to skip the feature: fix the product or the scenario's outdated assumption, never the check's intent.

| Feature | Scenario(s) | Mode | Status |
|---|---|---|---|
| [Sign-in and identity](./sign-in.md) | `cloud-signin` | cloud | PASS |
| [Host registration](./registration.md) | `registration` | cloud | PASS |
| [Link and unlink](./link.md) | `link` | cloud | PASS |
| [Account reads](./account-reads.md) | `account-reads` | cloud | PASS |
| [Cloud machines](./cloud-machines.md) | `cloud-machine`, `managed-bootstrap` | cloud; Lab issuer | PASS; PASS |
| [Sign-out and delegations](./sign-out.md) | `sign-out`, `delegation-kept-alive` | cloud | PASS |
| [Host admission](./admission.md) | `uplink-admission` | Lab issuer | PASS |
| [Sharing and guests](./sharing.md) | `share-matrix`, `guest-revoke`, `ownership`, `cloud-sharing` | Lab issuer | PASS (the rows of [TRIAGE.md](./TRIAGE.md) are fixed) |
| [Presence](./presence.md) | `presence` | Lab issuer | PASS |
| [Seats](./seats.md) | `seats`, `host-auth` | Lab issuer | PASS |
| [Organization work](./organization-work.md) | `organization-work`; `cloud-workspace`, `cloud-sessions` | cloud; Lab issuer | PASS; PASS; PASS |
| [Settings and profile sync](./settings-sync.md) | `settings-sync`, `account-reads`, `profile-across-hosts` | cloud | PASS (`profile-across-hosts` 2026-10-14) |
| [Session home](./session-home.md) | `session-home`, `session-settle` | Lab issuer | PASS; PASS |
| [Access roles](./access-roles.md) | `access-roles` | Lab issuer | PASS (2026-10-14) |
| [Cloud vault](./vault.md) | `vault`, `account-reads`, `profile-across-hosts` | cloud | PASS (2026-10-14) |
