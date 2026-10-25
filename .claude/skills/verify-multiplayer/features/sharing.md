# Sharing and guests

A person shares a work or a session with members at a role, or with anyone through a link. Each person can do what their role allows and nothing more; a guest with a link reaches only that resource. Regenerating or removing a link ends every guest at once; removing a member ends their access. Only the owner transfers ownership.

## Sub-features

- `share-roles` gives each persona exactly the rights of their role on one work.
- `share-guest` admits a guest with the link secret, at the link's role, inside that resource only.
- `share-revoke` ends every guest socket within a second when the link is regenerated or removed; a removed member's next call fails and names who removed them.
- `share-ownership` makes the creator the owner of a work and a session; only the owner transfers.
- `share-cloud` keeps shared resources readable on the Solus API with no runner, and keeps guests in their resource and organization.
- `share-custom-roles` (docs/plans/custom-roles.md) lets the owner choose what a session link may do, leaf by leaf: the default link watches, sees changes, suggests, and attaches; prompting and approving are separate choices; a suggestion waits for someone who may prompt; a link expires.

## How to get to it (user POV)

- Share button on a work or a session (desktop, web, mobile); a share link opened in a browser (`/w/<id>#<secret>`).

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`. For the Solus API engines, optionally `POSTGRES_ADMIN_URL` to a disposable Postgres.

- **Roles.** `bun lab run share-matrix` — every persona against the role matrix on one work.
- **Revoke.** `bun lab run guest-revoke` — sockets end within a second; the removed member is told who did it.
- **Ownership.** `bun lab run ownership` — creator owns; only the owner transfers; a managed host has no owner person.
- **Cloud.** `bun lab run cloud-sharing` — publication, history, comments, offline reads, refusals.
- **Custom roles.** `bun lab run guest-roles` — the default link's refusals, a suggestion sent as the owner's turn, prompt without approve, then approve, a leaf change that keeps the socket, and expiry that ends the guest.
- **Proof.** Each run's report has 0 failed checks.

## Gotchas

- A link guest holds no token. The record API admits it with the secret alone: `POST /v1/auth/session` with no bearer, with `shareSecret`, `guestId`, and `displayName` (`SolusApiClient` option `guestIdentity`). Its credential reaches only the shared resource, with the link's current role (fixed 2026-10-13, `TRIAGE.md` X1).
- Only a removed or regenerated link ends guest sockets, on the host and on the Solus API. A role change keeps them connected with the new role, and so do share rows that a runner sends again (X2).
- A share-manager refusal reaches the client with its code, for example `FORBIDDEN` (X3). `shareSetLink` returns the link as it stands: the same secret on a role change (X4).
- `ownership` names a session by `created.sessionId`, never the provider thread id (docs/plans/session-identity.md). The mock backend gives every session the same thread id (`mock-session-001`).
- A work shared to the cloud stays on its source with a location: the source answers `MOVED` naming the organization (docs/plans/cloud-sharing.md §3a).
- The Solus API registers no execution handler: an execution method answers `Unknown method`, not `PLANE_DISABLED`. Use `expectNotServed`.
- Sharing between two real accounts (a host shared with an organization) is not in cloud mode yet; Lab-issuer mode covers it with minted grants.
- The browser path of a share link: `scripts/lab-guest-proof.ts` (only when browser verification is allowed).
- `guest-roles` passes when it runs alone. In `bun lab run all` it runs after `cloud-workspace`, which attaches the shared personal host for organization work. On an attached machine the session's record lives on the Solus API, so the guest's checkout read is refused (`reaches only the shared session's checkout`) and its prompt is refused with `ORGANIZATION_REQUIRED` (`turn-organization.ts`, the attached-machine branch). This is how an attached machine treats every guest turn, an editor link's included; it is not a custom-role rule. Run `guest-roles` on its own for the proof (2026-10-25).
- The host-machine methods (`takeScreenshot`, `attachFiles`, `attachFilePaths`, `pasteImage`) exist only on the desktop host, which the Lab does not boot: the standalone server answers `Unknown method`. `tests/unit/access-policy.test.ts` proves the gate refuses them to everyone but the local window.
