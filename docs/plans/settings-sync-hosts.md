# Sync settings: the same server settings on each host of a signed-out person

Status: implemented. Date: 2026-11-24. It adds decision 8 to
[ADR 0007](../adr/0007-personal-settings-source.md) and extends
[the source of a person's settings](personal-settings-source.md). It follows the
shared-settings rule of T3 Code (`packages/client-runtime/src/state/sharedSettings.ts`
and `apps/web/src/hooks/useSettings.ts`): a change to a shared server setting goes to
each connected host where the person may write settings. Solus also copies the
settings at pairing, which T3 does not do.

## The problem

Signed out, each host keeps its own set of a person's settings (ADR 0007 decision 2). A
client reads and writes only its home host. A person who adds a second host gets the
built-in defaults there, and a change on one host never reaches the other.

## Vocabulary

- **Server settings**: the settings that a host keeps, as against the device settings
  that a client keeps (never copied). They are two parts:
  - the person's **personal settings** that the host keeps for them
    (`PersonalSettingsDocument`), and
  - the **shared host settings**: the keys of `HostConfig` that do not name this
    machine's disk, network, or binaries (`SHARED_HOST_CONFIG_KEYS`).
- **Sync settings switch**: one switch for each person on each host. On: the host
  takes the server settings at pairing, and each later change that the person makes to
  a synced host. Off: the host keeps its own settings.
- **Synced host**: a host whose switch is on for the person.
- **Copy source**: the host whose server settings a new host takes at pairing: the home
  host (`personalSettingsHomeId`), else the host that the person adds it from.
- **Settings host**: the host whose server settings Settings shows and changes.

## The host setting keys

Copied and spread (`SHARED_HOST_CONFIG_KEYS`, confirmed by the maintainer):

| Key | Why it is not bound to one machine |
| --- | --- |
| `sessionCloudSync` | The person's choice to save sessions to Solus Cloud. |
| `solusTools` | Which Solus tools agents may use. |
| `continueSessionsAfterHostRestart` | A policy for the person's work. A managed host still forces it off. |
| `archivedAutomationRetentionDays` | How long archived automations stay. |
| `unfiledRecordingRetentionDays` | How long unfiled recordings stay. |
| `otel` | Where telemetry goes, with its collector headers. The maintainer chose to copy it. |
| `analyticsEnabled` | The person's analytics consent for the host emitter. |

Never copied:

| Key | Why |
| --- | --- |
| `previewTunnelEnabled` | Network access to this machine's loopback ports. |
| `agentAutoUpdates` | The agent binaries that Solus installed on this machine. |
| `reviewWarmingByProject` | Keyed by project paths on this machine's disk. |
| Every server setting outside `HostConfig` | `remoteAccess`, `tailscaleServe`, `trustLocalNetwork`, `projectsBaseDirectory`, `webhookPublicUrl`, `metricsRetentionDays`, the Insights opt-in, and the host user name this machine. |

A test (`tests/unit/settings-sync-hosts.test.ts`) holds the list: a key that is added
to `HostConfig` must be put in one of the two lists.

## Decisions

1. **Device settings stay on the device.** Never copied (maintainer decision 1).
2. **The switch is on the host, for each person.** The host keeps it in
   `personal_documents` with the kind `settings-sync` (no new table, no migration). A
   person with no row has the switch on. `personalSettingsGet` returns it as
   `syncSettings`; `personalSettingsSyncSet(syncSettings)` changes it (permission
   `host.connect`, execution plane, as the other personal settings calls). It is on the
   host, not on the client, so each client of the person shows the same switch, and a
   second client that adds the same host does not undo the person's choice.
   `personalDocument.changed { kind: 'settings-sync' }` tells the person's other
   clients.
3. **The client spreads; hosts never talk to each other.** One engine in client-core,
   `SettingsSyncHosts` (`settings-sync-hosts.ts`), on desktop, web, and mobile. It keeps
   the switch of each host that it read, and a queue of changes for each host in
   durable client storage.
4. **At pairing, copy.** Each add or pair flow shows a **Sync settings** checkbox, on by
   default. After the flow saves the host, it calls `hostAdded(hostId, syncSettings)`.
   - On: the engine queues a copy for the new host: set its switch on, then make its
     personal settings equal to the copy source's, and write the copy source's shared
     host settings (only where the person is host administrator). It goes when both
     hosts are ready.
   - Off: the engine queues only "switch off". Nothing is copied.
   - A host that a client pairs by itself (`HostPairingFollower`, a host that another
     client of the person already added) is not a person's add: nothing is copied.
5. **Keep spreading.** After the person changes a server setting on the settings host,
   and that host's switch is on, the engine queues the same change for each other
   host that this client knows and whose switch is not known to be off. Personal keys
   go with `personalSettingsPatch`. Shared host keys go with `configUpdate`, only to a
   host where the person is host administrator. A change of a key that is not shared
   (for example `previewTunnelEnabled`) stays on its host.
6. **Hidden and off while signed in.** Signed in, the account keeps every host the
   same (ADR 0007 decision 3). The checkbox and the switch do not show, and the engine
   copies nothing and spreads nothing. The queues stay; they go after a sign-out only
   if the person is still signed out when the host is ready.
7. **Settings shows one host, with a host picker.** Signed out, every Settings page with
   server settings shows the settings host, with the picker. The host of the current
   session is first in the picker, and is the default; then this device's host; then
   the rest. The personal settings on screen are the settings host's copy while
   Settings is open, and the home host's copy again when it closes. A person can so
   change a host whose switch is off; a change to a synced host spreads to the other
   synced hosts.
8. **The agent profile is not in this change.** Its list already goes to each host
   that it applies to ("Copy now", and a copy once per run; plans/020).
9. **A change that an agent makes on a host stays on that host.** `update_config` on a
   host changes that host's config; no client made it, so no client spreads it.

## Offline, failure, and reconnect

- **A host that is away during a change** gets it when it is ready again: the queue is
  in durable client storage (`solus.settings-sync.pending.v1:<hostId>`), so it
  survives a client restart too. Changes to the same key merge: the last value wins.
- **Before it sends, the engine reads the host's switch.** A host whose switch is now
  off drops the queue for that host and keeps its own settings.
- **A copy waits for its source.** A queued copy reads the copy source when both hosts
  are ready, and lays the changes queued after it over the copy.
- **A failed call** (an older host without the calls, a dropped connection, a refused
  host config change) keeps the queue. The next readiness change tries again. A host
  config change that the host refuses for permission is dropped: the person may not
  write it there.
- **Two clients of one person** that write the same host: the last write of a key wins,
  as in personal-settings-source.md decision 6.
- **A host that is forgotten** keeps no queue: the engine drops it.

## Where it is on each client

- **client-core**: `SettingsSyncHosts` (engine), `SHARED_HOST_CONFIG_KEYS` and
  `sharedHostConfigOf` in `@solus/contracts/host-config`.
- **Desktop and web**: `settingsSyncStore` (`contexts/app/settings-sync.store.svelte.ts`)
  owns the engine and its switches. `runtime-boot.ts` starts it. The host settings
  stores call `hostConfigChanged` after each write; the personal store's local changes
  call `personalChanged`. The checkbox (`components/connections/SyncSettingsCheckbox.svelte`)
  is in the Add a machine dialog, the Add machine card, and the web client's first-host
  setup; `serversStore.savePairedServer` reads it. The switch is on the host page
  (`HostDetailOverview`). Settings → the host picker shows on the pages of personal
  settings too.
- **Mobile**: `features/settings/settings-sync.ts` owns the engine on the phone.
  `SolusApp.pair` takes the checkbox value. The checkbox is on the pairing screen and in
  the Add machine steps; the switch is on the environment page. The settings
  environment picker chooses the settings host.

## Providers and connection modes

Nothing is provider-specific: the settings are the same for Claude and Codex.
Desktop-local, desktop-hosted, and remote hosts use the same RPCs over Electron IPC and
WebSockets. A Solus API keeps no settings (execution plane), so the engine never sends
to it.

## Tests that encode the intent

`tests/unit/settings-sync-hosts.test.ts` (client-core engine) and
`tests/unit/person-settings.test.ts` (the switch on the host):

- Pairing with the checkbox on copies the personal settings and the shared host
  settings, and never a machine-bound host key or a device setting.
- Pairing with it off copies nothing and turns the switch off.
- A change spreads to hosts with the switch on, not to a host with it off.
- A host that is away during a change gets it when it is back.
- Nothing is copied or spread while signed in.
- The switch survives a host restart, and a person with no row has it on.
