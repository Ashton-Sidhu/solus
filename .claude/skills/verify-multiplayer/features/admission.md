# Host admission

A client reaches a host through the real admission path: a grant (access token) for each connection, exchanged at the ticket door for a one-use ticket, then the socket. A connection on the tunnel route never gets in without credentials, and a socket closes when its grant ends unless it renews.

## Sub-features

- `admit-grant` admits a connection with a valid grant for this host.
- `admit-ticket-once` refuses a ticket used twice.
- `admit-no-credential-on-tunnel` refuses a credential-free connection on the tunnel route.
- `admit-expiry` closes a socket when its grant ends.

## How to get to it (user POV)

- Any client opening any host: desktop, web, mobile; the Run on picker; a cross-host session.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Run.** `bun lab run uplink-admission` (both host flavors). Each check above passes.
- **Account side.** Cloud mode covers admission with real cloud tokens in `cloud-signin` (owner) and `cloud-machine` (members, other organization).
- **Proof.** The run's report has 0 failed checks.

## Gotchas

- Lab-issuer mode mints grants with the Lab's own key; claim shapes must follow `packages/contracts/src/uplink.ts`. A claim change in the cloud needs the same change in `packages/lab/src/issuer.ts`, or Lab-issuer runs test an old token shape.
- The Lab's personal host is now shared with the organization and holds its key (`runnerOf`), and a host owner's tunnel connection names the organization. `uplink-admission` passes on both flavors with this fixture (2026-10-13).
