# Sign-out and delegations

Signing out ends one client's sign-in and nothing else. While any signed-in client of the person is connected to the host, by any route, the host keeps a delegation for them. The cloud revokes that client's grant; the host stops reading the account for delegations made from it; another signed-in client of the same person goes on and gives the host a new delegation.

## Sub-features

- `signout-revoke` revokes the grant at the cloud; its refresh token gets nothing.
- `signout-host` makes the host refuse account reads for that grant and forget its delegation.
- `signout-other-client` keeps another client of the same person working.
- `delegation-kept-alive` re-makes the person's delegation from another connected client (`accountPresent` on a paired or trusted route, `authRenew` on a token-dialed one) after the first client signs out.

## How to get to it (user POV)

- Desktop, mobile, web: Settings → Account → Sign out.
- Website: Devices → Signed-in apps → Sign out (one client grant).

## Driving it with the Lab

Preconditions:

- `DOCTOR OK (cloud mode)`.

- **Sign out.** Run `bun lab run sign-out --cloud`. alice's desktop signs out; the revocation answers 2xx; refreshing her revoked token fails with `invalid_grant`.
- **Host stops.** An account read with the host's delegation is refused at once; the host's next delegation refresh is refused `GRANT_REVOKED` and it forgets the delegation, within one access-token life.
- **Other client goes on.** alice's mobile sign-in still reads the directory, dials the host, and gives it a new delegation; the account read works again.
- **Delegation kept alive.** Run `bun lab run delegation-kept-alive --cloud`. Mobile reaches the host on the trusted local route (no token at the door) and calls `accountPresent` with its host token. The desktop signs out; the host forgets the desktop's delegation only at the refused refresh, and an account read fails. Mobile's next `accountPresent` makes a new delegation from the mobile grant, and the account read (a fake MCP server with a key from the account vault) works again. Mobile signs out too: its refresh is refused, a token from its ended grant makes no delegation, and account reads fail.
- **Proof.** `summary.json` lists `sign-out` and `delegation-kept-alive` with 0 failed checks. Last run (2026-10-13): both PASS; `sign-out` 19 checks in about 35 s, `delegation-kept-alive` 20 checks in about 63 s.

## Gotchas

- The scenarios wait for the host's real delegation refresh. The Lab cloud gives account, Solus API, and control tokens a 90 s life (`DEVELOPMENT_ACCESS_TOKEN_TTL_SECONDS`, development only; production keeps 300 s), and the host refreshes in a token's last minute, so each wait is about 30 s. The host learns of the sign-out only from the refused refresh; nothing shortcuts it.
- `authRenew` on a token-dialed socket is not driven here; `tests/unit/account-present.test.ts` covers it with `accountPresent`.
- The second client is `solus-mobile` on purpose: reusing a revoked refresh token is a replay, which ends every grant of that client id for the person (ADR §5, accepted).
