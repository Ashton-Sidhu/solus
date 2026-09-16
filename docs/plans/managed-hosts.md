# Managed hosts: one always-on Solus host per team, provisioned by Solus cloud

**Status:** Step 3 of the cloud plan, first implementation (2026-09-15). The plan is the work "Solus Cloud — Step 3: Managed Hosts on Fly"; this file records the vocabulary and the decisions the code depends on, with the section numbers the code comments cite. The control plane half lives in the private `solus-cloud` repository; this repository holds everything a host enforces, the Linux image, and the clients.

**Decision this implements:** one always-running Fly Machine with one encrypted persistent volume per managed host. The same Solus server, SQLite managers, Socket.IO transport, provider adapters, seats, and Cloudflare tunnel as a personal Uplink host. No workspace Postgres, no execution workers, no second WebSocket protocol.

## Vocabulary

- **managed host** — a host the control plane provisioned for an organization. `kind: 'managed'` in the directory and in every grant. It has no owner person: organization owners administer it (`isHostAdmin`), organization members use it, and no principal is ever `local-owner` or `remote-owner` on it.
- **personal host** — a person's own machine, linked by that person (Personal Uplink). Unchanged by this work.
- **managed mode** — how the server boots on a managed host: `SOLUS_MANAGED=1`. In managed mode nothing is trusted by network position, pairing does not exist, the link is system-owned, and every caller arrives through the tunnel with a grant.
- **managed link** — how a managed host gets its link. The control plane enrolls the host itself when it creates the machine and puts the finished link record and tokens in the machine's environment (`SOLUS_MANAGED_LINK`); the host stores them at first boot exactly as a personal host stores what the Link button answers. No person signs in on the host, and no exchange happens at boot.
- **lifecycle** — what a person sees of the compute: `provisioning | starting | ready | stopping | stopped | failed | deleting`. Derived on every read from the provider's machine state and the link. Nothing stores it.
- **workspace** — a member's own directory beneath the host's projects root, where their clones land and their pickers open. A default, not a boundary.
- **desired state** — what the control plane wants of the compute: `running | stopped | deleted`. Stored; every operation is a retry-safe reconciliation toward it.

## §1 Managed mode on the host

`SOLUS_MANAGED=1` (read once at boot by `packages/server/src/server/managed-mode.ts`) makes these true for the life of the process:

- No trusted requester: loopback, tailnet, and the local network are all strangers (`isTrustedRequesterAddress` answers false). `requireAuth` is always on, on the first bind and on every rebind. Only a grant ticket admits a socket, on either listener.
- No pairing: `/pair*` answers 404 on both listeners, no pair token is printed at boot, and the pairing RPCs are refused.
- The link is system-owned: `uplinkLink` and `uplinkUnlink` are refused with `MANAGED_HOST`; `uplinkStatus` still answers. Unlinking a managed host is a control-plane delete.
- No LAN discovery.
- Server settings that widen admission (`trustLocalNetwork`) are ignored.

The refusals are one set, `MANAGED_HOST_REFUSED_RPC_METHODS` in `access-policy.ts`, checked before any standing is weighed: `uplinkLink`, `uplinkUnlink`, `connectionsGeneratePairToken`, `connectionsBootstrapDiscoveredServer`, `connectionsSetRemoteAccess`, `connectionsSetTrustLocalNetwork`. The error is an `RpcAccessError` with `code: 'MANAGED_HOST'`, so the transport carries it like any other refusal. Every method in the set is also `local-only`, so the class map stays exhaustive.

Clients learn the kind from the host itself: `connectionsGetServerInfo` answers `hostKind: 'personal' | 'managed'`, and the Solus cloud card (Link/Unlink) is not shown on a managed host.

The host learns it is managed from its own environment, not from grants. A grant's `hostKind` still drives `isHostAdmin`; the two agree because the control plane mints `hostKind: 'managed'` for hosts it provisioned.

## §2 The managed link

Environment the control plane sets on the machine: `SOLUS_MANAGED=1`, `SOLUS_MANAGED_LINK=<EnrollHostResponse as JSON>`, `SOLUS_DATA_DIR=/data/state`, `HOME=/data/home`, `SOLUS_PROJECTS_ROOT=/data/projects`.

The control plane runs the same `activateLink` enrollment does when it creates the machine (generation advanced, host token minted, tunnel provisioned, link marked `linked`) and hands the whole answer to the machine in its environment. The control plane keeps no copy of the tokens; the machine config is the only place they exist outside the host.

At boot, `applyManagedMode()` reads `SOLUS_MANAGED_LINK` once (`readManagedLinkEnv()`) and deletes it from `process.env` before any child process exists, so no agent inherits the tokens. Then `UplinkLinkManager.resume()`:

1. If the environment carries a link and there is no record, or the environment's `connectionGeneration` is newer than the record's, the host stores it exactly as a personal enrollment (tokens in the secret store, link record on disk) and starts the connector. The newer-generation rule is what lets a recreated machine (a retry, a later image rollout) take over: the control plane enrolls again and the new machine's environment carries the newer link.
2. Otherwise the ordinary path runs: the record on the volume is the truth, and the generation check against the directory tells a superseded copy to stop.

An environment value that is not a link is logged (`managed_link_env_invalid`) and ignored; the host is then unlinked and the control plane's lifecycle read shows it. The request that enrollment used to carry (`label`, `installationId`) is not needed: a managed host is named by its organization on the control plane.

## §3 Persistent state on the volume

Everything that must survive a restart resolves under `/data`:

| State | Path |
|---|---|
| Solus database, works, plans, tasks, settings, link record, secret store | `/data/state` (`SOLUS_DATA_DIR`), 0700 `solus` |
| Host provider homes (transcript roots the session index reads) | `/data/home/.claude`, `/data/home/.codex` (`HOME=/data/home`) |
| Member seats | `/data/state-seats` (`<SOLUS_DATA_DIR>-seats`, plan §3.1 of provider-seats.md) |
| Repositories and worktrees | `/data/projects` (`SOLUS_PROJECTS_ROOT`) |
| Managed cloudflared and other pinned binaries | image (`/opt/solus`), never the volume |

`SOLUS_PROJECTS_ROOT` is the host's projects root (`setupProjectsRoot()`); a host administrator's `projectsBaseDirectory` setting still outranks it, as on a personal host. Each organization member gets a **workspace** beneath it, `<root>/<userId>` (`projectsRootFor(principal)` in `setup-handlers.ts`): it is their default clone destination, the directory their pickers open on, and their home on the host (`start` answers it as `projectPath` and `homePath`; `setupHostReadiness` and `getServerCapabilities` name it too). The owner of a personal host and the host's own work use the root itself. The workspace is a default, not a boundary: members see every session and work on the host (decision 2026-09-15) and may open any path. The connector finds the image's `cloudflared` through `SOLUS_CLOUDFLARED=/opt/solus/bin/cloudflared`, the explicit override it already reads first, so it never looks under the data directory. The image and its runbook are `packaging/managed-host/`.

The image is replaceable; the volume is authoritative. One server owns the SQLite file; there is never a second process against it.

## §5 Process identity

Every agent on a managed host runs as the same non-root `solus` user as the server. Members' seat files are readable by any agent on the host. This is the accepted risk of the first version, and per-member OS identities are the recorded escalation.

## §6 Backups and recovery

Two paths, both configured in the image, both optional so a local run needs neither:

1. Litestream replicates the SQLite file continuously to the per-host object-storage prefix in `LITESTREAM_REPLICA_URL` (R2, S3 API; `LITESTREAM_REPLICA_ENDPOINT`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` beside it, expanded by `packaging/managed-host/litestream.yml`). The entrypoint runs the server under `litestream replicate -exec` when the variable is set.
2. Fly volume snapshots (daily, five-day retention at creation) cover the rest of `/data`.

Recovery is documented in `packaging/managed-host/README.md`: restore the snapshot onto a fresh volume, then `litestream restore` the database over the snapshot's copy so the database is never older than the files. Revoke the old link generation before the replacement boots. No zero-data-loss claim: the objective is the age of the newest snapshot plus Litestream's sync interval.

## §7 Lifecycle in the control plane (`solus-cloud`)

`managed_host` row per host: Fly app, machine, volume, region, image, desired state, current operation id, last error. Operations are idempotent against Fly's own state (find the app, volume, and machine by name before creating any), so "retry" is "run the same operation again". Order on create: host row (`kind: managed`, `installationId: managed:<hostId>`) → managed row → app → volume → enroll (`activateLink`) → machine with the link in its env → the host stores it at boot. Delete: revoke the link and advance the generation first, then machine, volume, app, tunnel; the managed row is removed only when every resource is confirmed gone.

One managed host per organization; only organization owners create, stop, start, or delete one. The feature is behind `MANAGED_HOSTS_ALLOWED_ORGS` (organization slugs, or `*`) until billing exists.

## Non-goals of this version

Independent session workers, idle stopping, zero-downtime image updates, active-active hosts, access to a stopped host's content, Fly's native HTTPS edge, and per-turn cost billing.
