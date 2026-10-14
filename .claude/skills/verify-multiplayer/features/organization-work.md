# Organization work

An organization's work lives on its Solus API: members reach it with their own tokens, a runner host linked to the organization writes its sessions, tasks, and works there, and the records stay readable after the runner stops. A person of another organization sees none of it. A runner's turn streams to the service as it lands and survives the runner being killed.

## Sub-features

- `org-service` lets members read and write the organization's records on the Solus API.
- `org-runner` makes a runner's agent turn land its task and work on the service, not on the runner.
- `org-durable` keeps the session readable on the service after the runner stops or dies mid-turn.
- `org-isolation` hides everything from another organization.

## How to get to it (user POV)

- An organization's workspace on the web; Run on an organization host; tasks and works created by an agent in an organization session.

## Driving it with the Lab

Preconditions:

- Cloud mode: `DOCTOR OK (cloud mode)`. `bun lab up --cloud` starts the Solus API beside the cloud (`stack.json` `solusApi`), and the cloud names it in `SOLUS_API_URL`.
- Lab-issuer mode: `DOCTOR OK`. Optionally `POSTGRES_ADMIN_URL` for the Postgres engine.

- **Against the real cloud.** `bun lab run organization-work --cloud`. alice registers a host (its registration names the stack's Solus API), shares it with her organization, and restarts it so it reads itself attached. She dials it naming the organization, and the host holds her organization delegation. Her new session is admitted, and the mock agent's real `create_task` and `create_work` write through the delegation to the Solus API. bob reads the task, the work, and the session record there with his own API token; the host's own tables hold none of it; carol sees none of it and cannot name alice's organization at the Solus API's door.
- **Service and runner (Lab issuer).** `bun lab run cloud-workspace --host personal`.
- **Durable sessions (Lab issuer).** `bun lab run cloud-sessions --host personal`.
- **Proof.** Each run's report has 0 failed checks. Last cloud run (2026-10-13): `organization-work` PASS, 18 checks, about 5 s.

## Gotchas

- Fixed 2026-10-13 (found by `organization-work`): an agent's first tool call in a new organization session could come before the session's record was written on the host. The task then went into the host's own tables, or the Solus API refused it (404) because the session's first report had not arrived. Now the tool context takes the API home from the admission (`admittedHomeOf`), and `deliverSessionReport` waits for an admitted session's first report (`tests/unit/organization-vm-records.test.ts`, `tests/unit/runner-delivery.test.ts`).
- The Solus API keeps its own copy of a reported session record; its `publication` is the API's (`local` there), not the runner's. Do not assert it.
- A running host reads its standing every five minutes and at boot; the scenario restarts the host after the share.
- The Lab-issuer scenarios (`cloud-workspace`, `cloud-sessions`) have their status in the map and their open questions in [TRIAGE.md](./TRIAGE.md); the cloud run above did not run them.
