# Cloud vault: signed in means the account

A signed-in person's credentials (GitHub, Google, Atlassian, TypeSafe, MCP servers) live in their Solus Cloud account vault, and every host of theirs reads them there (`docs/plans/cloud-vault.md` §2.5). The owner of a host that is not linked keeps them on that machine. When they sign in on that host, it uploads what it can (TypeSafe, MCP) with the account's copy winning, and keeps no copy of any login. When the host stops being linked to them, it keeps nothing of theirs. A token that is not the person's delegated token reads no provider and no TypeSafe ref.

## Sub-features

- `vault-upload-at-link` moves a host-local TypeSafe key and MCP key into the account when the owner signs in on the host.
- `vault-no-host-copy` leaves no provider, TypeSafe, or MCP credential in the linked host's secret store.
- `vault-second-host` lets another host of the person read the TypeSafe key and the MCP key from the account.
- `vault-website-provider` makes GitHub connected on the website reach the person's host (`providerStatus`).
- `vault-unlink` leaves nothing for the person on the host after the account removed it.
- `vault-executor-only` refuses a non-delegated token (the hosts token) at the executor route for a `provider` or `typesafe` ref.

## How to get to it (user POV)

- Signed out on a laptop: Settings → Tools → TypeSafe takes a key; Settings → MCP signs in to a server on the host.
- Sign in to Solus on that laptop: the key and the connection are in the account; Settings shows the account's status and "Connect on your account".
- The account website's Connections page connects GitHub, Google, and Atlassian, pastes a TypeSafe key, and shows every connection.
- Another host of the person shows the same connections with no sign-in on it.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK (cloud mode)`; the stack loads the cloud's provider fixture (`up --cloud` does it), so a website sign-in to GitHub completes with no real GitHub.

- **Run.** `bun lab run vault --cloud`.
- **Upload at link.** Host A boots unlinked; as its local owner, the scenario pushes a profile copy that names alice's MCP server, submits the server's key (`integrationConnectSubmit`), and saves a TypeSafe key (`typeSafeKeySet`). The host's `secrets/` holds `typesafe.json` and `integration-token-*.json`. alice registers host A and dials it; the host logs `host_user_linked`. `GET /v1/account/vault` as alice lists `typesafe` and the `mcp` ref `connected`; the fake server saw the cloud prove the key.
- **No host copy.** Host A's `secrets/` holds no `github-oauth`, `google-oauth`, `atlassian-oauth`, `typesafe`, or `integration-token-*` file; `typeSafeKeyStatus` answers `account`, `saved`; the connection row is `cloud`, `connected`.
- **Second host.** Host B (registered, dialed, pulled) answers `typeSafeKeyStatus` `account`, `saved`, lists the server's tools, every call carries alice's key, and its `secrets/` holds none.
- **Website GitHub.** `POST /v1/account/vault/connect` for GitHub, the start page with alice's website cookie, then `/oauth/vault/callback` with the fixture's code and the ticket cookie. Host A's `providerStatus` answers connected as `proof-alice`.
- **Executor only.** `POST /v1/vault/read` with a non-delegated bearer answers 401 for `provider` and `typesafe`.
- **Unlink.** "Remove host" for host A, then a restart: the host logs `host_user_unlinked`, its `secrets/` holds nothing of alice's, and the local owner has no TypeSafe key, no MCP connection, and no GitHub login.
- **Proof.** `summary.json` lists `vault` with 0 failed checks.

## Gotchas

- The Lab cannot set the hosts token (`CLOUDFLARE_HOSTS_TOKEN`): with `CLOUDFLARE_HOSTS_URL` the cloud makes new managed hosts on Cloudflare, which breaks `cloud-machine`. So the Lab proves only that the executor routes refuse a non-delegated token; that the hosts token reads seat refs and nothing else is solus-cloud `src/lib/server/vault/seats.test.ts`.
- On a standalone server the unlink is the end of the registration ("Remove host", found at the next boot or token request); the desktop's sign-out is the other unlink, and only the desktop composition has it.
- An upload at the link needs the owner's personal delegation; when the host has none yet, the key stays (unread) until the delegation is made.
- The fake MCP server is on loopback: the host cannot add it with `integrationCreate` (the probe refuses loopback), so the scenario puts it in alice's profile and pushes the same entry to the host.
