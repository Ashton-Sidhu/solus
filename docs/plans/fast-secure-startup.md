# Fast and secure startup

Status: in progress (2026-10-30). Branch `solus/fast-secure-startup` (Solus) and
`fast-secure-startup` (solus-cloud). No compatibility with earlier clients, hosts, or
stored state is kept: Solus has no users yet.

## Goal

A fresh login on the web client shows the real workspace in under a second and has a
working host soon after. Every step is measured before and after (`docs/benchmarks/`).

Measured on app.solus.sh, 2026-10-30, fresh Google login in Safari, median, from the
navigation after Google (`docs/benchmarks/fresh-login-early-dial-2026-10-30.json`):

| Milestone | Now |
|---|---:|
| HTML received | 0.88 s |
| Code exchange starts | ~1.9 s |
| Workspace code loaded and run (`solus:workspace-code`) | 2.05 s |
| First paint | 2.27 s |
| First host ready (`solus:host-ready`) | 2.29 s |

The workspace mounts only after the sign-in and the workspace code are both done. The
sign-in is three requests in sequence (silent authorize, code exchange, host token). The
workspace code is 3.1 MB of JavaScript in about 150 modules, and Safari spends about
1.2 s after the HTML loading and running it.

## Decisions

1. **The web client signs in with the website's session cookie.** On the account
   origin, the page and the cloud API share one origin, so the standard pattern applies:
   an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie (the IETF browser-based-apps
   guidance calls this a backend for frontend). No OAuth flow runs in the browser, and no
   refresh token is kept in web storage. Desktop and mobile keep OAuth with PKCE, which
   is right for native apps. This amends ADR 0001 for the web client only.
2. **Hosts get short tokens from one same-origin endpoint.** Hosts are other machines
   and must never see the account cookie. `POST /api/web/tokens` (cookie only, exact
   `Origin` check, `no-store`) returns the token for our servers and one token for each
   host the page names: audience bound to that host (RFC 8707). A web host token lasts
   one hour (`web-session-tokens.md`); native clients keep eight hours. The page asks at
   once, in parallel with its code, and again when a token is asked for near its end.
   Tokens never appear in HTML.
3. **The HTML carries the first screen's non-secret data**: the directory (done, §4.14 of
   `instant-share-open.md`), who is signed in, the account, and the settings. The
   workspace mounts without waiting for any request.
4. **Trust by network position never applies to a web page.** A host trusts a loopback,
   tailnet, or opted-in LAN caller only when the request carries no `Origin`, or an
   `Origin` that is the request's own `Host`; and only when `Host` names this machine
   (no DNS rebinding). The desktop window already uses its own owner token.
5. **Host tunnels move to their own registrable domain**, listed on the Public Suffix
   List, so each host is its own site: no host page can set or read a cookie of the
   account origin or of another host. The account origin's cookies use the `__Host-`
   prefix. Same pattern as `github.io`, `vercel.app`, and `workers.dev`.

## Work, in order

Speed first. Each step lands with a measurement.

1. **Local host trust** (decision 4). Small, and a high risk today: any page the user
   visits could pair with the desktop's host as its owner.
   `packages/server/src/transport/{trusted-requesters,http,websocket}.ts`. Tests: a
   cross-site `Origin`, a DNS-rebinding `Host`, the host's own page, and a CLI with no
   `Origin`.
2. **Cookie sign-in and the host-token endpoint** (decisions 1–3). Removes the
   authorize and code-exchange round trips and the host-token wait from the critical
   path. solus-cloud: the endpoint, the shell's signed-in identity; the web client's
   `OAuthSession` and its startup-data cache go away. Measure: code exchange gone,
   `solus:host-ready`, first paint.
   **Status: implemented, not measured** (2026-10-31), then replaced by
   `web-session-tokens.md`: the server keeps no grant for the session. solus-cloud:
   `auth/web-tokens.ts` signs the tokens from the website session on every call, and
   `auth/live-grants.ts` holds the one liveness rule; the `web_grant` table, its
   migration, the session delete hook, and its prune step are gone. The shell carries
   `solus-account-identity`, `solus-host-directory`, `solus-account`, and
   `solus-account-settings`. Solus: `client-core/web-token-session.ts` holds tokens only;
   `web-sign-in.ts` and the web parts of `OAuthSession` are deleted. ADR 0001 is
   amended. The cookie flags stay Better Auth's (`HttpOnly`, `Secure`, `SameSite=Lax`);
   the `__Host-` prefix comes with step 8.
3. **Mount at once, code first.** The workspace mounts as soon as its code runs; the
   preload list yields to the entry script (`fetchpriority="low"`). Measure first paint.
   **Status: implemented, not measured** (2026-10-31). `startPage` sends the first token
   request, then boots with no wait; the shell's directory saves the hosts with no
   request. The preload links have `fetchpriority="low"`.
4. **A small first-screen core.** Split `WorkspaceContext` (286 files, 2.6 MB source)
   into a core (router, sessions, transcript, composer, sidebar, connections) and
   feature modules (tasks, PRs, works, automations, settings, browser, devices) that
   register routes and palette commands as small entries and load their stores on first
   use. Build the core as a few large chunks. A size budget test fails the build above
   the target. Target: 400–600 KB raw for the first screen. Measure with
   `scripts/bench-web-load.ts` (slow, fast, local) and in Safari.
5. **Real layout in the HTML.** Render the empty workspace with Svelte's server
   renderer at build time into `index.html`; `hydrate` instead of `mount`. First paint at
   HTML arrival. The first-screen components must render without `window`; a test
   renders them on the server.
   **Status: implemented and measured in Chromium; WebKit open** (2026-10-31). The
   build renders `apps/client/src/shell/FirstScreen.svelte` with `svelte/server`
   (`scripts/vite-workspace-first-screen.ts`) into `#root`: the real `SidePanel` with
   `SessionSidebarSkeleton`, and the draft headline over a composer card with
   `DeferredPromptEditor`'s plain field. Nothing in it belongs to a person. The scoped
   styles of its components are inlined. The client does not hydrate it: `App` needs
   its whole context graph and a host, which the build does not have. The workspace
   replaces the frame in the same task as it mounts and takes the text and focus of
   its field (`apps/client/src/lib/first-screen.ts`); every other page removes it
   before it mounts. The page's inline script hides it on `/w/`, `/s/`, `/t/`, and
   `/pair` before the first paint. `tests/unit/web-first-screen.test.ts`. Slow profile,
   FCP: Chromium 5.35 s to 1.09 s, WebKit 5.06 s to 4.41 s; the code mark does not move
   (`docs/benchmarks/README.md`). WebKit paints only a "visually non-empty" page, and
   the frame is not one while the startup preloads load; it needs more than 200
   characters of text or 1024 px² of inline SVG. The frame and the draft page now show the Solus mark
   (40 px) above the headline. That did not move WebKit: measured on 2026-10-31
   (`scripts/bench-web-load.ts` now records when the HTML's stylesheet arrives), both
   engines wait for the 545 KB entry stylesheet, the startup preloads share its
   bandwidth (it arrives at about 385 ms with them and 265–300 ms without, fast
   profile), and WebKit paints only after it (418 ms). More text, an explicitly sized
   mark, preloads in `<body>`, an `async` entry, and preloads inserted after the first
   frame did not help; the last made WebKit's code arrive much later. Next: inline the
   CSS the frame needs into the HTML and load the full stylesheet without blocking the
   first paint, with the workspace mount waiting for it. Desktop is unchanged: it loads from disk and already paints its boot shell
   from the HTML.
6. **A plain WebSocket protocol to hosts.** Replace socket.io: the token rides in the
   first message, so the CONNECT acknowledgement round trip goes, and about 90 KB leaves
   the entry chunk. Server, desktop, web, and mobile change together.
7. **The time before the HTML.** Measure the return from Google, redirects, the Worker to
   container hop, and the page build. Serve the shell from the Worker only if the hop
   dominates.
8. **Tunnel domain** (decision 5). Needs a new domain and its Public Suffix List entry.

The security items found in the same audit that are not on this path (delegation scope,
pairing codes, native consent, token lifetimes) are listed in
`docs/plans/auth-hardening.md` when that work starts.

## Measurement

- `node scripts/bench-web-load.ts` for code loading (`--profile slow|fast|local`).
- Safari fresh-login runs on app.solus.sh: navigation, `solus:workspace-code`,
  `solus:host-ready`, first contentful paint, and the auth requests.
