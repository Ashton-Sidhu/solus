# 033 The client keeps only its credentials

Status: PLAN, 2026-11-20. Decisions signed off (§3). Not started. Amends [031](031-host-owns-its-data.md) D7.

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
  `paired_at`, `last_seen_at`, `revoked_at`. Regenerate the baseline
  (`bun run db:generate`; plan 029 keeps one migration file).
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
