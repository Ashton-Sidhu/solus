# Presence

People on the same host see each other: the host names every participant, a session's room is the people watching it, typing and focus reach the other watchers, and a dropped connection leaves every room at once. A guest sees only its own room, never the host's roster.

## Sub-features

- `presence-roster` names every participant on the host.
- `presence-rooms` makes a session's room its connected watchers.
- `presence-typing` sends typing and focus to the other watcher.
- `presence-guest` gives a guest its one room only.
- `presence-leave` removes a dropped socket from every room at once.

## How to get to it (user POV)

- Open the same session from two clients (two people, or one person on two devices): avatars, typing, and focus in the conversation.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`.

- **Run.** `bun lab run presence`. Each sub-feature has its check.
- **Proof.** The run's report has 0 failed checks.

## Gotchas

- PASS (2026-10-13, both flavors), after the triage in `TRIAGE.md`.
- A new session is private until its first turn: the turn admits it on the Solus API and gives the organization editor access (plans/009-organization-vms.md §9). So alice sends the first turn and waits for `turn_settled` before bob watches. Sharing an unborn session with the organization is refused: the session has no record to move into it.
- Organization work needs the Solus API to admit a new session before the provider starts. The Lab run boots one Solus API and the issuer names it in every link (`src/cli.ts`); a prompt names the organization (`session.organizationId`).
