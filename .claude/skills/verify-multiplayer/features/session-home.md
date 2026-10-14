# Session home

A session's place in each person's list lives on its home: the organization's Solus API for an organization session, the machine for a personal one (`docs/plans/session-archive.md`). Settle is shared. Archive and snooze belong to one person, so another member's list does not change. A runner tells the home about each prompt and each pull request its agent links.

## Sub-features

- `home-list` answers `GET /v1/sessions` (by default the caller's list, top-level sessions only; `scope=all` for every session they may read) with `state`, `view`, `listed`, and `pullRequests`. A person's list holds their own sessions: the ones they own and the ones they prompted, archived, or snoozed.
- `home-views` keeps each person's archive and snooze (`archived`, `snoozedUntil` on `PATCH /v1/sessions/:id`), and sends `session.viewChanged` to that person only.
- `home-settle` keeps one shared settle (`settled` on the same PATCH), and broadcasts `session.stateChanged`.
- `home-pull-requests` is one resource: `GET`, `PUT`, and `DELETE /v1/sessions/:id/pull-requests/:pullRequestId`.
- `home-runner` records each prompt on the home (`POST /v1/sessions/:id/turns`, a host acting for the person only) and delivers an agent's pull request link through the outbox.

## How to get to it (user POV)

- The X on a session's row archives it; the picker shows archived sessions with "Return to List"; snooze and settle from the row's menu; the agent tools `organize_session` and `link`.

## Driving it with the Lab

Preconditions: `DOCTOR OK` (Lab-issuer mode).

- `bun lab run session-home --host personal`. On a machine of her own, alice archives a personal session, a new prompt returns it to her list, and she settles, snoozes, and uses the pull request resource. On a Solus API with a runner of the organization: bob reads alice's session, but it is not in his list; alice archives, and bob's view does not change; bob snoozes, the session joins his list, and alice's view does not change; alice settles, and bob hears it; each heard only their own view change; bob puts a pull request and alice reads it; alice prompts on the runner, and the session returns to her list while bob's snooze stays; the agent's `link` reaches the API as an agent link; alice's own token cannot post a turn.
- `bun lab run session-settle --host personal`. Settle and unsettle, each heard and read back by a second client, on four kinds of host. Signed out: the local machine (a loopback window, no credential) and a linked VM (a paired device's session token buys its socket ticket). Signed in: a connected VM (account grants through the tunnel) and a cloud machine (a managed host; members dial with grants, alice connects a seat to run a turn). The cloud machine's organization session also settles at the organization's Solus API. Last run (2026-10-14): PASS, 56 checks, about 5 s.
- **Proof.** 0 failed checks. Last run (2026-10-14): PASS, 56 checks, about 4 s.

## Gotchas

- The Lab's shared host is attached for organization work, so every new root on it needs an organization. The personal part boots a machine of its own.
- `host.localOwnerToken()` ran `auth-session-create`, which the server does not know; it is `auth session create` (fixed 2026-10-14). No scenario had used the local-owner route before `session-settle`.
- A managed host has no owner login: a member's prompt is refused with `SEAT_REQUIRED` until they connect a seat.
- The Lab issuer grants any scope. `organization-work --cloud` proves that the real cloud delegates `sessions:write`.
