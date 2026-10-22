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
`session-record-runner-state.test.ts`, and solus-cloud
`sign-in-clients.test.ts` ("the web page signs in with one fetch") and
`scripts/asset-rules.test.ts`.
