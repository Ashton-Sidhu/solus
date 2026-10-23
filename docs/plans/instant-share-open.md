# Instant share open — a link boots once, as its resolve answers

Status: done 2026-10-19. Changes `host-sharing.md` §4.2 (who opens a link as a
member) and ADR 0001 "Web storage" (the silent sign-in).

## 1. Problem

A signed-in member who opened a share link waited through three screens:

1. A new tab had no sign-in. The silent sign-in was a top-level redirect to
   `/authorize?prompt=none` and back to `/auth/callback`: two page loads.
2. The guest landing ("Opening what was shared with you as …"). The page
   resolved the link, then dialed the organization's workspace service on a
   new socket only to read the member's role (`guest-member.ts`), with an 8 s
   limit. Then it reloaded the page at the member link. The reload threw away
   every token, the directory, and the socket.
3. The record page with skeletons. It waited up to 2 s for the account read,
   behind an opaque cover. It also read the transcript of the last tab, and
   dialed every saved host before the one that runs the session. Then it said
   "Read only" until the runner connected, also while the runner was being dialed.

## 2. Rule

**The server decides whom a link opens the resource as, in the resolve.** The
page sends the secret and, when it is signed in, its Solus API access token. The
answer names the resource, its organization, the host that runs it, and
`opensAs`:

- `member`, with the member's own role, when the token lists the resource's
  organization and that role is at least the link's role;
- `guest`, with the link's role, for anyone else.

So a link never gives a member less than a stranger. The page boots once, as the
answer says, and never reloads.

**The page says "Read only" only when that is true.** While this client dials
the machine the record names, or has reached it and opens the live session,
the record says "Connecting". Only a runner this client keeps no copy of, does
not dial, cannot reach, or cannot open the session on is read only.

**A new tab signs in with one fetch.** The provider answers an authorize request
that accepts JSON with the callback address instead of a redirect. The page
completes the code itself. Only this origin can read that answer.

## 3. Vocabulary

- **resolve** — `POST /auth/share-link`: one request, one answer.
- **opens as** — `ShareLinkTarget.opensAs`: `member` or `guest`.
- **share link opening** — the page's reading of the answer
  (`ShareLinkOpening`): `member` (an app address and the runner to dial first),
  `guest` (the routes and the mirror), or `failed`.
- **runner** — the host that runs a session, named by its account host id.

## 4. Where it lives

| Owner | Does |
|---|---|
| `ShareLinkResolver` (`packages/server/src/sharing/share-link-resolver.ts`) | Secret → resource, `opensAs`, and runner with routes. Asks `ShareManager.roleFor`, the same rule as every gate. |
| `organizationMemberFor` (`transport/solus-api/admission.ts`) | The page's token, as a member of one organization, through the grant door (`ticketForGrant`). |
| `POST /auth/share-link` (`transport/http.ts`) | Reads the secret and the bearer; answers the resolver. |
| `resolveShareLink` (`client-core/src/guest-link.ts`) | Sends the token when there is one. |
| `shareLinkOpening` (`apps/client/src/lib/share-link-opening.ts`) | The answer → what the page boots. |
| `openShareLink` (`apps/client/src/main.ts`) | Boots once: a member goes to the app address, with the runner's token first in the account's refresh queue and the runner dialed before the other hosts; a guest goes to the landing. |
| `recordRunnerState` (`session/record/lib/session-record-page.ts`) | "Connecting" or read only, from the runner's saved copy and its dial phase. |
| `resumeWebSignIn` and `fetchAuthorize` (`client-core/src/web-sign-in.ts`) | The silent sign-in as one fetch. |

The account's tokens still come one at a time: the refresh token rotates, and a
replay ends the whole grant (ADR 0001 §5). The boot puts the runner's token
first instead of running refreshes side by side.

### 4.1 Measured on production (2026-10-19)

A tail of a member's visit in Safari showed the server answering in under 300 ms
and the runner's socket open 3 s after the resolve. The 22 s before the resolve was
the app's code: 206 files (1.4 MB), each through the one container at 110 to
290 ms, with no cache header. The same files come in 1.1 s when they are fetched
side by side, so the server was not the limit; a browser that fetches a few at a
time was.

- The resolve goes first. `openShareLink` loads nothing before it; the app's code
  loads while the runner's token is minted.
- Cloudflare's edge serves the client's files, cached for a year
  (solus-cloud `docs/deploy-cloudflare.md`, "Static files").

### 4.2 The round trips before a session (2026-10-21)

A member link took 4 s from page load to an open runner socket: about nine round
trips in a row. Four changes take most of them out of the path.

| Was | Now |
|---|---|
| A probe (`GET /v1/hosts` → 401) to tell the account origin from a host, then the OpenID discovery read | The account origin's shell names itself and carries the metadata (solus-cloud `withAccountOrigin`; `accountOriginShell`; `OAuthSession` `knownDiscovery`). A host page sends nothing to find out. |
| A silent sign-in (authorize, then the code) in every new tab | One sign-in for all tabs in `localStorage`, refreshed under one Web Lock from the stored grant, with the access tokens shared (`GrantSharing`, `webGrantSharing`; ADR 0001 "Web storage"). |
| The directory read before any host was dialed | A catalog the browser keeps is dialed at once; the directory refreshes it when it answers (`bootFromCatalog`). The server the page opens at is dialed first and its token asked for first (`BootIntent`, `addressedBootIntent`). |
| A CORS preflight and a ticket request before each socket | The account token goes in the socket handshake, admitted as the ticket door admits it (`exchangeCredential`; ADR 0001 §2). A host that predates it is blocked until it is updated. The preflight is cached for two hours. |

### 4.3 The account plane's own wait (2026-10-22)

The account plane's calls waited on the database, not on the path to it: a host
token ran 13 queries one after another, each one round trip (about 25 ms) to
Postgres in AWS `us-east-1`. Now a host token waits on 6: the refresh token, the
user, the client's resource link, the claims (solus-cloud `hostReach` and
`membershipsOf` read side by side), the rotation's revoke, and its new token. The
provider keeps the resource rows and the sign-in clients in memory
(`cachedResources`, `cachedTrustedClients`). `GET /v1/hosts` reads the hosts and the
workspaces side by side. The provider is not patched further: with the tokens shared
by every tab (§4.2), a refresh runs about once an hour per resource and browser, and
it is off the path of opening a link. The application asks to run beside the
database (solus-cloud `docs/deploy-cloudflare.md`, "Placement").

### 4.4 One wait per read (2026-10-22)

The waits came from how the code read the tables, not from the tables. All of them
are in one Postgres database with indexes for each lookup, so each read is now one
statement, or reads that run side by side.

| Read | Was | Now |
|---|---|---|
| Share-link resolve | The link, then its role and runner, then the runner's routes: 3 waits | `ShareManager.openLink` reads the link, every ACL entry of its resource, its own row, and its runner in one statement; `roleOf` answers from that read as `roleFor` does. The routes come from a copy kept for a minute (solus-cloud `cachedHostRoutes`): 1 wait |
| `GET /v1/hosts` with a token | The grant check, then the memberships, the hosts, and their organizations: 4 waits | The hosts with their organizations in one query, the workspaces with their policies in one query, and the grant check, side by side: 1 wait |
| Any account read with a token | The grant check, then the route | The grant check beside the route (`answerWithLiveGrant`); its answer is dropped when the grant is gone. A write still waits for the check |
| A dial after a token's life | A refresh first | A token still in use (asked for within its life) is renewed at three quarters of its life (`OAuthSessionDeps.renewalTimers`; web, desktop, and mobile; not the CLI) |

**One relation for host reach.** An organization reached a host in two ways: a
share (`host_organization`) or as the managed host's own organization
(`managed_host.organization_id`). Every reach read looked in both. Now a managed
host's organization has its `host_organization` row too (`via = 'managed'`), written
with the host and kept for its life, so reach is one join (solus-cloud migration
`0011_host_reach`). `managed_host.organization_id` stays: it is the organization the
machine was provisioned for, and a registration's end clears only `shared` rows.

### 4.5 One round trip per query (2026-10-23)

The production logs showed about 60 ms for each database wait, but PlanetScale ran
each query in 0.05–0.3 ms. The container runs in Chicago (`ord06`) and the database
is in AWS us-east-1, one round trip (about 20 ms) apart. The account site's pool had
`prepare: false`, left over from Hyperdrive: postgres.js then asks for a statement's
parameter types before every query with parameters, so each query was two round trips
and paid the network twice. Measured from Toronto: 44 ms with it, 22 ms without. The
pool now prepares statements (solus-cloud `openSharedDatabase`); the record service's
pool always did. Every token, directory, and account read waits half as long.

### 4.6 Replaced by the simplification (2026-10-23)

`simplify-auth-and-sync.md` replaces parts of §4.2–4.4: the refresh for each resource
and the cross-tab queue for host tokens (a host token is now an exchange), the
background renewal timers, the ticket fallback for older hosts (no ws-ticket exists),
and the one-minute copy of host routes (`cachedHostRoutes`). The prepared statements
(§4.5), the edge files, and the one-statement resolve stay.

## 5. Removed

- `apps/client/src/lib/guest-member.ts` and its test: the client's membership
  check, its socket, and the reload at the member link.
- The top-level redirect sign-in: the pending sign-in in `sessionStorage`, the
  callback page path, and the once-a-minute retry guard (`web-sign-in.ts`).
- The `/auth/callback` route in solus-cloud. The address stays the registered
  redirect URI; no page loads it.
- `ShareLinkTarget.role`: `opensAs` carries the role.

## 6. Surfaces

- **Web.** All of the above.
- **Desktop.** No change: share links open in the browser, on the account
  origin. The record page change applies to the desktop renderer too.
- **Mobile.** No change. Mobile does not open share links today (no universal
  links, no parser, no record view). That is a separate feature.
- **Providers.** Not provider-shaped.
- **Host origin.** A link on a host origin has no resolve door and opens as a
  guest of that host, as before (`no-door`).

## 7. Proof

`tests/unit/share-link-resolver.test.ts`, `share-link-door.test.ts`,
`share-link-opening.test.ts`,
`guest-link.test.ts`, `web-sign-in.test.ts`,
`session-record-runner-state.test.ts`, `account-origin-shell.test.ts`,
`boot-intent.test.ts`, `handshake-credential.test.ts`, the shared-grant cases in
`web-sign-in.test.ts`, the "background renewal" cases in `oauth-session.test.ts`, the
one-read link case in `share-manager.test.ts`, and solus-cloud
`sign-in-clients.test.ts` ("the web page signs in with one fetch", and the grant check
beside a read), `host-reach-migration.test.ts`, and
`scripts/asset-rules.test.ts`.
