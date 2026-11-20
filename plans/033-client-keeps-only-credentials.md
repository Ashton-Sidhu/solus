# 033 The client keeps only its credentials

Status: IMPLEMENTED, 2026-11-20, on branch `solus/integrate-host-credential-catalog` (S1–S5 merged; not
pushed). Decisions signed off (§3). Amends [031](031-host-owns-its-data.md) D7. The
choices the stages made are in §7.

## 1. Problem

The developer wiped the database. The Map still showed `sidhu`, `omarchy`,
`Raiders`, and `FIERCE V1 Test Environment`. These hosts are not in a database.
They are in `localStorage`:

- `solus.servers` (`client-core/src/server-registry.ts`) keeps a full
  `SavedServer` for each host: label, OS, routes, last connection, token, and
  `uplink` (the directory facts: organization, owner, kind, managed state).
- `refreshDirectory` copies each account directory read into `solus.servers`
  (`mergeDirectoryIntoSaved`). `saveDirectoryWorkspaces` copies the
  organizations' workspace services into localStorage too (`workspace-registry.ts`).
- 031 D7 put the host list in a database, but it kept this list "beside" the
  database list (`withListedHosts`). About 45 files read `loadServers()` directly
  and synchronously, which bypasses the hosts store.

The host side has the same gap. A pairing token is a signed token that the host
does not record (`admission/auth.ts`). The host keeps only its signing key and
`revoked-devices.json`. The Access tab lists only the devices that are connected
now (`connectionsListSessions`). A paired device that is offline is not shown.

## 2. Rules (developer decision, 2026-11-20)

1. **The host list is in a database.** Signed out: the `host_list` table of the
   device host. Signed in: the account `hosts` document. Cloud machines, hosts
   shared with the person, and the organizations' workspace services come only
   from the account directory. A client keeps no copy of any of them.
2. **A client keeps only its credentials.** For each host that this client
   paired: the token and the facts that only this device knows about how to dial
   (§4.1). No label, OS, last connection, or directory facts.
3. **Renderer code reads hosts only from the hosts store.** Desktop and web read
   the Svelte store. Mobile reads its store. Both wrap one in-memory catalog in
   `client-core`. No reader calls `localStorage` or a load function.
4. **A host records the devices that it paired**, in its database. A token is a
   random secret. The host keeps only its hash. Revoking a device changes its row.
5. **No migration.** There are no users (plan 029 decision 1). `solus.servers`,
   `solus.mobile.hosts.v1`, the workspace cache, and `revoked-devices.json` are
   deleted, not read. Every current pairing ends once.

The exception from 031 D7 stays: a client with no device host (a phone, or a web
page at the account origin) keeps its list on the device while signed out. That
list is a third implementation of `HostListSource` (`device`). It is not a second
list beside the database list.

## 3. Decisions (developer sign-off, 2026-11-20)

The developer took each recommendation. Stages run in parallel child sessions on
Opus 5.5.

| # | Question | Decision |
| --- | --- | --- |
| Q1 | A list read succeeds and does not name a host for which this client holds a credential. | Delete the credential. A wipe or a forget on another device then also forgets the host here. A failed read deletes nothing. |
| Q2 | Cold start with no network. | Cloud machines show after the first directory read. Until then, the Map shows a loading state for Solus Cloud. If the read fails, it shows an error state with Retry. There is no cached copy. |
| Q3 | The name of the joined type that replaces `SavedServer`. | `KnownHost`. It is not saved any more, so the old name is wrong (renderer naming rule). |
| Q4 | `solus.activeServerId`. | Keep it in localStorage. It is a choice of this window, not host data. |

## 4. Model

### 4.1 Client: credentials and catalog (`packages/client-core/src/`)

- **`host-credentials.ts`** replaces the storage half of `server-registry.ts`.
  One record for each host id:
  `{ token, identityKey?, tokenPairedOverHttps?, routes, routeOrder? }`.
  `routes` holds only the routes that this device knows: its pairing address,
  routes that the person added here (`user`), and LAN routes found here. The
  storage is a port: `localStorage` on desktop and web, the keychain on mobile.
- **`host-catalog.ts`** is the one in-memory owner of the hosts a client knows. It
  joins three answers by host id: the list source (`HostListSource`), the account
  directory, and the credentials. It gives `hosts()`, `find(id)`,
  `managedHostIds()`, and `onChange(listener)`. It has a state for each answer:
  `loading`, `ready`, or `failed`. `withListedHosts`, `listingOf`, and
  `mergeDirectoryIntoSaved` become one pure join function in this module.
- `server-connections.ts`, `server-connection.ts`, `session-runner.ts`,
  `pairing.ts`, `host-link.ts`, and `uplink-session.ts` read the catalog, not
  `loadServers()`.
- **Boot.** A client dials the device host first, then reads the list, then dials
  the hosts in the list. A host with a credential is dialed with its token. A
  host with no credential is dialed with an account grant.
- **Pair.** Write the credential, then put the listing to the source.
- **Forget.** Remove the listing from the source, then delete the credential.
- **Sign in and sign out** change the source (031 D7). The credentials stay.

### 4.2 Renderer

- `servers.store.svelte.ts` wraps the catalog. `remotes` becomes the catalog's
  `hosts()`. `workspaces` comes from the directory answer.
- Each file that calls `loadServers()`, `managedHostIds()`, `upsertServer()`, or
  `saveServers()` reads or commands the store. The list is in §6.
- The web client (`apps/client/src/main.ts`, `lib/add-host.ts`,
  `lib/primary-connection.ts`, `routes/lib/hostless-hosts.store.svelte.ts`, and
  the demo seed) uses the same catalog.
- The Map and every host picker show the loading and failed states from §3 Q2.

### 4.3 Mobile (`apps/mobile/src/features/hosts/`)

- `host-registry.ts` keeps only credentials, in the keychain. The `uplink` and
  `accountUserId` fields go.
- Signed in, the list comes from the account. Signed out, it comes from the
  `device` source in device storage (§2 exception).

### 4.4 Host (`packages/server/src/`)

- New table `host_device` in `solus.db`: `device_id`, `kind`
  (`paired` | `grant` | `host`), `label`, `token_hash` (paired only),
  `paired_at`, `last_seen_at`, `revoked_at`. It is the migration
  `drizzle/sqlite/0002_host_device.sql`, made by `bun run db:generate` on top of
  `0000_baseline` and `0001_integration_resource_watches` (the baseline is not made
  again).
- `admission/auth.ts`: `issueSessionToken` writes a `paired` row and returns a
  random token. `verifySessionToken` finds the row by hash and refuses a revoked
  row. `refreshSessionToken` keeps the token and updates `last_seen_at`.
  `revokeDevice` sets `revoked_at` for every kind. An account grant or an acting
  host that is revoked gets a row of kind `grant` or `host`.
  `revoked-devices.json` goes.
- `connectionsListDevices` (new RPC) lists the paired devices with their last
  connection. The Access tab shows them beside the connected sessions, with
  Revoke.
- `execution/orchestration/introduced-hosts.ts` uses the same functions.

### 4.5 Client-core API (S2)

Built in S2. This is the contract for S3 (desktop and web) and S4 (mobile).
`server-registry.ts` is gone. Device storage on desktop and web holds one entry,
`solus.hostCredentials`. The first credential read deletes `solus.servers` and
`solus.workspaces`; nothing reads them (§2 rule 5).

**Modules and exports**

| Module | Exports |
| --- | --- |
| `known-host.ts` (replaces `server-registry.ts`) | `KnownHost`, `KnownHostUplink`, `LOCAL_SERVER_ID`, `getActiveServerId`, `setActiveServerId` (Q4), `awaitsManagedCompute`, `hostInOrganization`, `managedHostNeedsStart`, `chooseRunOnHost({ primaryId, localId, known, activeOrganizationId, isConnected })` (the `saved` input is now `known`), `pairedAddress`, `serverFromSshAdd`, `installationIdDecision` |
| `host-credentials.ts` | `HostCredential` `{ token, identityKey?, tokenPairedOverHttps?, routes, routeOrder? }`, the port `HostCredentialStorage` (`read`, `write`, `remove`), `localStorageCredentials(storage?)`, `encodeCredentials`, `decodeCredentials`, `HOST_CREDENTIALS_KEY`, `DEVICE_ROUTE_SOURCES` (`pairing`, `user`, `discovery`, `ssh`, `page`), `isDeviceRoute`, `deviceRoutes` |
| `host-list-source.ts` | `HostListSource` (now with `key` and an optional `subscribe(onChange)`), `hostListHostSource(hostId, api, events?)` (new first argument), `hostListAccountSource(documents)`, `deviceHostListSource(storage)` (key `solus.hostList`), `hostListSourceFor({ accountDocuments, deviceHost, deviceStorage })`, `ListingStorage` |
| `host-catalog.ts` | `HostCatalog`, the page's `hostCatalog` (desktop and web: `localStorage`, `uplinkAccountSource()`, `takeStartupDirectoryRead`), `activeOrganizationId()` (moved from `workspace-registry.ts`), and the types `AnswerState`, `HostCatalogOptions`, `HostDirectoryReader`, `PairOutcome` |
| `host-join.ts` | The pure join: `joinHosts`, `listingOf`, `credentialOf`, and the types `CatalogAnswers`, `DirectoryAnswer`, `LearnedFacts` (split from `host-catalog.ts` at integration) |
| `workspace-registry.ts` | `KnownWorkspace` (was `SavedWorkspace`), `ambiguousOrganizationIds`, `workspaceFor(workspaces, serviceId)`, `activeWorkspace`, `workspaceTarget` |
| `server-connection.ts` | `knownHostTarget` (was `savedServerTarget`); `preferredRouteUrl` takes a `KnownHost`. A refreshed token goes to `hostCatalog.renewToken`. |
| `server-connections.ts` | `new ServerConnections(catalog = hostCatalog)`. After the first `startCatalogSupervisors()`, each catalog change dials the hosts it adds and re-aims moved routes; no caller starts supervisors after a pair or a directory read. `verifySavedServerIdentity` is now `verifyKnownHostIdentity`. |
| `session-runner.ts` | `knownRunnerFor` (was `savedRunnerFor`), `connectedRunnerFor(runnerHostId, known?, readinessFor?)` |
| `uplink-session.ts` | `organizationIdFor(hostAnswer, uplink, activeOrganizationId)`. The directory merge functions are gone. |
| `pairing.ts` | `PairServerResult.server` is a `KnownHost`. |

`host-link.ts` keeps `isSavedHost`, `answersAsSavedHost`, and `SavedHostIdentity`:
the server imports `answersAsSavedHost`, and S2 does not change server code.

**`HostCatalog`**

| Member | Meaning |
| --- | --- |
| `load()` | Reads the credentials once. Boot awaits it before `startCatalogSupervisors()`. |
| `hosts()`, `find(id)`, `managedHostIds()` | Sync reads of the join. `hosts()` is a new array after each change. |
| `workspaces()`, `workspaceFor(serviceId)` | The directory's workspace services. |
| `listState()`, `directoryState()` | `loading` before the first read settles; `failed` while no read succeeded; `ready` after one did. A later failed read keeps the last answer and the state. Signed out, or with no account, the directory is `ready` with no hosts. |
| `directorySignedIn()`, `listSourceKey()` | What the last directory read said; which source is read. |
| `onChange(listener)` | Any change of a read above. |
| `onForgotten(listener)` | A host leaves: `forget`, a host paired again at its address, or §3 Q1. Replaces `onServerRemoving`. |
| `useListSource(source)` | Sign-in and sign-out change the source. The same `key` only reads again. A new key: each host this device paired that the old list named goes to the new list at its first read, so a sign-in forgets nothing. When no read of the old list succeeded, each host this device holds a token for goes. The first source at boot gets no copy. |
| `setDeviceHost(id)` | The host that served a web page (`ServerConnections.setServingHostId` calls it). It is never put on a list, §3 Q1 never deletes its credential, and it shows from its credential. |
| `refresh()`, `refreshList()`, `refreshDirectory()` | Reads again. A directory read in flight is shared. |
| `pair(host)` | Writes the credential, then puts the listing. Resolves `{ host, listError }`; a listing the list refused stays shown and is sent again at the next read. |
| `forget(id)` | Removes the listing, then deletes the credential. Throws, and deletes nothing, when the list does not answer. |
| `renewToken(id, token)` | A refreshed token, for a host with a credential. |
| `touchLastConnected(id)`, `stampOperatingSystem(id, os)`, `applyAdvertised(id, advertised)` | Kept in memory, and put to the list for a host this device paired. |
| `applyForwarded(forwarded)`, `applyDiscovered(discovered)` | Route reads; `true` when something changed. Device routes go to the credential of a host that has one, else stay in memory. |
| `changeRoutes(id, change)` | A person's route change (`host-route-control.ts`): written to this device's credential (with no token for a host dialed with a grant); the listing follows a removed pairing route. |

Join rules (`joinHosts`): a listed host takes its label, OS, and host routes from
the list, its token, routes, and route order from this device, and its uplink and
tunnel from the directory (matched by installation id). A directory host that this
page cannot reach and holds no token for is left out. A credential that no answer
names shows only while the list is `failed`, so boot dials listed hosts after the
read. §3 Q1 runs only after a successful read, when the list and the directory are
both `ready`.

**What replaces each removed export**

| Removed | Use |
| --- | --- |
| `loadServers()` | `hostCatalog.hosts()` or `hostCatalog.find(id)` |
| `saveServers`, `upsertServer`, `savePairedServer` | `await hostCatalog.pair(server)`; show `listError` as "paired here but not yet on your host list" |
| `changeServer` | `await hostCatalog.changeRoutes(id, change)`, then `serverConnections.followRoutes(id)` |
| `removeServer` | `await hostCatalog.forget(id)` (end the account registration first for a directory host) |
| `touchLastConnected`, `stampHostOperatingSystem`, `applyAdvertised` | the catalog methods of the same meaning (`ServerConnections` calls the last two) |
| `withForwardedRoutes` + `saveServers` | `hostCatalog.applyForwarded(forwarded)` |
| `withDiscoveredRoutes` + `saveServers` | `hostCatalog.applyDiscovered(discovered)` |
| `managedHostIds()` | `hostCatalog.managedHostIds()` |
| `onServerSaved` | `hostCatalog.onChange` |
| `onServerRemoving` | `hostCatalog.onForgotten` |
| `markDirectoryAnswered`, `hasDirectoryAnswered`, `onDirectoryAnswered` | `hostCatalog.directoryState() === 'ready'` and `onChange` |
| `withListedHosts`, `mergeDirectoryIntoSaved`, `savedServerFromDirectory` | the catalog's join; read `hosts()` |
| `listingOf` (from `host-list-source.ts`) | `listingOf` in `host-catalog.ts`; callers do not need it |
| `loadWorkspaces`, `saveDirectoryWorkspaces` | `hostCatalog.workspaces()`, `hostCatalog.refreshDirectory()` |
| `savedWorkspaceFor(id)` | `hostCatalog.workspaceFor(id)` |
| `activeOrganizationId` from `workspace-registry.ts` | `activeOrganizationId` from `host-catalog.ts` |
| `SavedServer`, `SavedServerUplink`, `SavedWorkspace` | `KnownHost`, `KnownHostUplink`, `KnownWorkspace` |
| `savedServerTarget`, `savedRunnerFor` | `knownHostTarget`, `knownRunnerFor` |

**S3 wiring (desktop and web)**

1. Boot: `await hostCatalog.load()`. Register and dial the device host, then call
   `serverConnections.startCatalogSupervisors()` once. Then choose the source and
   call `hostCatalog.refreshDirectory()`. The listed hosts are dialed when the list
   answers.
2. On every account state change: `hostCatalog.useListSource(hostListSourceFor({
   accountDocuments: signedIn ? accountDocuments() : null, deviceHost: deviceHostId ?
   { id, api: serverConnections.apiFor(id), events: serverConnections.eventsFor(id) } :
   null, deviceStorage: localStorage }))`. Only the account origin, which has no device
   host, uses `deviceStorage`.
3. `servers.store` wraps the catalog: `remotes` and `workspaces` are `$state` copies
   of `hosts()` and `workspaces()`, set in `onChange`, where it also reconciles the
   window's organization. The wake, focus, and timer reads call `hostCatalog.refresh()`
   or `refreshDirectory()`; the timer and the focus gap stay in the store.
   `startManagedHost` reads `hostCatalog.find(id)?.uplink?.managedState` after each
   `refreshDirectory()`.
4. The Map and every host picker show `directoryState()` (`loading`, `failed` with
   Retry calling `refreshDirectory()`) and `listState()`.
5. `onForgotten` clears the skew dismissals, queued sends, and pull request cache of
   the host, as `onServerRemoving` did.
6. `apps/client`: `adoptCloudDirectory` calls `hostCatalog.refreshDirectory()` (it
   takes the startup read). `probeServingOrigin` reads `hostCatalog.hosts()`.
   `pairFromLocation`, `add-host.ts`, and `primary-connection.ts` call
   `hostCatalog.pair`. `HostlessHome` calls `hostCatalog.forget`. A boot with no
   known host awaits the list and the directory before it chooses the hostless home.

**S4 wiring (mobile)**

1. Build one `new HostCatalog({ credentials, directory: () => accountReader,
   clientOrigin: () => '' })`. The keychain adapter keeps each token in its own
   `SecretStore` item, and the non-secret dial facts in device storage (§7).
2. Source: `hostListSourceFor({ accountDocuments: signedIn ? documents : null,
   deviceHost: null, deviceStorage: keyValueStore })`.
3. `HostRegistry` keeps no host data: `hosts()` and `host(id)` read the catalog,
   `credential(id)` is `find(id)?.sessionToken`, `savePaired` is `pair`,
   `updateCredential` is `renewToken`, `touch` is `touchLastConnected` and
   `stampOperatingSystem`, `applyAdvertised` and route changes call the catalog, and
   `onHostRemoved` is `onForgotten`. `applyDirectory`, `setListedHosts`,
   `onListingChange`, `uplink`, and `accountUserId` go: the catalog reads the
   directory and writes the listings. `paired` is `!!sessionToken`.

## 5. Surfaces

- **Clients:** desktop, web served by a host, web at the account origin, mobile.
- **Providers:** not applicable.
- **Contracts:** `connectionsListDevices` in `rpc.ts`, with its handler and
  preload. `host-list.ts` does not change.
- **Connection modes:** desktop-local; web served by a host (its device host is
  the serving host); the account origin (no device host); mobile.
- **Reverse states:** pair and forget; revoke (no un-revoke: pair again).
- **States:** loading, failed, and ready for the list and for the directory.
- **Docs:** 031 D7 ("beside the hosts it keeps itself" changes to "joined with
  its credentials"), `docs/plans/host-routes.md` (persistence row),
  `docs/plans/workspace-and-machines.md` (`solus.servers`), and
  `docs/plans/host-fleet.md`.

## 6. Stages

| Stage | Work | Depends on | Proof |
| --- | --- | --- | --- |
| S1 | Host: `host_device`, stateful pairing, revocations in the database, `connectionsListDevices`. | — | Unit tests: pair, verify, refresh, revoke, a wiped database refuses an old token. |
| S2 | `client-core`: `host-credentials.ts`, `host-catalog.ts`, and every `client-core` reader. Delete `loadServers`, `saveServers`, `upsertServer`, `changeServer`, `withListedHosts`, `listingOf`, `mergeDirectoryIntoSaved`, `saveDirectoryWorkspaces`. | — | Unit tests for the join and for Q1. |
| S3 | Desktop and web: the hosts store, the about 40 `workspace-ui` readers, `apps/client`, the Access tab, and the Map states. | S1, S2 | `bun run lint:hosts`, typecheck, focused tests. |
| S4 | Mobile: credentials-only registry and the `device` source. | S2 | Mobile unit tests and typecheck. |
| S5 | Docs from §5. | S3, S4 | — |

S1 and S2 can run at the same time. S3 and S4 can run at the same time after S2.

## 7. Record (2026-11-20)

The stages were built in parallel child sessions and merged on `solus/integrate-host-credential-catalog`.
Choices the stages made:

- **S1. A refresh keeps the same token.** `refreshSessionToken` updates
  `last_seen_at` and returns the token it got, so the `/auth/refresh` contract
  does not change. A token not used for 30 days is refused.
- **S1. Migration.** `0002_host_device` on top of `main`'s chain (§4.4). A fresh
  database migrates from `0000_baseline` to it (`tests/unit/data-model-baseline.test.ts`).
- **S4. One keychain item per token.** The phone keeps each host's token in its
  own `SecretStore` item and the non-secret dial facts (routes, their order, the
  identity key) in device storage, not one item for every credential.
- **Integration. The device host is exempt from Q1.** S3 put the host that served
  a web page on that host's own list at each boot, so that Q1 did not delete the
  page's credential. Instead the catalog names it the device host
  (`setDeviceHost`): it is never written to a list, Q1 never deletes its
  credential, and it shows from the credential. A host's list holds the hosts the
  person connected to from it, not the host itself (lead decision).
- **Integration. A sign-in or sign-out keeps this device's pairings.** S4 found
  that a source change after a failed read of the old list moved no host to the
  new list, so Q1 then deleted every credential. A source change with no
  successful read of the old list now moves each host this device holds a token for.
- **Integration. Mobile host pickers** (new task host, project host, settings
  host, and policy host) show the list and directory states of §3 Q2
  (`UnreadHostsNotice`), as desktop and web do.
- **Integration. `host-join.ts`** holds the pure join, split from `host-catalog.ts`.
