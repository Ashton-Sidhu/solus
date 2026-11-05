# Web tokens signed from the website session

Status: implemented (2026-10-31), not measured. Replaces the server-held web grant of
`docs/plans/fast-secure-startup.md` step 2. No compatibility is kept: Solus has no users.

## The rule

Every API and every host accepts only access tokens (JWTs): the account plane, the
Solus API, and every host, for every client. Clients differ only in how they get them:

| Client | How it gets tokens |
|---|---|
| Web (on `app.solus.sh`) | Its website session cookie, sent to `POST /api/web/tokens`. The server signs the tokens from the session. |
| Desktop, mobile, CLI | OAuth with PKCE, then refresh (unchanged, RFC 8252). |

The website session cookie is used only to get tokens and for the website's own pages.

## Why

The step 2 design ran the `solus-web` OAuth flow inside the server and kept a sealed
refresh token per website session (`web_grant`), with an in-memory token cache and one
refresh at a time per session. Refresh tokens rotate strictly (a used token presented
again revokes the whole grant), so two instances refreshing one session sign the person
out: the cloud could not run more than one instance. The web page does not need a
refresh token at all: the session already proves who it is.

## Decisions

1. **The website session is the web grant.** Web tokens carry `grant_id` = a stable,
   non-secret identifier of the Better Auth session (never its secret token). A web
   grant is alive exactly while its session row exists and has not expired.
2. **`POST /api/web/tokens` signs the tokens itself**, on every call, on any instance:
   one session check and one signature. Exact `Origin` check, live session, `no-store`,
   as now. The servers token (account plane and Solus API) has the claims the provider
   gives a `solus-web` token today; one claim builder makes both, and a test compares
   them field by field.
3. **Host tokens** still come from the RFC 8693 token exchange, run in the server, with
   the session-signed servers token as subject. The live-grant checks of the exchange,
   of `isGrantAlive` / `answerWithLiveGrant`, and of host delegations accept a live web
   grant. **Web host tokens last 1 hour**; native clients keep their lifetimes.
4. **The answer carries tokens only.** The first screen's data (who is signed in, the
   directory, the account, and the settings) comes in the page HTML as JSON data blocks,
   which the page reads once. The page is personal, `private`, and never stored by a
   shared cache. No startup data in the token answer, so no 30 s expiry, no once-only
   reads, and no identity check of that data on the web.
5. **One small token holder per tab** (`WebTokenSession`): the held tokens and their
   ends, one request in flight, renewal only when a token is asked for within a minute
   of its end (the host socket already asks before its token ends), a refusal reason per
   host, and on 401: signed out, go to `/sign-in`. No batching queue and no timer.
6. **Sign-out reaches every tab at once**: a `BroadcastChannel` message on sign-out and
   on a 401 makes every tab of the origin sign out too.

## Deleted

- solus-cloud: the `web_grant` table and its migration, the sealing of refresh tokens,
  the in-server authorize and code exchange, the token cache, the single-flight, the
  grant revocation in the session delete hook, and the prune step for web grants.
- Solus: the web startup data in `WebTokenSession` (`take*`, expiry), its batching and
  renewal timer, and the web-only parts of the startup-data contract.

## Unchanged

- Desktop and mobile sign-in, their refresh tokens, and the startup data in their
  OAuth response.
- The speed: a fresh login still makes one token request, in parallel with the
  workspace code; the server does less work for it (no code exchange, no grant write,
  no rotation).

## Checks

- Two calls with no shared memory (two instances) both give valid tokens, and nothing
  is revoked.
- Session-signed claims equal the provider's `solus-web` claims, except values that
  change per token.
- A session delete makes the account plane refuse the tokens at once, and the host
  token exchange and delegations refuse the grant.
- An expired session gives 401; a wrong `Origin` gives 403; a host the person cannot
  reach gives a refusal for that host; a web host token ends in 1 hour.
- The page reads its first-screen data from the HTML and makes no account or settings
  request at boot; a 401 in one tab signs every tab out.
