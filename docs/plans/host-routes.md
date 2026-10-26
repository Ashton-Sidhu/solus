# Host routes: learned routes, host identity, and adding a machine over SSH

Status: implemented, 2026-10-25. Tested on Linux (omarchy) and Windows hosts; see §11.

Amended 2026-10-25 (implementation). Where the text below differs, this list wins:

1. **No route book class (D1).** The rules are pure functions in
   `contracts/host-routes.ts`: `mergeRoutes`, `withReadRoutes`, `dialableRoutes`,
   `chooseRoute`. Each registry calls them: `server-registry.ts` (desktop and web),
   mobile `host-registry.ts`, and server `remote-hosts.ts`. The web registry's write
   is `applyAdvertised`, `withDiscoveredRoutes`, and `withForwardedRoutes`.
2. **The identity key does not come from the directory (D3, §5).** A client learns
   it from the pairing, from the SSH connection, or from the host's server info over
   the first connection through its tunnel (TLS to a name Solus cloud controls).
   `solus-cloud` needs no change. An introduction carries the issuing host's key.
3. **The proof signs the nonce and the installation id, not the route URL (D3).**
   Binding the URL adds nothing against a relay, and a forward or a proxy changes
   the `Host` header. The proof stops another device that answers at the address;
   it does not stop an active relay to the real host.
4. **Which routes need a proof.** Every `http:` route except the page's own origin
   (`routeNeedsProof`). The transport sends no credential until the proof passes
   (`proveRoute`), and `HostLink` reports `dial-failed` when no route proves the host.
5. **Add over SSH reuses the installers and the CLI (D6).** `install.sh --setup` or
   `--link CODE`, `install.ps1 -Setup` or `-Link CODE`, `solus setup`, `solus connect
   --code`, and `solus auth session create`. There is no `solus link --ticket-stdin`:
   the link code goes in argv, as in the onboarding command (`docs/ssh-machines.md`).
6. **A discovered server gets a session, not a forward (D6).** It is dialed at the
   address it was found at, as before. Only a machine that SSH alone reaches gets a
   forward. A password is accepted only with a link.
7. **Windows targets are supported (D6, §9).** `install.ps1` exists. The latest
   release does not carry it yet, and the add then says so.
8. **Host-to-host credentials state their kind.** An introduced or forwarded host's
   session token goes as a `session-token` (`GrantSource.tokenKind`); a host refuses
   it as an access token. Introductions had this defect too.
9. **`SOLUS_SSH_INSTALL_PLACE`** (JSON `{ dataDir, port, runtimeDir, binDir }`) lets a
   test install beside a live install on the same machine.
10. **No backward compatibility.** Hosts that an earlier build saved with `url` do not
   load, and must be paired again.

Solus has no users yet, so this plan keeps no backward compatibility. Saved
hosts, contracts, and RPC names change in place.

## 1. Why

Today, a client can reach a host in three ways: a LAN pairing, a host that it
knows only from the account directory and reaches through the Cloudflare
tunnel, and an SSH bootstrap that works only for a host that discovery found
and that already runs Solus. This causes three problems:

1. **A linked host always goes through the tunnel.** This is true when the
   client is on the same desk as the host. The directory lists only the tunnel
   route (`contracts/src/uplink.ts`, `directoryHostSchema`), and the client
   saves no route of its own for a host it knows only from the directory. The
   result is more latency, less bandwidth, and a dependency on Solus cloud and
   Cloudflare when the client and host are on the same network.
2. **A machine that you can reach only with `ssh user@box` cannot become a
   Solus host from the app.** `ssh-bootstrap.ts` makes a credential for a
   server that is already installed, already running, and already listening on
   an address that the client can reach.
3. **Route knowledge has four owners with four rules:**
   - `client-core/src/server-registry.ts` (`SavedServer.url` and `savedServerRoutes`)
   - `client-core/src/uplink-session.ts` (`mergeDirectoryIntoSaved` and `withNearbyRoutes`)
   - `server/src/execution/orchestration/remote-hosts.ts:129-131`, which uses
     its own order and sends no `/health` check
   - `server/src/execution/orchestration/introduced-hosts.ts`, through
     `reachableUrls`

T3 Code (`pingdotgg/t3code`, read at `c79ef8c4`, 2026-10-24) has the two
features that Solus does not have:
- **Learned routes** (PRs #15467 and #15468). A connected server tells its
  clients its LAN and tailnet addresses. The clients save them and use them
  before the relay.
- **An SSH bootstrap** (PR #2022). It installs the server on the remote machine,
  starts it, and forwards its port.

Solus already uses the same route choice (`client-core/src/route-choice.ts`
cites T3 #15467) and the same SSH device host forwarding
(`server/src/devices/ssh-device-host.ts`, adapted from T3 Code).

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Route | One URL at which a client or host can dial a host. `HostRoute`. |
| Route kind | `lan`, `tailnet`, `tunnel`, or `forwarded`. The kind replaces `direct`, which put LAN and tailnet together. |
| Route source | Where the route came from: `directory`, `host` (the host advertised it), `discovery`, `pairing`, or `ssh`. |
| Learned route | A route that the host advertised, with source `host`. |
| Forwarded route | `http://127.0.0.1:<port>` on one machine, which an `ssh -N -L` process holds. `viaHostId` names that machine. Only that machine can dial it. |
| Identity key | One Ed25519 key pair for each installation. It is made at the first start, and it never rotates. It is not the registration key in `host/host-credential.ts`. |
| Host proof | The host's signature over a nonce, its `installationId`, and the route URL, returned by `/health`. |
| Route book | `HostRouteBook`, the only code on a client that writes a saved host's routes. |
| Forwarded host | A host that this machine reaches through a forward that it holds. `ForwardedHosts` manages it. |

Do not use "direct route" for new code. Use the route kind.

## 3. Decisions

### D1. One route model and one merge rule, in `contracts`

`HostRoute` moves to `contracts/src/host-routes.ts`:

```ts
type HostRoute = {
  kind: 'lan' | 'tailnet' | 'tunnel' | 'forwarded'
  url: string
  source: 'directory' | 'host' | 'discovery' | 'pairing' | 'ssh'
  seenAt: number
  /** Only for `forwarded`: the installation that holds the forward. */
  viaHostId?: string
}
```

The same file holds the pure functions that both the server and clients use:

- `mergeRoutes(current, incoming, source, now)` replaces the routes from one
  source and removes routes that are too old. This is the only merge rule.
- `dialableRoutes(routes, origin, localHostId)` puts the routes in the order
  `forwarded`, `lan`, `tailnet`, `tunnel`. It removes `http:` routes on an
  `https:` page. It removes a `forwarded` route unless `viaHostId === localHostId`.
- `chooseRoute` and `directRouteBack` move from `client-core/src/route-choice.ts`
  without a change in behavior. `RouteCheck` now returns the result of the host
  proof (D3).

`SavedServer.url` is removed. `routes` is the only list. `savedServerRoutes` is
deleted.

The rule "a client dials only what the latest directory read lists and saves no
route of its own" (`uplink.ts:421-426`, ADR 0001 §2.2 rule 9) is removed. That
rule stopped a client from dialing a stale direct address before the tunnel.
`chooseRoute` now checks all routes at the same time and requires the correct
host to answer, so a stale route costs only one parallel check.

### D2. The host advertises its routes, and only to a client with a credential

- `transport/endpoints.ts` is the only owner of "the addresses of this host".
  The new function `advertisedRoutes(bindHost, port): HostRoute[]` returns the
  `lan` and `tailnet` addresses that the listener actually serves. It returns
  nothing for a loopback listener. `reachableUrls` is removed, and
  `IntroducedHosts` uses `advertisedRoutes`.
- The server info RPC (`connections-handlers.ts`) returns `routes` and
  `identityKey`. A client reads them through `client-core/src/host-facts.ts`,
  once per server session.
- `/health` does not return routes. A request through the tunnel does not get the
  host's name today, so private addresses must get the same protection.
- The `/endpoints` HTTP URL, which has no auth, is deleted. Before you delete
  it, make sure that no client uses it.

### D3. A client sends a credential on a route that is not the tunnel only after a host proof

Today, a client that knows a host only from the directory sends its account
token only through the TLS tunnel. With learned routes, the token goes over
plain `http:`. The `installationId` is public, so a device on the same LAN can
answer `/health` as the host, take the token, and use it again for up to one
hour. Paired hosts on a LAN have the same risk today.
`getServerFingerprint()` (`admission/auth.ts:89`) is only
`sha256(installationId)`, so it does not prevent this.

The rule:

1. Each installation has one identity key (`host/host-identity.ts`), kept in
   the secret store.
2. The client learns the public key in one of three ways:
   - From the directory: the host sends it at enrollment, and `GET /v1/hosts` lists it.
   - From SSH: `SshProvisioner` reads it over the SSH connection.
   - At pairing: `/pair` returns it, and the client trusts it the first time.
3. `/health?nonce=<n>` returns `proof = sign(nonce, installationId, routeUrl)`.
4. Before it sends any token or session token on a `lan`, `tailnet`, or
   `forwarded` route, the client verifies the proof with
   `verifyHostProof` (`contracts/src/host-identity.ts`). A `tunnel` route uses
   TLS to the Solus tunnel domain and needs no proof.
5. Host-to-host dials (`remote-hosts.ts`) use the same check.

Verification uses `@noble/curves`, because Hermes (React Native) has no
WebCrypto Ed25519.

Traffic on a plain `http:` route can still be read on the network. The proof
stops a token from going to the wrong host. It does not encrypt the connection.
Today's LAN pairing has the same limit.

### D4. Linking does not turn LAN listening on

Linking (ADR 0001 rule 9) and LAN listening (`remoteAccess`) stay two separate
settings. The host settings and the link flow show the LAN setting and its
current state. A host advertises `lan` routes only when its listener is not
loopback (D2).

The reasons:
- **A personal desktop is often a laptop that moves.** On a café or hotel
  network, `0.0.0.0` lets every device on that network reach `/health`
  (name and OS), `/pair`, and the full HTTP surface. The tunnel listener needs
  a credential and permits only a short list of paths (`http.ts:196-208`).
- **The user agrees to different things.** "Reach this computer from my account"
  and "open a port on this Wi-Fi" are different permissions.
- **Flow.** On macOS, the first `0.0.0.0` listener shows a firewall dialog. That
  dialog in the middle of the link flow is a surprise.
- **The gain without it is small.** The tunnel already works everywhere. LAN
  listening makes connections faster but adds no capability.

A standalone server is not affected: the operator sets `SOLUS_HOST`.

### D5. HTTPS limits for the web client

| Where the web client opens | Can it dial `http:` routes? |
| --- | --- |
| From a host, `http://<lan-ip>:<port>/` | Yes |
| `https://app.solus.sh` | No: the browser blocks mixed content. It uses `tunnel` routes and HTTPS routes only. |

Thus learned routes make the web client on `app.solus.sh` faster only when a
route is HTTPS. Solus has no HTTPS tailnet route today. `tailscale serve`
support is out of scope for this plan (§9).

### D6. Adding a machine over SSH, with or without an account

`hostsAddOverSsh({ sshTarget, authSecret?, link })` replaces
`connectionsBootstrapDiscoveredServer`. It needs no discovery: any target that
`ssh user@box` can reach is permitted.

`SshProvisioner` does these steps:

1. **Check.** It connects with `SshClient`, then reads the OS, the CPU
   architecture, and the installed Solus version. Linux and macOS are
   supported. A Windows target fails with a clear message until
   `scripts/install.ps1` exists (`docs/plans/windows.md`).
2. **Install.** It runs `scripts/install.sh` on the remote machine when Solus is
   not installed or its version is older than this host's version. The script
   brings its own Node.
3. **Start.** It installs a user service so that the server keeps running after
   the SSH connection closes and while the client sleeps:
   - Linux: a `systemd --user` service. If lingering is off
     (`loginctl enable-linger`), the service stops at logout, so the flow tells
     the user and shows the command.
   - macOS: a `launchd` agent.
   - Otherwise: `nohup` with a PID file.

   It records `startedBySolus`. Remove stops only a server that Solus started.
   If a server already runs, Solus uses it and does not take ownership.
4. **Identity.** It reads the remote identity key over SSH (D3).
5. **Reach.** This depends on `link`:
   - **`link: true` (the default when signed in).** The client gets an
     enrollment ticket (`uplinkIssueEnrollmentTicket`), and `SshProvisioner`
     gives it to `solus link --ticket-stdin`, through stdin and never in argv.
     The host registers and links. The remote server listens on `127.0.0.1`,
     and the tunnel listener is separate. Every client then reaches the host
     through the directory and its tunnel route, and learned routes are added
     if the operator turns LAN listening on.
   - **`link: false`, or not signed in.** `SshProvisioner` runs
     `solus auth session create` (this command exists today) for a session
     token, then calls `ForwardedHosts.add` (D7). The remote server listens on
     `127.0.0.1`, so no port opens on its network.

Progress (check, install, start, identity, reach) goes on the `hostsSshProgress`
topic, in the same form as setup's `SetupLogEvent`.

`SshProvisioner` runs on the host that the client asks: the desktop's own
server, or the server that a web or mobile client is connected to. SSH keys and
`~/.ssh/config` are read on that host, as SSH device hosts do today. A password
(`authSecret`) goes through the RPC only for that one call and is given to
`ssh` through askpass, as `ssh-bootstrap.ts` does today.

### D7. Forwarded hosts: Solus without an account

`ForwardedHosts` (`server/src/remote-machines/forwarded-hosts.ts`) owns every
forward that this host holds to another Solus host.

- **Record**, saved in this host's data directory:
  `{ installationId, label, sshTarget, remotePort, identityKey, startedBySolus }`.
  The session token is kept in the secret store, not in the record.
- **Open.** It calls `SshClient.forward(target, remotePort)` and adds the route
  `{ kind: 'forwarded', url: 'http://127.0.0.1:<local>', source: 'ssh', viaHostId: <this installation> }`.
- **Keep open.** When the forward stops (sleep, network change, a reboot of either
  machine), it opens the forward again with backoff. At boot, it opens all saved
  forwards.
- **State.** Each forwarded host is `open`, `reconnecting`, or `failed`, and a
  failed host shows the SSH error. It sends `forwardedHostsChanged` when a state
  changes.
- **Remove.** It closes the forward, stops the remote server if
  `startedBySolus`, revokes the session token on the remote host, and offers to
  uninstall Solus there.
- **Link later.** "Link with account" on a forwarded host runs D6 step 5 with
  `link: true` over the same SSH target. The forward stays open as a route
  (D9).

Who can use a forwarded route:

| Client | Can it dial the forwarded host? |
| --- | --- |
| The desktop renderer on the machine that holds the forward | Yes |
| Host-to-host from that machine (`start_session` with `host: box`) | Yes. The forward is on that host. |
| A web client or mobile app on another device | No. The UI shows "Reachable only from <machine>" and offers "Link with account". |

Solus hosts do not relay other clients' traffic. Relaying would make each host
into a proxy, with its own auth, bandwidth, and failure problems. Linking with
the account solves the same need.

`ForwardedHosts` runs on every host: the desktop and a standalone server. A web
client that is connected to a standalone server and adds a machine over SSH
makes the forward on that server. `remote-hosts.ts` reads `ForwardedHosts` as a
third source of targets, after the directory and introductions, and dials with
the session token that SSH made. Thus an agent on a standalone Linux server can
call `start_session` with `host: <mac>`, and the Mac runs the build, the
simulator, and its own agent, with no account and no open port. The user sees
that work from every client that is connected to the Linux server, through the
session that started it.

Without an account, the host does not know who a person is, so only the host's
owner (the local principal) can use its forwards. An organization member reaches
a host only through account reach (`docs/plans/host-reach.md`), as today.

### D9. A forward stays open after the host is linked

When a forwarded host is linked, the forward stays as a `forwarded` route on the
machine that holds it. It is the first route that `dialableRoutes` gives.

What the forward gives after the link:
- **LAN speed without a LAN port.** LAN listening is off by default (D4). For a
  machine on the same network, the forward is the only fast route that needs no
  open port.
- **Encryption.** SSH encrypts the traffic. A `lan` route is plain `http:`, and
  the host proof (D3) does not encrypt it.
- **Independence from Solus cloud and Cloudflare.** The holding machine still
  reaches the host when the tunnel or the directory is down.
- **A shorter path to a server in a data center.** That server has no `lan`
  route, so the only other route is the tunnel.

Rules for a linked host's forward:
- A failed forward is not an error while another route connects. It retries at
  `DIRECT_ROUTE_RECHECK_MS` (60 s), and the host details show its state.
- "Remove forward" closes only the SSH route. "Remove host" also unlinks the host
  and does the remote cleanup in D7.

### D8. One SSH owner

`server/src/platform/ssh.ts` is the only code that starts `ssh`:

- `SshClient.run(target, script, args, auth)`: the script goes on stdin, so no
  path or argument becomes shell text. This is the method of
  `ssh-device-script.ts`.
- `SshClient.forward(target, remotePort): Promise<SshForward>`: this is the code
  from `SshDeviceHost.forward` (`ssh-device-host.ts:219-258`): `-N`,
  `ExitOnForwardFailure=yes`, a captured PID, and an `exited` promise.
- `SshClient.resolvesToThisMachine(target)`: the `ssh -G` check from
  `ssh-device-host.ts:311`.
- The connection options (today `transport/handlers/lib/ssh-options.ts`) and the
  askpass script (today in `ssh-bootstrap.ts`) move here.

Its users: `SshProvisioner`, `ForwardedHosts`, `SshDeviceHost`, setup's
`setupCheckSshAccess`, and `git/git-auth-env.ts`, which needs only the options.

## 4. Ownership

Each piece of logic has one owner. The server and every client import the pure
parts from `contracts`.

### `packages/contracts/src/`

| File | Change | Owns |
| --- | --- | --- |
| `host-routes.ts` | New | `HostRoute`, `mergeRoutes`, `dialableRoutes`, `chooseRoute`, `directRouteBack` (D1). |
| `host-identity.ts` | New | `healthProofSchema`, `verifyHostProof` (D3). |
| `uplink.ts` | Edit | Remove `hostRouteSchema` and the "saves no route of its own" rule. `directoryHostSchema` uses `HostRoute` and adds `identityKey`. |
| `host-api.ts`, `rpc.ts`, `types.ts` | Edit | Server info: `routes`, `identityKey`. `hostsAddOverSsh`, `hostsListForwarded`, `hostsRemoveForwarded`, `hostsLinkForwarded`. Topics `hostsSshProgress` and `forwardedHostsChanged`. `SshAddResult` and `ForwardedHost`. Remove `connectionsBootstrapDiscoveredServer`, `SshBootstrapCredential`, and `SshBootstrapResult`. |

### `packages/client-core/src/`

| File | Change | Owns |
| --- | --- | --- |
| `host-routes.ts` | New: `HostRouteBook` | The only writer of `SavedServer.routes`: `fromDirectory`, `fromHost`, `fromDiscovery`, `fromPairing`, `fromForward`. Each method calls `mergeRoutes`, then `upsertServer`. |
| `host-proof.ts` | New: `proveRoute(url, identityKey)` | Sends `/health?nonce` and verifies the proof. It is the `RouteCheck` for `chooseRoute`. |
| `server-registry.ts` | Edit | `SavedServer`: remove `url`, add `identityKey`. Delete `savedServerRoutes` and `dialableRoutes`. |
| `uplink-session.ts` | Edit | `mergeDirectoryIntoSaved` merges host rows only and gives routes to `HostRouteBook.fromDirectory`. Delete `withNearbyRoutes`. |
| `server-connection.ts` | Edit | A credential goes only on a `tunnel` route or on a route that passed `proveRoute`. |
| `pairing.ts` | Edit | Saves `identityKey` from `/pair`. Delete `saveBootstrappedServer`. |
| `route-choice.ts` | Delete | Moved to `contracts/host-routes.ts`. |

### `packages/server/src/`

| File | Change | Owns |
| --- | --- | --- |
| `host/host-identity.ts` | New: `HostIdentity` | `publicKey()`, `sign(nonce, url)`. |
| `host/host-registration.ts` | Edit | Sends `identityKey` at enrollment. |
| `transport/endpoints.ts` | Edit | `advertisedRoutes`. Remove `reachableUrls`. |
| `transport/http.ts` | Edit | `/health` proof. `/pair` returns `identityKey`. Delete `/endpoints`. |
| `transport/handlers/connections-handlers.ts` | Edit | Server info adds `routes` and `identityKey`. Thin `hosts*` handlers that call `SshProvisioner` and `ForwardedHosts`. |
| `execution/orchestration/remote-hosts.ts` | Edit | Remove its own URL order. Use `mergeRoutes`, `chooseRoute`, and the host proof. Read `ForwardedHosts` as a third source of targets, for the owner only (D7). |
| `execution/orchestration/introduced-hosts.ts` | Edit | Use `advertisedRoutes`. |
| `platform/ssh.ts` | New: `SshClient`, `SshForward` | D8. |
| `remote-machines/ssh-provisioner.ts` | New: `SshProvisioner` | D6. |
| `remote-machines/forwarded-hosts.ts` | New: `ForwardedHosts` | D7. |
| `devices/ssh-device-host.ts` | Edit | Use `SshClient`. Its behavior does not change. |
| `transport/handlers/setup-handlers.ts`, `git/git-auth-env.ts` | Edit | Use `SshClient` and its options. |
| `transport/ssh-bootstrap.ts`, `transport/handlers/lib/ssh-options.ts` | Delete | Moved to `platform/ssh.ts` and `SshProvisioner`. |
| `admission/auth.ts` | Edit | Delete `getServerFingerprint` and `issueSshBootstrapCredential`. |
| `boot-server.ts` | Edit | Make `HostIdentity`, `SshProvisioner`, and `ForwardedHosts`. Start the forwards at boot and close them at shutdown. |

`tests/unit/server-module-boundaries.test.ts` must permit `remote-machines/`.
`remote-machines/` uses `platform/` and `transport/endpoints`. It must not use
`execution/`. `execution/orchestration/remote-hosts.ts` may read
`remote-machines/forwarded-hosts.ts`.

### Apps and the workspace UI

| File | Change | Owns |
| --- | --- | --- |
| `apps/standalone-server/src/index.ts` | Edit | `solus link --ticket-stdin`. Keep `auth session create`. |
| `workspace-ui/src/components/servers/host-onboarding.store.svelte.ts` | Edit | The "Add over SSH" flow: target, auth, link choice, progress. The logic stays in the store. |
| `workspace-ui` host settings | Edit | The LAN setting and its state (D4). The forwarded host state, "Reachable only from <machine>", Remove, and Link with account. |
| `apps/mobile/src/features/hosts/AddOverSshScreen.tsx` | New | The same flow through a connected host. |
| `apps/mobile/src/features/hosts/` host rows | Edit | The forwarded host state, Remove, and Link with account. |

## 5. Change in another repo: `solus-cloud` (not needed; see amendment 2)

- `POST /v1/hosts/enroll` accepts `identityKey` and saves it with the host.
- `GET /v1/hosts` returns `identityKey` for each host.
- The tunnel route keeps its current shape, with `kind: 'tunnel'` and
  `source: 'directory'` added on the client.

Steps 2 and 3 of the work order (§8) need this change before a host proof can
come from the directory. Until then, only paired and SSH-added hosts have a
key, and a host known only from the directory uses only its tunnel route.

## 6. Every applicable surface

- **Entry points.** "Add over SSH" in Settings → Hosts, in the host picker's
  "Add machine" item, and in the command palette. The host row's context menu
  has Remove and Link with account.
- **Clients.** Desktop and web share the Svelte UI. Mobile gets its own
  React Native screen. Desktop is the only client that can dial a forwarded
  route that it holds. The web client and mobile show the forwarded host's
  state and the reason.
- **Providers.** None. Claude and Codex are not affected.
- **Contracts.** §4, `packages/contracts`.
- **Reverse states.** Add has Remove. A forward has a visible state and
  "Remove forward" (D9). Link has Unlink (this exists today). LAN listening has
  its setting.
- **Connection modes.** The desktop and a standalone server both hold forwards.
  A standalone server uses its forwards for its own host-to-host dials (D7). An
  `https:` web client follows D5.
- **Persistence and refresh.** `HostRouteBook` is the only writer of client
  routes. `ForwardedHosts` is the only writer of forward records.
  `forwardedHostsChanged` keeps every mounted client up to date.
- **Docs.** ADR 0001 §2.2 rule 9 (the route rule), `docs/plans/host-reach.md`
  (host proof on host-to-host dials), and the user docs for adding a machine.

## 7. Tests

Each test must fail if the rule that it protects changes.

- `mergeRoutes`: a new read from one source replaces only that source's routes.
  Old routes expire.
- `dialableRoutes`: an `https:` origin drops `http:` routes. A `forwarded` route
  is dropped unless `viaHostId` is this host.
- `chooseRoute` with the host proof: a LAN device that answers with the correct
  `installationId` but a bad signature never wins, and gets no token.
- `server-connection`: no account token or session token is sent on a `lan`
  route before the proof passes.
- `advertisedRoutes`: a loopback listener advertises nothing. A `0.0.0.0`
  listener advertises LAN and tailnet addresses, without host-only interfaces.
- `remote-hosts`: host A prefers B's proven LAN route to B's tunnel route.
- `SshClient.forward`: the captured PID is the one that `close()` stops. A
  forward that exits makes `exited` resolve.
- `ForwardedHosts`: a stopped forward opens again with backoff. Records open again
  at boot. Remove stops the remote server only when `startedBySolus`.
- `remote-hosts` with no account: an agent on host A starts a session on host B
  through A's forward and B's session token. A principal that is not the owner
  gets no forwarded target.
- A linked host whose forward fails: the client connects through the tunnel and
  reports no error. The forward retries at `DIRECT_ROUTE_RECHECK_MS`, and the
  client goes back to the forward when it opens.
- `SshProvisioner`, with a fake `SshClient`: an existing server is used and not
  owned. The ticket goes on stdin and never in argv. A Windows target fails
  with the message.
- `SshDeviceHost` keeps its current tests, which now run on `SshClient`.

## 8. Work order

One PR for each step. Each step leaves Solus working.

1. **Route model and route owner.** D1 and D8 without new behavior:
   `contracts/host-routes.ts`, `HostRouteBook`, removal of `SavedServer.url`,
   `remote-hosts.ts` using `chooseRoute`, and `SshClient` with `SshDeviceHost`
   using it.
2. **Identity key and host proof.** D3: `HostIdentity`, `/health` proof, `/pair`
   key, `proveRoute`, and the credential rule in `server-connection.ts`. Needs
   the `solus-cloud` change for directory keys.
3. **Learned routes.** D2: `advertisedRoutes`, server info routes,
   `HostRouteBook.fromHost`. Delete `/endpoints` and `withNearbyRoutes`.
4. **Add over SSH with link.** D6 with `link: true`: `SshProvisioner`,
   `solus link --ticket-stdin`, the onboarding flow on desktop, web, and
   mobile. Delete `ssh-bootstrap.ts`.
5. **Forwarded hosts.** D6 with `link: false`, D7, and D9: `ForwardedHosts` on
   the desktop and a standalone server, the forwarded route, `remote-hosts.ts`
   reading forwarded targets, and the state and reverse states on every client.

Steps 1 to 3 are small to medium. Steps 4 and 5 are each a feature.

## 9. Out of scope

- **`tailscale serve`.** It would give a host an HTTPS tailnet route that the
  web client on `app.solus.sh` can dial (D5). It is a separate plan.
- **Hosts that relay traffic** for clients on other devices (D7).
- **A device host link over a Solus connection** (`docs/plans/devices.md` §5.5).
  SSH device hosts stay as they are. They only move onto `SshClient`.
- **Windows SSH targets** until `scripts/install.ps1` exists.

## 10. Open questions

None. A standalone server holds forwards for its owner (D7), and a forward
stays open after a link (D9). Both were decided on 2026-10-25.

## 11. Execution record (2026-10-25)

Unit tests: `host-routes`, `host-identity`, `host-link`, `handshake-credential`,
`ssh-provisioner`, `forwarded-hosts`, `remote-hosts`, `introduced-hosts`,
`client-core`, `add-over-ssh`, `native-mobile-ssh-hosts`, and the updated host and
connection tests pass.

On real machines, with a local test server on a Mac (`SOLUS_DATA_DIR` in
`.solus-local/`) and a test install on each target beside its live Solus
(`SOLUS_SSH_INSTALL_PLACE`; the live servers on port 3000 were not touched):

| Check | Linux (omarchy) | Windows 11 |
| --- | --- | --- |
| Check, install, start the service over SSH | Released v0.36.1 installed, `systemd --user` service started; the identity step then refused the old version with "Update Solus there" | No Windows installer in the release (404, now a clear message); with a test copy in place, `solus setup` started the logon task |
| Session and identity key over SSH, forward opened | Yes | Yes, through PowerShell |
| Dial through the forward with the right key | Connected | Connected |
| Wrong key, or no key saved | No credential sent, `dial-failed` | No credential sent, `dial-failed` |
| Learned LAN route from server info | Advertised; blocked by `ufw` and lost to the forward in the parallel check; with a temporary rule, proved and connected; a wrong key refused | Advertised; Windows had made Public-profile block rules for the new `node.exe`. With those removed and a LAN-only allow rule, proved and connected; a wrong key or no key sent nothing; a client on another machine used the LAN route, the forward's holder used the forward. Rules removed after the test |
| Forward after the holding server restarts | Opened again on the same local port | — |
| Host-to-host (`RemoteHosts`) through the forward | Owner only; proved; execution RPC answered (after the `tokenKind` fix) | Same |
| Remove, "also stop Solus there" | Kept the service when Solus had not started it; removed it when it had | Removed the logon task |

Not tested end to end: the link to an account (needs an enrollment ticket from a
signed-in account), and the UI on a device or in a browser.
