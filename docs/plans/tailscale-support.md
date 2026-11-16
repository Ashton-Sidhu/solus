# Tailscale support: reach a host over the tailnet from every client

Status: approved, 2026-11-16; in progress. All three phases are approved to build:
Phase 1 (§3), Phase 2 (§4, Tailscale Serve and HTTPS), and Phase 3 (§4a, editor links
over SSH). §4 and §4a are the plans for Phases 2 and 3; each team writes its detailed
decisions into its section before it changes code.

Related: `host-routes.md` (route kinds, identity proof, D5 HTTPS limits, §12 route
control), `host-reach.md`, `docs/host-connection-troubleshooting.md`.

## 1. Why

On 2026-11-16 the iOS app could not connect to a Mac host over Tailscale. The
investigation found these causes, in order:

1. **A failed status read removed the tailnet from pairing.** A simulator app opened
   about 400 loopback connections each second and used almost all of the Mac's
   ephemeral ports. Then `tailscale status --json` failed with "can't assign
   requested address". `listReachableEndpoints` then had no tailnet endpoint, so
   pairing links gave the LAN address `10.10.1.219`, which a phone on mobile data
   cannot reach. Tailnet trust (`trusted-requesters.ts`) also stopped. **Fixed the
   same day** (§6): the server keeps the last status while this machine still holds
   its Tailscale address (`statusWhileAddressHeld`).
2. **iOS blocks plain HTTP to `100.x`.** The app sets `NSAllowsLocalNetworking` and
   not `NSAllowsArbitraryLoads`. iOS counts private ranges as local, but not the
   CGNAT range `100.64.0.0/10` that Tailscale uses. Evidence: Safari on the phone
   loaded `http://100.87.157.17:3001/health`. A logging server on port 3002 got
   Safari's requests but no request from the app. On Wi-Fi the app used the LAN
   address, so the problem did not show.
3. **The add-host screen hides the reason.** `previewHost` (`pair-input.ts:65`)
   changes every fetch error to `unreachable`, and the screen shows "The host did not
   answer". The real error was an ATS refusal.
4. **The phone has no tailnet discovery.** `lan-scan.ts` sends a broadcast and
   sweeps the /24 of each interface. The native modules skip `utun`, `ipsec`, and
   `pdp_ip` interfaces, and the Tailscale interface is a /32. The phone never calls
   the host's `discoverServers` RPC, which already finds tailnet hosts for desktop
   and web.

T3 Code (github.com/pingdotgg/t3code, commit `629d5083`) does not have causes 2 and 3:
its iOS app sets `NSAllowsArbitraryLoads: true` (`apps/mobile/app.config.ts:275`).
It also gives an HTTPS route through `tailscale serve`. §5 compares the two products
in full.

## 2. Vocabulary

- **tailnet**: the person's Tailscale network. A route of kind `tailnet` is an
  address that a source confirmed as Tailscale (`host-routes.md` §12.2).
- **`vpn` route**: an address in `100.64.0.0/10` that no source confirmed as
  Tailscale. Other VPNs share that range.
- **tailnet discovery**: finding Solus hosts on the tailnet without typing an
  address. It is the tailnet half of `discoverServers`. LAN discovery is the other
  half.
- **own device**: a tailnet peer whose `UserID` equals `Self.UserID` and that is not
  a `ShareeNode` (a device that another person shares into this tailnet).
- **Tailscale Serve**: `tailscale serve`, which publishes a local port as
  `https://<machine>.<tailnet>.ts.net` with a Tailscale certificate.

## 3. Phase 1 decisions

### D1. The iOS app allows plain HTTP to any address

Set `ios.infoPlist.NSAppTransportSecurity` in `apps/mobile/app.json` to
`{ "NSAllowsArbitraryLoads": true }`, with no other key in that object. If
`NSAllowsLocalNetworking` (or another exception key) is also present, iOS ignores
`NSAllowsArbitraryLoads`. Expo prebuild writes `NSAllowsLocalNetworking: true` by
default, so a check after prebuild must confirm the generated
`ios/Solus/Info.plist` holds only `NSAllowsArbitraryLoads`. `apps/mobile/ios/` is
gitignored, so `app.json` is the source.

Change `NSLocalNetworkUsageDescription` to "Solus connects to Solus hosts on your
local network or tailnet."

Why this is safe enough: the token rules do not change. A client sends a credential
on an `http:` route only after the host signs a nonce with its identity key
(`host-routes.md` D3). On a tailnet, WireGuard encrypts the traffic. T3 Code made the
same choice. App Store review can ask why the app needs arbitrary loads. The answer:
the app connects to the person's own servers by IP address.

Android already sets `usesCleartextTraffic: true` (`app.json:116`). No change.

### D2. The add-host screen says why a host did not answer

`previewHost` returns `{ kind: 'unreachable', cause }`. `cause` is one of:

| Cause | How it is known | Message |
| --- | --- | --- |
| `insecure-blocked` | iOS error -1022, or a message that contains "App Transport Security" | "This app blocked a plain-HTTP connection to this address. Update Solus, or use an HTTPS address." |
| `timeout` | the 5 s abort signal fired | "The host did not answer in time. Check that Tailscale or your Wi-Fi is on, on this device and on the host." |
| `refused` | connection refused | "Nothing listens at this address and port. Check the port; a Solus host often uses 3000." |
| `other` | any other error | The current message, plus the error text in small type. |

The same causes go into `host-connection-diagnosis.ts`, which already reads the ATS
text (`host-connection-diagnosis.test.ts:170`). The cause logic is a pure function in
`apps/mobile/src/features/hosts/lib/pair-input.ts`, so a test can cover it.

### D3. The phone discovers tailnet hosts through the hosts it is connected to

The phone cannot read the tailnet. iOS gives an app no peer list and no CLI. The
hosts can read it, and `discoverServers` already returns tailnet results
(`connections-handlers.ts:141`). So:

1. `SolusApp.scanNearby` (`solus-app.ts:289`) runs the LAN scan and, at the same
   time, calls `connection.api.discoverServers()` on each connected host.
2. From a host's answer, the phone keeps only `source: 'tailnet'` results. The host's
   LAN results describe the host's network, not the phone's.
3. Results merge by `installationId`. The phone's own LAN result wins over a tailnet
   result for the same host, because it is the closer route.
4. `registry.applyNearby` saves a tailnet `discovery` route on hosts that are already
   saved. The code for this exists (`host-registry.ts:258`) but nothing calls it with
   a tailnet result today.
5. The Add Host screen shows unsaved hosts with a "Tailscale" label, as the desktop
   Fleet list does (`fleet/lib/discover.ts`). The section title becomes "Nearby", and
   its empty text becomes "No unpaired hosts found on this Wi-Fi network or on your
   tailnet."
6. A host that does not answer within 4 s is left out of that scan. Its failure does
   not stop the other results.

Limit: a phone with no connected host cannot discover tailnet hosts. For the first
host, the person scans a code or types the address. The empty text says so.

### D4. Web asks every connected host

Web asks only the default host today (`servers.store.svelte.ts:644`). It asks every
connected host instead (`subscribeAllHosts` / `serverConnections.apiFor`), with the
same rules as D3. Desktop keeps asking its local host, which reads this machine's
tailnet directly.

### D5. Discovery names a host by its tailnet name

`parseTailscalePeerCandidates` uses `HostName` first. iOS peers report `HostName`
"localhost", so a phone shows as "localhost". Use the first label of `DNSName`
first, then `HostName`, then the IP. `readTailscaleExitNode` already does this.

### D6. The tailnet address does not depend on the CLI

`listReachableEndpoints` and `advertisedRoutes` find this machine's tailnet address
without the CLI when the CLI fails. An interface that holds an IPv4 address in
`100.64.0.0/10` **and** an IPv6 address in `fd7a:115c:a1e0::/48` is a Tailscale
interface (T3 Code `DirectEndpoints.ts:47`). The CLI is still the first source, and
`statusWhileAddressHeld` is the second. This rule covers a host where the CLI is not
installed (the macOS app without the CLI shim) or never worked since boot.

This rule is for this machine's own address only. Trust (D7) still needs the peer
list, so it still needs the CLI.

### D7. Tailnet trust covers only the person's own devices

`tailnetAddresses()` trusts `Self` and every `Peer`. A peer can be a device that
another person shared into this tailnet. Trust only own devices (§2): `Self`, and
peers with `UserID === Self.UserID` and no `ShareeNode`. The status has these
fields (checked 2026-11-16).

This is a security fix, so it goes first in the work order. T3 Code never trusts the
tailnet: every device pairs. Solus keeps tailnet trust (`trusted-requesters.ts`) and
narrows it to own devices (decided 2026-11-16).

### D8. A tailnet address paired by hand gets the `tailnet` kind when the host confirms it

Pairing saves `http://100.x` as `vpn` (`routeForUrl(url)` in `pairing.ts` and mobile
`host-registry.ts:191`). The kind changes to `tailnet` only after the host advertises
its routes. If discovery found the host on the tailnet (D3), the pair call passes
`onTailnet: true`. No other change: the advertisement already corrects the kind on
the first connect.

### D9. A cloud machine advertises only routes that clients can reach

A self-hosted host on a cloud VM has private addresses on the cloud's network
(`10.x`, `172.16.x`). Its clients are not on that network, but `advertisedRoutes`
advertises those addresses as `lan` routes, so clients try dead routes first.
(A managed host already advertises nothing; `endpoints.ts:116`.)

Rule: when the host runs on a cloud VM, `advertisedRoutes` keeps only `tailnet`
routes. To know it is a cloud VM, the server asks the cloud metadata address
`169.254.169.254` once at boot, with a 500 ms timeout, and keeps the answer for the
life of the process. AWS (IMDSv2 token request), GCP (`Metadata-Flavor: Google`),
and Azure (`Metadata: true`) each need their own request; any one answer is enough.
T3 Code does the same (`DirectEndpoints.ts`).

The pairing link uses the same list, so it also gives the tailnet address. When the
VM has no tailnet address, the host keeps its current routes and the Access section
shows "This host is on a cloud network. Install Tailscale on it, or use the Solus
tunnel, to reach it from other devices."

### D10. A "private networks only" listener mode

Today `remoteAccess` binds the host to all interfaces or to loopback only
(`settings.ts:190`). A host with a public address (a cloud VM, a machine with a
port forward) then answers the internet, and only pairing protects it.

Add a third mode: **private networks only**. The host binds to all interfaces, and it
accepts an HTTP request or a WebSocket upgrade only when the remote address is
loopback, a private LAN address (`isPrivateLanAddress`), or a tailnet address
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Any other request gets 403 and is not
logged per request (one summary log each minute, to resist floods). T3 Code calls this
`t3 up --lan` (`startupAccess.ts`).

- The setting is `remoteAccess: 'off' | 'private' | 'any'`. The old boolean maps
  `false` to `off` and `true` to `any`, so no existing host changes behavior.
- **`private` is never the default** (decided 2026-11-16). A host that turns on
  remote access gets `any`. The person chooses `private` in the Access section.
- Managed policy can set or lock it, as it does `remoteAccess` today.
- Surfaces: the host's Access section on desktop and web, `HostAccessSections` on
  mobile, and `solus` CLI flags for the standalone server.
- Tunnel traffic arrives from loopback, so this mode does not affect the tunnel.

### D11. A host sends its token to another host over plain HTTP only on a safe route

When host A reaches host B (`remote-hosts.ts:119`), it dials any dialable route.
On an `http:` route, the identity proof stops a stranger from posing as host B, but
anyone on the network path can read the token. Rule for host-to-host dials:

- Allowed: `https:` routes, loopback and `forwarded` routes, and `tailnet` routes
  (WireGuard encrypts them).
- Refused: `http:` routes of kind `vpn` and `public`. The dial skips them, and when
  no route is left the error says "Host B has no secure route from this host. Use its
  Tailscale address or its HTTPS address."
- Allowed: `http:` routes of kind `lan` (decided 2026-11-16). Two hosts on a home
  network without Tailscale use them today, and clients already send tokens on them
  after the identity proof. T3 Code clients do the same; only T3's server-to-server
  links refuse the LAN.

This is `carriesTokenInClear` (`host-routes.ts:165`) applied in `remote-hosts.ts`.
T3 Code has the same rule for its peer links (`PeerLinks.ts`).

## 4. Phase 2: HTTPS through Tailscale Serve

### D2-1. Setting and state

Store `tailscaleServe: { enabled: boolean, port: number }` with host settings. Port is
443 by default and must be an integer from 1 to 65535. A separate status read says
whether Tailscale is ready, whether the mapping is active, its URL, and a plain-word
error. A setting does not claim that a broken mapping works.

### D2-2. One Serve owner

`host/tailscale-serve.ts` owns CLI calls, status parsing, mapping setup, repair,
and removal. It reuses the endpoint module's status read and CLI path lookup. A
root mapping to `http://127.0.0.1:<this server port>` is ours; another target is
not. An unknown mapping is never replaced. A dead own mapping is repaired every
30 seconds. Shutdown removes only a mapping this process made. The command runner
and clock are injected for tests. CLI stderr maps to fixed safe messages.

### D2-3. Policy before bind

When effective remote access is Off, remove all Serve mappings to this server port
before the listener binds. A missing CLI or a stopped or logged-out daemon means
there is no active mapping. If a mapping remains, refuse startup with the command
that removes it. Managed policy locks the control when it fixes remote access Off.

### D2-4. Proxy trust

A loopback request with this machine's MagicDNS Host or Tailscale forwarding
headers is a proxy request. It needs a credential, like a tunnel request, on HTTP
and WebSocket. A loopback client can forge these headers only to lose implicit
trust. Forwarded protocol and host affect generated links only for loopback
requests. The own MagicDNS name is accepted by the web-page request guard.

### D2-5. Route and link

Probe the HTTPS URL's `/health` for this installation ID before adding a `tailnet`
route. A failed probe does not advertise it. Pairing prefers this URL when it is
valid. The hosted link carries the MagicDNS host (and a nondefault HTTPS port) in `?host=` and the token
in the fragment. Web and mobile check that host's `/health` before pairing.

### D2-6. Controls and command

Desktop and web share the Access control; mobile has the same state and actions.
The control shows the port, URL, current state, errors, policy lock, and a confirm
step before disable. `solus pair --tailscale [--tailscale-serve-port N]` enables
Serve, makes five certificate probes one second apart, and prints the HTTPS pair
link and removal command. The setting and command use the same server owner.

### D2-7. Verification

Focused tests cover status ownership, repair, shutdown, policy, the route probe,
proxy trust on HTTP and WebSocket, and link parsing. Typecheck contracts, server,
client-core, workspace UI, and mobile. Do not run Serve on this machine.

## 4a. Phase 3: open a remote host's files in a local editor over SSH (needs its own plan)

Today "Open in" works only when the host is this machine
(`openExternalEditor.ts:21`, `hostPolicy.isClientMachine`). For a remote host, the
person cannot open a file in their editor. T3 Code makes editor links that open the
file over SSH by the host's MagicDNS name (`RemoteOpenTargets.ts`).

Requirements to plan:

- The host reports an **SSH target** in its server info: its MagicDNS name, and
  whether SSH works there. SSH works when `sshd` listens (on all interfaces or on the
  tailnet address), or when Tailscale SSH is on (`tailscale debug prefs`:
  `RunSSH && WantRunning`). Cache the answer and refresh it in the background.
- The client builds the link from the SSH target, the user name, and the absolute
  path, for each editor that supports remote SSH: VS Code
  (`vscode://vscode-remote/ssh-remote+<target><path>`), Cursor, and Zed. An editor
  without SSH support stays hidden for a remote host.
- Surfaces: desktop opens the link with the operating system. Web opens it as a
  link, so the browser asks to open the editor. Mobile has no local editor: it does
  not show the action (a platform exception; record it in the plan).
- Contract: add the SSH target to `ConnectionsServerInfo` in
  `packages/contracts`. No new RPC.

## 5. Gap analysis: Solus and T3 Code

Sources: T3 Code at commit `629d5083` (read-only clone), Solus `main` on 2026-11-16.
"Phase" is where this plan closes the gap.

| # | Capability | T3 Code | Solus | Phase |
| --- | --- | --- | --- | --- |
| 1 | iOS plain HTTP to `100.x` | Yes: `NSAllowsArbitraryLoads` | No: blocked over mobile data | 1 (D1) |
| 2 | Android cleartext | Yes, plus user CAs | Yes | none |
| 3 | Real reason when a host does not answer | Partly (diagnosis hints) | No on the add screen; yes in diagnosis | 1 (D2) |
| 4 | Tailnet discovery on desktop | No | Yes (local host reads `tailscale status`) | none: Solus is ahead |
| 5 | Tailnet discovery on web | No | Default host only | 1 (D4) |
| 6 | Tailnet discovery on mobile | No | No | 1 (D3) |
| 7 | Discovery on a new phone with no host | No | No | out of scope (§11) |
| 8 | Tailnet address without the CLI | Yes: interface name or `fd7a::/48` | No | 1 (D6) |
| 9 | Status read survives a failed read | Not needed (D6 rule) | Yes, since 2026-11-16 | done |
| 10 | Tailnet trust without pairing | Never trusts | Trusts all peers, including shared-in ones | 1 (D7) |
| 11 | Tailnet kind after pairing by hand | Yes (`*.ts.net`, `fd7a`, learned profile) | `vpn` until the host advertises | 1 (D8) |
| 12 | HTTPS route (Tailscale Serve) | Yes: `pair --tailscale`, server setting, desktop switch | No | 2 |
| 13 | Serve ownership, repair every 30 s, removal at shutdown | Yes | No | 2 |
| 14 | MagicDNS name accepted as Host | Yes (`X-Forwarded-Host`) | No (`web-page-requests.ts`) | 2 |
| 15 | Hosted web client over the tailnet | Yes, through the Serve URL | No (mixed content) | 2 |
| 16 | Managed policy turns Serve off | Yes | n/a until Serve | 2 |
| 17 | CLI location | PATH only | Fixed folders; PATH on Windows only | §8 step 11 |
| 18 | macOS TCC prompts from the App Store app's CLI | Avoided: 60 s cache, CLI runs only when needed | 5 s cache; runs for every trust check | none: no prompts (§10, answer 3) |
| 19 | Longer route check for DERP-relayed routes | Yes (`supervisor.ts:692`) | No: 2.5 s for every route | none: keep 2.5 s (§10, answer 4) |
| 20 | Re-check an earlier route on network change and app resume | Yes | Every 60 s (`EARLIER_ROUTE_RECHECK_MS`); not on network change | 1 (D12) |
| 21 | Exit-node hint | Yes (T3 Connect) | Yes (self-test) | none |
| 22 | Tailscale setup doc for users | Yes (`docs/user/remote-access.md`) | Troubleshooting lines only | 1 (§8 step 10) |
| 23 | Errors from the CLI mapped to messages, with the Linux operator fix | Yes: `not-running`, `not-logged-in`, `permission-denied` | Debug log only | 2 (§4) |
| 24 | Editor links over SSH by MagicDNS name | Yes | No: "Open in" works only for this machine | 3 (§4a) |
| 25 | Developer sharing over the tailnet (`--share`) | Yes | No | out of scope |
| 26 | Cloud VM advertises only tailnet routes | Yes (metadata probe) | No: advertises cloud-network addresses | 1 (D9) |
| 27 | Private-networks-only listener | Yes (`t3 up --lan`) | No: all interfaces or loopback only | 1 (D10) |
| 28 | Server-to-server token only on a safe route | Yes (`PeerLinks.ts`) | No: any dialable route after the identity proof | 1 (D11) |
| 29 | Hosted pairing link to a `ts.net` host | Yes (`app.t3.codes/pair?host=`) | No | 2 (§4) |
| 30 | Managed policy removes Serve mappings before bind | Yes | n/a until Serve | 2 (§4) |

Other findings:

- **Stale code.** `apps/desktop/src/main/pair-url.ts` posts to `/auth/pair-token`,
  which no longer exists. `electron . pair-url` therefore always fails. Remove it, or
  point it at `/pair/open`. `docs/plans/windows.md` (lines 75, 215, 732) says
  Windows has no Tailscale detection; it does now.
- **No tests** cover tailnet trust or the `/health` probe in
  `discoverTailnetServers`.
- **Server-to-server discovery** (`RemoteHosts`, `boot-server.ts:1086`) gets only
  LAN results. Out of scope here.
- **Discovery ports.** `discoverTailnetServers` probes only `SOLUS_PORT` (or 3000)
  and this server's own port. A host on another port (a development host on 3001) is
  not found. Fixed by §10, answer 2.

## 6. Done on 2026-11-16

- `statusWhileAddressHeld` in `packages/server/src/transport/endpoints.ts`, with
  `tests/unit/tailscale-status-held.test.ts`. A failed `tailscale status` read keeps
  the last good status while an interface still holds this machine's Tailscale
  address. It needs a restart of the running host to take effect.

## 7. Ownership

- `apps/mobile/app.json`: D1.
- `apps/mobile/src/features/hosts/lib/pair-input.ts`, `PairHostScreen.tsx`: D2.
- `packages/client-core/src/host-connection-diagnosis.ts`: D2 causes in diagnosis.
- `apps/mobile/src/app/solus-app.ts` (`scanNearby`), `features/hosts/host-registry.ts`,
  `use-nearby-hosts.ts`, `NearbyHostsSection.tsx`: D3.
- `packages/workspace-ui/src/contexts/connections/servers.store.svelte.ts`: D4.
- `packages/server/src/transport/endpoints.ts`: D5, D6, D7 (`tailnetAddresses`).
- `packages/client-core/src/pairing.ts`, mobile `host-registry.ts`: D8.
- `packages/server/src/transport/endpoints.ts` (`advertisedRoutes`) and a new
  `packages/server/src/host/cloud-machine.ts` for the metadata probe: D9.
- `packages/server/src/host/settings.ts`, `boot-server.ts` (bind), `transport/http.ts`
  and `transport/websocket.ts` (the address check), the Access sections on every
  client, `apps/cli` and `apps/standalone-server` flags: D10.
- `packages/server/src/execution/orchestration/remote-hosts.ts`: D11.
- `docs/host-connection-troubleshooting.md` and a new user section on Tailscale.

Contract changes: D10 changes the `remoteAccess` setting from a boolean to
`'off' | 'private' | 'any'` (settings contract, RPC, and policy schema). D3, D4, D9,
and D11 need no contract change.

## 8. Work order

1. D7 (narrow tailnet trust) and D11 (host-to-host token rule) with tests. They are
   security fixes.
2. D1 (iOS ATS). Check the generated `Info.plist`. Build and install on a phone; this
   needs the developer.
3. D2 (reasons on the add screen and in diagnosis) with tests for the cause function.
4. D6 (tailnet address from interfaces) and D5 (names) with tests.
5. D3 (mobile tailnet discovery) with a test for the merge rule in `scanNearby`.
6. D4 (web asks every connected host).
7. D8 (kind on pairing).
8. D9 (cloud VM routes) with a test that fakes the metadata answer.
9. D10 (private-networks-only listener): the setting migration, the address check,
   and the Access controls on every client.
10. Docs: a Tailscale section in `docs/host-connection-troubleshooting.md` (setup,
   the iOS update, the port, how to check from Safari). Fix `docs/plans/windows.md`.
11. Small fixes: POSIX PATH search for the CLI after the fixed folders; remove or fix
   `pair-url.ts`.

Phase 2 (§4) starts after D6, D9, and D10 land, because it changes the same files
(`endpoints.ts`, `http.ts`, the Access sections). Phase 3 (§4a) can run beside Phase 1.

## 9. Every applicable surface

- **Clients.** Mobile: D1, D2, D3, D8, and the D10 control. Web: D4 and the D10
  control. Desktop: the D10 control; it gains D5, D6, D7, D9, and D11 through its
  local host. Phase 3 has a mobile exception (§4a).
- **Entry points.** Mobile Add Host screen (scan and typed address), the deep link
  `solus://pair`, the QR scanner. Web and desktop: Fleet Discover list, Connect Host
  page, Add Machine page, the command palette entry.
- **Providers.** Not affected.
- **Connection modes.** Desktop-local, desktop-hosted, standalone remote: all use the
  same server code. A managed host advertises no tailnet routes (`advertisedRoutes`);
  D3 must not show its tailnet results.
- **Reverse states.** Discovery has no state to undo. Trust (D7): a device removed
  from the person's tailnet loses trust on the next status read (5 s cache). D10:
  each mode can change to each other mode, and the Access section shows the current
  mode. D9: the Access section says when a host hides its cloud-network routes.
- **Persistence.** D10 migrates a stored boolean `remoteAccess`; a policy that sets
  the boolean keeps working.

## 10. Answered questions (2026-11-16)

1. **Discovery with no connected host:** no. The phone discovers tailnet hosts only
   through hosts it is connected to.
2. **Discovery ports:** the ports where Solus runs: `DEFAULT_SERVER_PORT` (3000, the
   standalone server), `DEFAULT_DESKTOP_SERVER_PORT` (3001, the desktop app),
   `SOLUS_PORT` when set, and this server's own port. The list is one constant in
   `endpoints.ts`, with duplicates removed.
3. **macOS TCC prompts from the CLI:** none. Keep the 5 s status cache.
4. **Longer check for tailnet routes:** no. Keep 2.5 s for every route.
5. **Route changes:** no network-change or app-resume listener. When a client cannot
   connect on its route, it follows its route order: it tries the next route, and
   when every route fails it starts again from the first, with its retry backoff.
   See D12.

### D12. A failed connection follows the route order, with retries

When the transport on the chosen route fails (it drops, or the dial fails), the link
dials again through `chooseRoute` over **all** dialable routes in order. It never
stays on the failed URL alone. A route that answered `/health` but whose socket did
not connect is held back (`ROUTE_HOLD_BACK_MS`) so the next route gets its turn.
When no route answers, the supervisor retries with its backoff and starts again from
the first route. Desktop, web, and mobile share this through `client-core/host-link.ts`;
check that each surface uses it, and add a test that proves the order: route 1 fails,
route 2 connects; route 2 drops and route 1 answers again, the link returns to
route 1 within `EARLIER_ROUTE_RECHECK_MS`.

## 11. Out of scope

- Discovery without any connected host (§10, answer 1).
- Developer sharing over the tailnet (gap row 25).
- Protecting `tailscaled` from the Linux out-of-memory killer.
- Server-to-server tailnet discovery (`RemoteHosts`).

## 12. Execution record (2026-11-16)

- `tailscale/server-core` (`85b115c6b`): tailnet status and endpoint handling, discovery ports, own-device trust, cloud routes, CLI lookup, desktop pair URL removal, and Windows guidance.
- `tailscale/access-modes` (`bc68bbe60`): Off, Private, and Any access modes, address admission, access controls, CLI flags, and host-to-host route rules.
- `tailscale/client-reach` (`06deeb8d1`): iOS ATS, connection error causes, mobile and web discovery, pairing kind, route failover, and troubleshooting guidance.
- `tailscale/editor-links` (`e4f2256d4`): SSH target data, remote editor links, and editor guidance.

Open items:

- D9 needs a `ConnectionsServerInfo` field and a client notice for cloud hosts without a tailnet address.
- Web keeps the default host's LAN discovery results, as before.
- D1 must be checked on a phone after an iOS build.
- Editor links have not been tried with installed editors.
