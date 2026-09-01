# ADR-0017 — Cloud identity is a client-shell concern

**Status**: accepted
**Related**: [ADR-0012](./0012-the-workspace-requires-a-host-and-trust-is-per-requester.md)

## Context

Solus Cloud adds a Solus account (`app.solus.sh`). The first use is signing the
desktop app in; later uses are reaching a person's own hosts through the cloud and
team hosts. Something has to hold the account session, and the obvious candidate — the
host, which already holds provider and integration credentials — is the wrong one: a
team host is shared, so any admin or agent on it could act as that person against the
cloud, and the same server binary runs headless on a VM where no person exists.

## Decision

- The **client shell** owns the account session. On desktop that is the Electron main
  process: the Better Auth session token is encrypted with `safeStorage` in
  `userData/account.bin` (0600) and refused when the keychain is unavailable. The
  renderer receives only `AccountState` (`packages/contracts/src/account-types.ts`)
  through `NativeSolusAPI`; the token never crosses to the renderer, `localStorage`,
  logs, argv, or URLs.
- The **host** never sees an account. No server package, RPC method, host event, or
  SQLite migration changes. Hosts will later verify control-plane *grants* and hold
  *host-scoped* credentials the control plane issues; never a person's session.
- Desktop signs in with **device authorization (RFC 8628)**, not a `solus://` deep
  link: the app requests a code, opens the approval page, and polls. No URL scheme,
  single-instance lock, or per-OS registration is needed, and it works in `bun run dev`.
  Deep-link PKCE stays the recorded alternative if the flow proves unacceptable.
- Third-party sign-ins used by agents (GitHub, Google, Atlassian, Cloudflare) stay
  **host-scoped** OAuth grants. The account never stores them.
- The website origin is configuration: `SOLUS_CLOUD_URL` overrides
  `https://app.solus.sh`; a non-loopback origin must be `https:`.
- **The flow ships without UI.** `accountStore` (`contexts/account`) exposes state and
  commands; every visible surface — a Settings tab, palette commands, the code card —
  arrives with the design pass and is a separate change. On web there is no shell
  capability yet (`accountStore.isAvailable` is false), a recorded platform exception
  removed by adding a shell capability, not by new UI.

## Consequences

- `apps/desktop/src/main/account/` owns sign-in, verification (on boot and on window
  focus, at most every 10 minutes), and sign-out. A 401 from the website flips the
  state to `invalid: revoked`; a network failure keeps the session and marks it stale.
- The control plane repository (`solus-cloud`) publishes the endpoints the desktop uses
  as `cloud-api v1`; the Solus repository never imports it.
