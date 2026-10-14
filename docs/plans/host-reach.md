# Host reach: a person's hosts reach each other

Status: implemented (2026-10-13). Replaces cross-host-sessions.md §5.1 (lent host
access), §9 (host trust), §10 (paired hosts), and §10.5 (two-way pairing).

## 1. Rule

An agent on host A may start a session on host B for person P when P can reach
host B. Nobody pairs host A with host B.

P can reach host B in one of two ways:

1. **Account reach.** The account plane says that P reaches host B now: P owns
   it, or P is a member of an organization that host B is shared with or managed
   for, and the organization's policy allows that kind of machine
   (`hostReach` in solus-cloud). The account plane checks this when it issues a
   host-reach token. The token lives eight hours, so a removal takes effect
   within eight hours.
2. **Local reach.** No account is needed. P's own client holds an owner
   pairing for both host A and host B. Only owner access counts. A member,
   guest, or share link never connects two hosts.

## 2. Vocabulary

- **host reach**: the set of hosts that an agent on a host may start sessions
  on, for one person.
- **introduction**: what a client does when it holds owner pairings for two
  hosts that do not know each other: it gets a token from each host for the
  other and hands it over.
- **introduced host**: a host that this host holds a token for because of an
  introduction.

Do not use "paired host", "host trust", "return pairing", or "adopt" for
these concepts.

## 3. Account reach (solus-cloud and host)

### 3.1 Account plane (solus-cloud `auth/token-exchange.ts`)

A host's delegation for P may ask for a token for another host B with a token
exchange: the subject is one of the delegation's own tokens, and
`resource = hostReachAudience(B)` (`urn:solus:host-reach:<B>`). A refresh cannot
widen a delegation's resources, so the exchange is the only way. The answer has
no refresh token. The account plane issues it only when:

1. The delegation is alive (`delegationAlive`), as today.
2. `hostReach(B, P)` is `ok`, and P is the owner of host B or has a membership
   that is `allowed`.
3. **The scope limits the reach.**
   - A **personal** delegation (host A is P's own machine) may reach every
     host P reaches.
   - An **organization** delegation (host A works for P in organization O, for
     example a managed machine of O) may reach only hosts in O. An
     organization's machine never gets a way into P's personal hosts or into
     other organizations.
4. A managed host B must be `ready`.

The token for host B states P's standing there (`access: owner`, or
`org-member` with the organization facts), plus `act: { host_id: A }`. It lives
eight hours (`HOST_REACH_TOKEN_TTL_SECONDS`): reach tokens carry no scope, and
every token with a scope stays at five minutes. Host B's verifier accepts the
reach audience only with `act.host_id`, and admits the person with that
standing under the acting host's device id, which the owner can revoke.

`GET /v1/hosts` also accepts a host's delegated account token. It then lists only
the hosts that delegation reaches by the same rule.

Refusals: `host_not_reachable`, `host_outside_organization`,
`host_not_ready`.

### 3.2 Host (solus)

- `Delegations.accessToken(P, scope, { kind: 'host-reach', hostId })` makes the
  exchange and keeps the token until it ends. A refusal of one host
  (`HOST_NOT_REACHABLE`) leaves the delegation in place.
- `RemoteHosts` reads P's host directory with P's delegated account token and
  dials host B with the host-reach token. The person comes from the turn
  (`reachRequestFor`): the owner, through the owner's personal delegation and
  the introduced hosts; an organization member, only through that
  organization's delegation; anyone else, nothing. Each person has their own
  connection to a host.
- **Removed:** `LocalClient.lendHostAccess` and `HostAccess`. A host no longer
  needs a signed-in desktop app in the same process. A standalone server
  linked to the account works the same way.

## 4. Local reach: introductions (client-core and host)

### 4.1 Flow

A client (desktop, web, or mobile, all in `client-core`) connects to hosts X
and Y with an **owner** pairing token for each one. If X and Y do not know
each other, the client introduces them:

1. The client calls `hostIntroductionIssue()` on host X. Host X issues a
   pairing token for host Y (device label "Y (Solus host)") and returns
   `{ installationId, label, urls, sessionToken }`.
2. The client calls `hostIntroductionAccept(introduction)` on host Y. Host Y
   reads `/health` at each URL until one answers with X's installation id, then
   exchanges the token at `/auth/refresh` for its own copy, and stores host X.
3. The client does the same in the other direction.

Both RPCs need `local-owner`. An account member or a guest cannot call them.
Tokens pass only between a client and hosts that the client already holds owner
tokens for.

### 4.2 Forget

- Forget on host X revokes the device of host Y on host X, removes host Y, and
  records host Y as **refused**. Host X then rejects a new introduction of
  host Y until the person selects **Allow again**.
- Host Y does not need to be told. Its next refresh with the revoked token
  fails, and it removes host X.
- No client shows Forget or Allow again now: the Access section was removed
  (2026-10-13). The RPCs stay on the host.

### 4.3 Removed

`/pair/return`, `/pair/forget`, `pairedHostsPair`, `pairedHostsAdopt`,
`acceptReturn`, `offerReturn`, `adoptClientPairings`, `lib/client-pairings.ts`,
and the Address and Code form in Access. A person never pairs two hosts by hand.

## 5. Choosing the credential

For one dial to host B, host A uses:

1. **Account reach**, when host A holds a delegation for P and the account
   plane issues a token for host B.
2. **Local reach**, when host A holds an introduced token for host B.

If neither applies, `start_session` fails with a message that names both ways
in: link both hosts to your Solus account, or connect to both hosts from one
of your devices.

## 6. Surfaces

- **Access (desktop and web, mobile Access screen):** no section. A person's
  hosts reach each other by default; nobody manages the list. The introduced
  host shows on the other host under the devices with access, as
  "<host> (Solus host)", where it can be revoked.
- **Run on picker:** no change in this plan.
- **Providers:** no change. Claude and Codex both start cross-host sessions
  through `start_session`.

## 7. Tests

- solus-cloud: a personal delegation reaches an owned host and an allowed
  organization host; an organization delegation is refused for a personal
  host and for another organization's host; a removed membership is refused at
  the next mint; a managed host that is not ready is refused.
- Host: `RemoteHosts` chooses account reach before local reach; with neither,
  the error names both ways in.
- Introductions: only `local-owner` can issue or accept; a token is kept only
  at an address that answers as the sender; a refused host is not introduced
  again; a revoked token removes the introduced host at the next refresh.

## 8. Known limits

- A host introduced before a device was connected to both hosts is not reached
  until such a device connects. Nothing introduces hosts in the background.
- An issued token whose hand-over fails half way can stay unused on the issuing
  host until it expires (30 days). The next introduction replaces the half.
