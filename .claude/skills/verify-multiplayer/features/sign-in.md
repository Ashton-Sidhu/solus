# Sign-in and identity

A person signs in to a Solus client through the system browser with the authorization code flow and PKCE. The client then knows who they are: the name, email, and picture come from the OIDC ID token and `/userinfo`, not from a custom profile route.

## Sub-features

- `signin-code-flow` signs in as `solus-desktop` (or `solus-mobile`) with PKCE, `state`, and `nonce`.
- `signin-identity` shows the account's name, email, verified flag, and picture.
- `signin-userinfo` gives the same person from `/oauth2/userinfo` with an account token.

## How to get to it (user POV)

- Desktop: Settings → Account → Sign in (opens the system browser; loopback callback).
- Mobile: Settings → Account → Sign in (system auth sheet; `solus://auth/callback`).
- Web on the account origin: Sign in (redirect to `/auth/callback`).
- CLI: `solus connect` (device grant).

## Driving it with the Lab

Preconditions:

- `DOCTOR OK`; alice exists in `stack.json`.

- **Sign in.** Run `bun lab run cloud-signin --cloud`. The check `the client is signed in` passes with state `signed-in`.
- **Identity.** The checks `the ID token names alice (sub)` and `the ID token carries her verified email` pass.
- **Second surface.** The check `/userinfo, read with an account token, gives the same person` passes.
- **Proof.** `summary.json` in the run directory lists `cloud-signin` with 0 failed checks.

## Gotchas

- The Lab signs in with the website password over HTTP, then runs the real code flow; there is no browser. The browser step itself (loopback server, auth sheet) is covered by `tests/unit/loopback-authorizer.test.ts` and the mobile `auth-session-authorizer`, not here.
- Sign-up checks each new password with a breach service; `up` asks again after a 5xx. With no network, `up` fails at seeding.
