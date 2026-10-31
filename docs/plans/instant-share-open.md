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

### 4.7 Start requests before workspace preloads (2026-10-29)

A fresh Safari load spent 751 ms in one JavaScript task and 278 ms in another.
Sampled stacks showed Vite inserting workspace preload links and the browser loading
modules. Starting the workspace import before account adoption delayed the requests
that startup needed.

Web boot now starts account adoption first. With no saved catalog, the cached
workspace loader waits for the account/API token. It then yields one task so account
reads and host token exchanges can start before Vite inserts preload links. A saved
catalog can open while offline or renewing, without waiting for a token. The loader
shares one import across callers and
allows a failed import to be retried. A host-served page has no account to wait for.

The directory is published as soon as it answers. It no longer waits up to two
seconds for the separate onboarding account read. The existing onboarding cover
still hides the composer until that read answers; share links still skip the cover.
This changes only the web entry sequence. Desktop and native mobile do not load this
entry or its workspace chunk. Providers and RPC contracts do not change.

`tests/unit/cloud-origin-startup.test.ts` checks request order, a pending account
read, shared imports, retries, host-served pages, and a refused token. A new
production recording is needed to measure the resulting startup time.

### 4.8 Remove dynamic JavaScript preload links (2026-10-29)

A second Safari recording confirmed that reordering requests did not remove the
preload cost: one task took 841 ms, and sampled stacks spent about 780 ms in
`appendChild` under Vite's preload helper. The workspace first appeared in the
captured frames at 4.1 seconds.

The web build now returns no JavaScript preload dependencies for dynamic imports.
The browser's native module loader still loads their full static import graph.
Vite 6 adds CSS dependencies after this hook and waits for them before evaluating
the import, so feature styles still load before the feature appears. HTML entry
preloads stay enabled. This does not merge chunks or change feature boundaries.

`tests/unit/web-client-preloads.test.ts` checks the dynamic-import and HTML policies.
The developer must rebuild and deploy the client, then record a fresh load to
measure the net gain, including any extra native module discovery round trips.

Baseline measured in Safari 26.5.2 on 2026-10-29, before testing the preload change:
the first workspace frame appeared at 3.023 s and the populated sidebar at 3.836 s.
The two longest script tasks took 775 ms and 303 ms. All 241 asset requests came
from the network (2,446,023 response-body bytes). This is one sample, with no saved
Solus grant or host catalog and with Safari's asset cache emptied. Time starts at
the app document request after Google authentication; it excludes Google's login
pages and credential entry. These frame times do not prove that a prompt can run:
this account still needed an agent connection. The candidate client built
successfully into a temporary directory; its end-to-end timing is not measured yet.

A local comparison used two production builds of the same current source, differing
only in the dynamic JavaScript preload policy. Both served assets with `no-store`
and a 25 ms delay per asset, close to the per-file latency in the production trace.
Each run had no account or host; the measurement ended when the workspace module
import resolved. It did not mount an authenticated workspace. Three alternating
Safari runs per build measured 2153/1603/1617 ms with preloads and
1227/1136/1145 ms without. The medians were 1617 ms and 1145 ms: a 472 ms (29%)
reduction in this isolated measurement. The first build inserted 184 JavaScript
preload links; the candidate inserted none. Both loaded 21 stylesheet links.
This result does not establish a 29% reduction in total Google-login time.

### 4.9 Defer the transcript renderer on an empty workspace (2026-10-30)

The cold baseline's 241 asset responses were all Cloudflare cache hits, with a
median response time of 16 ms and immutable one-year cache headers. CDN delivery
was working. The browser still had to load and initialize the initial module graph.

`ConversationPool` and the eagerly available `ConversationPane` both imported the
full transcript renderer, even when a fresh login opened a draft with no conversation.
They now use `LazyConversationView`: it loads the renderer when a conversation
mounts, uses the existing conversation skeleton while pending, and offers retry on
failure. One in-flight import is shared. A loaded module is returned synchronously
so revisiting an evicted tab does not flash a loading skeleton. The pool's view
state still owns scroll and disclosure state. The composer stays in the shell.
Desktop and web share this boundary; native mobile has its own rendering code and
does not load this Svelte graph. No RPC, persistence, or provider behavior changes.

The production build's static App graph fell from 185 chunks / 6,228,119 raw bytes
to about 167 chunks / 5.16 MB: about 1.06 MB (17%) less initial JavaScript. These are
uncompressed build sizes, not CDN transfer sizes. The deferred code remains in
the application for conversations that need it.

Three alternating Safari module-import samples, using the same no-account,
no-store, 25 ms-per-asset harness as §4.8 and with JS preloads disabled on both builds,
measured 1679/1472/1476 ms before and 1077/1040/1036 ms after. Medians: 1476 ms and
1040 ms, a 436 ms reduction. This is an isolated module-load result, not a new
Google-login benchmark. The build, targeted lint, and 20 focused tests passed.

The baseline also carried backend timings. The login code exchange took 606 ms
overall / 568 ms in the app / eight queries; the account/API refresh took
291 ms / 252 ms / eight queries. The later account read took 733 ms / 675 ms /
seven queries. Even the settings read took 541 ms / 470 ms / two queries. The
account route reads host policies inside `organizationsThatMayCreateManagedHost`
and again in `readAccount`. Query counts and total app time do not isolate database
execution, pool or connection waits, or other backend work; that needs finer timing.

### 4.10. Request and query timing, and repeat startup reads (2026-10-30)

The account app now writes a bounded `request_complete` JSON trace. It includes
the request ID, method, path without its query string, status, request elapsed
time, query count, and at most 64 query details. Each detail has its operation,
table names, a statement fingerprint, owning stage, start offset, duration, and
failure state. It does not include SQL text, parameters, tokens, or request bodies.
Stages name runtime setup, cookie session lookup, access-token verification,
OAuth handling, the live grant check, and route handling.

`Server-Timing` carries app elapsed time, database elapsed time (`db`), and summed
query work (`db_work`). Parallel queries count once in database elapsed time.
Query duration starts when the driver query is awaited and includes pool,
connection, network, and database waits; it is not a measurement of database
execution alone. `x-request-id` joins the browser request to the app trace and the
edge's `application_response` log. Edge elapsed time includes the container fetch.
These timings stop at the response headers, not at workspace paint.

The query inventory uses Better Auth's real endpoints against a disposable PGlite
database. It accounts for the original groups as follows:

| Request | Queries | Reason |
| --- | --- | --- |
| Login code exchange | 8 in the fixture | Read code; consume code; delete older values for that identifier; read user; read session; insert refresh token; insert opaque access token; load signing keys. The key read is cached after this load. |
| First account/API refresh | 8 | Read refresh token and user; read two resource rows; read organization and team memberships; revoke old refresh token; insert replacement. The resource rows are cached after first use. A later refresh uses 6 queries. |
| Account | 7 before, 6 after | Grant check, GitHub vault status, onboarding state, organizations, host policy, managed-host availability. Previously host policy was read twice. Counts assume organization membership and warm signing keys. |
| Settings | 2 | Live grant check and settings document. The grant check runs beside the document read, so sign-out still takes effect at once. |

Do not remove code consumption, refresh rotation, or the grant check to lower the
count. The two code deletes have different predicates: one consumes the chosen
row atomically; the other clears older rows for the same identifier.

Three repeat startup reads are removed: the mounted connections store takes the
directory result from web boot once; the first setup checklist uses the account
answer already loaded by boot; and account facts reuse one host-policy result.
Later directory and checklist refreshes still read current data. GitHub vault
status now loads beside account facts, rather than before them.

The driver also had preparation disabled in practice. Drizzle calls
`postgres.js.unsafe()`, whose per-query default is `prepare: false`, despite the
pool default. The observed driver now sets `prepare: true` unless the caller
explicitly overrides it. Statements can reuse their parameter types and prepared
statement on the same connection. Their first use can still require a describe
round trip. No production latency reduction is claimed before deployment and a
new fresh-login recording.

This changes the shared account backend for all clients. Directory result reuse
applies to web boot; the setup checklist applies to the shared desktop/web UI.
Native mobile does not use either Svelte startup path. No RPC or provider contract
changes are required.

Validation: 37 focused cloud tests and 18 client tests pass. Cloud site checking
reports zero site errors; the edge TypeScript check passes. Targeted lint on the
new timing code passes. Wider checks still report existing lint findings in auth
test fixtures, account response construction, the edge environment reader, and
connection-store complexity, plus existing linked Solus type errors. The isolated
client-core check reports missing `Window.solus` and `Window.solusNative` declarations.

### 4.11. Two-call grants and one account projection (2026-10-30)

This supersedes the request counts in §4.10. Sign-in now requests the account and
Solus API resources and returns their JWT at once. `OAuthSession.adopt` checks its
issuer, subject, client, audiences, expiry and grant ID, then makes it available
before it emits the signed-in state. It accepts no opaque-token compatibility
path. Desktop, native mobile and web share this behavior; the CLI's device grant
also returns the servers token. Later renewal and host token exchange keep their
existing rules.

The account backend's `token-grant-store.ts` installs one adapter per auth instance.
An endpoint's facts live in Better Auth's request state, not in an ID-based or timed
cache. Code consumption uses one data-modifying CTE to delete matching verification
rows and load the latest row's user, session, organization roles and bounded team
IDs. The provider still validates code type, client, redirect URI, PKCE and expiry.
It then inserts the client grant: two SQL calls after process setup. Concurrent
requests cannot share their fact snapshots.

A refresh reads its row, user and membership facts together. A small, version-pinned
provider patch adds the atomic-rotation callback. One statement conditionally
revokes the old row and inserts its replacement; a competing rotation inserts
nothing. An insertion error rolls back revocation. The provider retains scope,
resource, expiry, replay and client checks. No generated provider types were edited.
The patch is declared in `solus-cloud/package.json` and `bun.lock`; a clean frozen
production install was checked to contain it.

`readAccount` now selects onboarding, organizations, policy defaults, managed-host
availability and GitHub status together. It reads no credential ciphertext. The
central live grant check still runs beside that read. The separate GitHub loader
and its input override were removed.

| Request (warm server caches) | Before | Final |
| --- | ---: | ---: |
| Code exchange | 7 | 2 |
| Immediate startup refresh | 6 | 0 |
| Account, including live grant check | 6 | 2 |
| Settings, including live grant check | 2 | 2 |
| Measured fresh-client path | 21 | 6 |
| Later periodic refresh | 6 | 2 |

Every benchmark sample makes a fresh client grant against the real auth endpoints
and disposable PGlite database with production migrations. The timer starts after
authorization and ends after account/settings reads. It excludes Google pages,
authorization, browser assets, host directory, WebSockets, and rendering. Each
logical query receives an injected delay; overlapping reads remain overlapped.
These are backend fixture timings, not production login or browser paint timings.

Five samples per stage and delay give these median milliseconds:

| Implementation step | 27 ms database delay | 80 ms database delay |
| --- | ---: | ---: |
| Before | 439.4 | 1233.3 |
| Direct token, joined account and membership reads | 204.2 | 555.1 |
| Joined code-grant facts, stable adapter identity | 88.4 | 248.5 |
| Final, with atomic periodic refresh | 89.0 | 248.4 |

Periodic refresh, measured separately after the first membership cleanup, fell
from 144.6 → 87.8 → 60.1 ms at 27 ms database delay (5 → 3 → 2 SQL calls). At 80 ms
the corresponding medians were 411.1 → 253.7 → 166.4 ms. A per-request adapter
experiment caused resource seeding to repeat and regressed startup to 265.7 ms;
the stable adapter fixes that regression. Its timing sample is retained in the
temporary experiment log, not included as a successful implementation step.

The measured fresh path is now near its floor at the current API boundaries:
two dependent code-grant calls, then one parallel account/settings stage. Lowering
more parallel read counts would reduce database load but does not remove that
third wait. Combining these API responses or changing database placement would be
a separate transport-level step. The last startup timings are effectively flat;
do not claim the later refresh optimization sped fresh startup further.

Raw samples and reproduction instructions are in
`docs/benchmarks/fresh-login-backend-2026-10-30.json` and its README. The first
zero-delay sample can include first-use cache reads. The first cleanup's zero-delay
run overlapped other tests and is noisy. Five sequential samples per case are not
a production percentile study.

Validation: 87 focused backend tests and 90 client tests pass. Additional adapter
tests cover concurrent code grants, PKCE, expired sessions and the two-call count.
Cloud site type checking and targeted lint pass; the cloud checker still reports
138 existing linked Solus errors. The sign-in test file remains above the 600-line
review threshold (671 lines). No deployment or new Safari end-to-end timing was
performed for this change.

### 4.12. Startup data in the login response (2026-10-30)

This supersedes the six-call state in §4.11. A code grant returns `startup.account`
and `startup.settings` beside its tokens. The shared contract is
`packages/contracts/src/auth/startup.ts`. Both documents are loaded in the existing
code-consumption statement: the account uses the same query and formatter as
`GET /v1/account`; settings use the account document owner's decoder. Provider size
choices come from the runtime's configuration without a database read. No credential
material is included.

The initial path now consists of two dependent SQL calls: consume the code and read
its identity, session, claims, account and settings; then insert the client grant.
The provider still checks PKCE, client, redirect URI and session lifetime before
issuing tokens or returning the startup data. A refused code returns no startup
data. Later refresh grants return tokens without another startup payload.

`OAuthSession` binds the startup account to the ID token's subject before adopting
the reply. It makes each document available once, in memory, before the signed-in
event. A delayed first reader fetches current state after 30 seconds. Sign-out and
an external grant change discard unused snapshots. Settings are decoded when read
so their full schema does not enter the small web authentication bundle; a malformed
snapshot reports an error instead of fetching a replacement on that read.

Web account and settings adapters consume these snapshots. Desktop main serves
them through its existing account/settings calls; no token or new IPC capability
is exposed to the renderer. Native mobile initializes organizations and settings
from the same login data. Later reads, explicit refreshes and writes use the normal
APIs. A settings write before the first read discards the unused settings snapshot.

| Fresh client path, warm server | Previous | Startup payload |
| --- | ---: | ---: |
| Code grant, including startup data | 2 | 2 |
| Follow-up account HTTP requests / SQL calls | 1 / 2 | 0 / 0 |
| Follow-up settings HTTP requests / SQL calls | 1 / 2 | 0 / 0 |
| Total SQL calls / sequential waits | 6 / 3 | 2 / 2 |

Five isolated fixture samples per delay measured these medians:

| Injected database delay | Previous six-call path | Startup payload |
| --- | ---: | ---: |
| 0 ms | 6.3 ms | 6.3 ms |
| 27 ms | 89.0 ms | 61.1 ms |
| 80 ms | 248.4 ms | 173.9 ms |

These are the same backend fixture scope as §4.11, not new Google-login or browser
render times. The fixture has three organizations and empty synced settings;
correctness tests also cover stored settings and revisions. An initial benchmark
overlapped other PGlite test workers and was slower; the reported samples are the
isolated rerun. Raw samples are appended to the committed benchmark JSON as
`startup-bootstrap`.

### 4.13. Host directory in the login response (2026-10-30)

A code grant also returns `startup.directory`. It is the answer of
`GET /v1/hosts` for that person, from the same reader (`readDirectory`). A
client calls that route with a bearer token, which has no active organization,
so the login read uses none too. The field is optional in
`accountStartupSchema`. An older server does not send it, and an older client
ignores it. Refresh and token exchange do not return it.

The server starts the directory read when the code is consumed. The read runs
while the provider checks PKCE, signs the tokens, and writes the grant. The
provider calls `customTokenResponseFields` before that write, so an after hook
on `/oauth2/token` adds the directory to the startup data. A failed read leaves
the field out, and the client reads the route itself.

`OAuthSession.takeStartupDirectory` keeps the directory with the account and
settings snapshots: one reader, 30 seconds, the same identity check, and the
same discard on sign-out, a grant change, or a write. A directory this client
cannot decode is left out; sign-in still completes. The first directory read
uses it on each client: web (`oauthUplinkAccountSource`, which
`adoptAccountOrigin` and the connections store share), desktop main
(`cloudRequest('/v1/hosts')`), and native mobile (`refreshDirectory`). Later
reads use the network.

| Fixture, five samples, median | Previous: grant, then `GET /v1/hosts` | Directory in grant |
| --- | ---: | ---: |
| SQL calls / sequential waits | 4 / 3 | 4 / 2 |
| 27 ms injected delay | 94.6 ms | 62.6 ms |
| 80 ms injected delay | 249.2 ms | 167.1 ms |

The code grant alone keeps its time (63.5 ms before, 62.3 ms after, at 27 ms).
The fixture does not count the HTTP round trip and token check of the removed
request, so a real login saves more.

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


### 4.13 Further fresh-login costs: request pool identity and host exchange

The live Safari checks still reported four SQL calls for a code exchange and seven per client-to-host exchange, while the warm fixture used two and five. The production auth request proxy bound every callable property. postgres.js represents its pool (`$client`) as a function; binding it made a new identity on each read, so the signing-key cache could not retain its process copy. `auth/request-db.ts` now preserves the pool while binding database methods to the request's Drizzle instance. A callable-pool regression fixture checks one key-table read across requests and signatures. It does not cache identity, membership or grant status.

Host exchange now reads the live client grant, person, host, organization memberships, policy and bounded team IDs in one SQL snapshot. The claims hook uses facts attached by WeakMap to that issuance's loaded person object; another exchange loads a new object and checks permissions again. The token's issuer, client and audience checks remain before the query. Tests change policy and membership between exchanges and verify that the next token observes them. The directory and exchange use the same reach query and formatter.

The isolated fixture stages were five queries/two waits, three queries/two waits, then one query/one wait. At 27 ms injected database delay, medians were 58.8, 60.9 and 30.5 ms; at 80 ms they were 170.6, 168.8 and 88.5 ms. Joining only the reach reads did not improve elapsed time because it did not remove a sequential wait. Raw timing samples are in `docs/benchmarks/host-token-exchange-2026-10-30.json`. These are warm fixture timings, not a new production measurement. A cold signing-key read is still necessary.

Desktop and web also stop mounting an unseen saved conversation behind an initial draft or another page. Once a conversation has been shown, covering it keeps its mounted state, as before. This prevents loading the transcript renderer solely for a hidden pool. Mobile has its own native screen lifecycle; no new product capability or payload was introduced. An inventory of the existing client build found 43 transcript-only static JavaScript files (926,740 decoded bytes) outside the App static graph. This is not a measured new asset count, and a visible restored conversation still needs its renderer.

The broader 279-asset result still requires a client bundle pass: remove heavy renderers from shared static imports and measure critical bytes and import depth before grouping small chunks. A CDN reduces transfer latency; it does not remove import discovery, parsing, initialization or render work. Current browser captures report first contentful paint, not complete workspace readiness. No new deployed browser timings are claimed here. `sign-in-clients.test.ts` remains above the 600-line review threshold; this change does not split unrelated existing fixtures.

### 4.14. Host sockets set up during the sign-in (2026-10-30)

On a fresh login the host socket used to start after the sign-in: authorize, code exchange, then DNS, TCP, TLS, and the WebSocket upgrade to the host's tunnel, then the handshake. A preconnect hint does not help: neither Chromium nor WebKit reuses a preconnected connection for a WebSocket, and Cloudflare Early Hints caches per URL, which would send one person's host addresses to others.

The account origin's shell now carries the signed-in person's directory, as `GET /v1/hosts` answers it, in a JSON data block (`solus-host-directory`). `serveClientShell` reads it beside the provider metadata, so the page waits for the slower of the two reads, not both. Share-link pages get no block. A failed read leaves it out. The page is `private, no-cache`, so no shared cache keeps one person's directory.

A browser with no saved hosts dials those hosts at once (`dialShellDirectory` in `apps/client/src/main.ts`). Each dial's handshake asks the account source for a token; `awaitingSignIn` makes that wait for the sign-in, so the socket set-up overlaps the sign-in round trips instead of following them. A page that does not sign in gets no token, and its dials are refused as for any signed-out page. The catalog boot after the sign-in finds the hosts dialing; its directory read uses the copy in the login response (§4.13), which replaces the shell's.

Expected saving: about two round trips before the first host is ready (the host token still needs the login token). `solus:host-ready` marks the first host ready. Desktop and native mobile do not load this page and are unchanged.

Measured on app.solus.sh on 2026-10-30, three fresh Google logins in Safari per order, alternating, with no saved hosts (`docs/benchmarks/fresh-login-early-dial-2026-10-30.json`). A temporary switch kept the old order on the same deploy and has been removed. The first host was ready at a median of 2,631 ms after navigation with the old order and 2,293 ms with the early dial (ranges 2,504–2,643 and 2,144–2,372). From the end of the code exchange, the wait for the first host fell from 520–650 ms to 185–200 ms. First contentful paint did not change, as expected: the workspace paints before a host is ready.
