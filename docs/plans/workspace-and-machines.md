# Record homes and machines — separating where records live from where work runs

Status: proposed, 2026-09-24. Nothing here is implemented.

## 1. Why

On `app.solus.sh` a signed-in member sees, on every load:

- `Unknown Solus server: managed:<hostId>` from saved prompts, the session start
  gate, and every other read keyed by the run's host, after the organization's
  managed host was deleted or stopped appearing in the directory.
- `"start" | "usageLimits" | "getPluginCommands" belongs to the execution plane,
  which this host does not serve` from the workspace service.

The two errors come from one gap. The server side has two kinds of process:

- **workspace service**: one cloud process for every organization, with the
  `collaboration` role only, backed by Postgres.
- **runner**: a machine with checkouts and agent processes (`execution`).

The client still has one kind: a *host* that serves every method, one of which is
the *primary*. The workspace service was added to the client as a host that
refuses half its methods, and nothing in the model can hold a host that used to
exist.

The retired cloud service plan (§15, revised 2026-09-21) already said this: the
service is "a connection the client holds, never a host the person sees … not a
machine", and it reports `roles: ['collaboration']` "so a client keeps the
service out of its execution targets". The surface layer follows that rule. The
connection layer and boot do not.

## 2. What the code does today

What already follows the split:

- `serversStore.servers` is the machines alone; `serversStore.cloudConnections`
  is the workspace rows (`contexts/connections/servers.store.svelte.ts`).
- `serversStore.executionServers` and `hostRolesStore`
  (`contexts/connections/host-roles.store.svelte.ts`, fed by
  `connectionsGetServerInfo.roles`) keep the service out of the Run-on picker,
  the project dialog, and dispatch targets.
- `RunConfig` already holds two hosts: `serverId` (where the run happens) and
  `taskServerId` (where its tasks are minted).

What does not:

1. **The directory contract lists the service as a host.** `/v1/hosts` returns a
   `kind: 'cloud'` row whose `hostId` and `installationId` are both
   `workspace:<organizationId>` (`directoryHostSchema`,
   `packages/contracts/src/uplink.ts`; `solus-cloud/src/lib/server/uplink/hosts.ts`).
   `mergeDirectoryIntoSaved` saves it into `solus.servers` beside the machines.
2. **Boot makes the service the primary.** `bootFromCatalog`
   (`apps/client/src/main.ts`) treats every saved server as a boot candidate and
   calls `serverConnections.registerPrimary` on the first that accepts. At the
   account origin that is the workspace row.
3. **"The primary" is used as "the host that runs work".** About 85 reads of
   `serverConnections.defaultServerId()`, `WorkspaceContext.fallbackServerId`,
   and `defaultHostApi()` across 47 files: `initStaticInfo` calls `start()` on it
   (`workspace-lifecycle.store.svelte.ts`), `refreshUsage` calls `usageLimits()`
   on it (`agent.context.svelte.ts`), and `defaultRunConfig` falls back to it for
   the run's host (`workspace.context.svelte.ts`), which sends a hostless draft's
   `getPluginCommands` there too. None of these ask which plane the call is on.
4. **A connection has one type.** The service and a machine are both a
   `SavedServer`, a `SolusServerTarget`, and a full `SolusAPI`; nothing stops a
   caller from invoking an execution method on the service.
5. **A stored host id has no lifecycle.** The directory is the authority on
   which machines exist, but the client keeps raw ids in `localStorage` that
   outlive it: `settings.lastProject` (a device field), tab snapshots
   (`serverId`, `serverInstallationId`), drafts' `run.serverId`, and
   `activeServerId`. `defaultStartProject` (`run-config.ts`) keeps a remembered
   host unless its status is `offline` or `different-server`. A host that is
   not in the catalog reads as `disconnected`, passes, and then
   `ServerConnections.resolveTarget` throws `Unknown Solus server` for every
   read keyed by it.

## 3. Target model

Two concepts, kept apart from the directory contract down to the RPC call.

**Record homes**: where the records live: tasks, works, plans, comments,
shares, presence, session records and mirrored transcripts, automations,
notifications. A record has exactly one home, and a window reads from several
homes at once, as the tasks store already does:

- **The organization's workspace**: the workspace service, reached with a member
  grant for `aud: solus-workspace`. The home of a Solus Cloud project's records,
  of what a managed host's agents write, and of anything moved to Solus Cloud.
- **A machine's own records**: every machine that serves `collaboration` (a
  laptop, a self-hosted server) is the home of its own projects' records. Tasks
  stay local first (`tasksAreCloudOwned`, `outbox/cloud-ownership.ts`): a
  person's linked machine keeps its tasks, and a person moves one to the cloud
  on purpose.

**The active organization.** A window has one active organization, set by the
team switcher (better-auth's `setActiveOrganization`, marked `isActive` in the
directory, §4), on web and desktop alike. It decides two things only:

1. which organization's cloud records the boards show, beside the records of the
   person's own machines, which always show;
2. where something new goes when it goes to the cloud: a new Solus Cloud
   project, "Move to Solus Cloud".

An existing record always goes to its own home, whatever the active
organization is. The client holds a connection to the active organization's
workspace; a record of another organization (opened from a link or a
notification) is read through a temporary connection
(`withTemporaryConnection`), not by switching.

A workspace is never a place work runs, never a row in Connections or a picker,
and never "offline" the way a machine is: without it the window shows the
person's machine records and says the organization cannot be reached.

**Machines**: where work runs. A session is pinned to one machine; a machine
has checkouts, agent processes, and the machine's own window, updates, and
browser. A window has zero or more. Machines come and go; they are paired,
linked, shared, stopped, and deleted.

"No machine" is a normal state. A cloud member with no machine sees the
workspace (tasks, sessions from the mirror, works) and a composer that says
"Choose a machine" instead of failing.

**Planes decide the target.** `RPC_PLANES` (`packages/contracts/src/rpc-planes.ts`)
is already the single statement of which plane every method is on; today only
the server reads it (`server/roles.ts`). The client uses the same table to decide
where a call goes:

| Plane | Goes to |
|---|---|
| `collaboration` | the record's home; for something new, the project's home (a Solus Cloud project's is the active organization's workspace, a machine project's is that machine) |
| `execution` | the run's machine; with no run, the default machine; with neither, nowhere — the caller renders "no machine" |

A laptop is both: the home of its own records and a machine, as two handles
over the same connection.

## 4. The directory contract

Change in `packages/contracts/src/uplink.ts` first; `bun run contracts:sync`
copies it to `solus-cloud/src/lib/shared/uplink.ts`.

```ts
export const directoryWorkspaceSchema = z.object({
  organizationId: z.string(),
  label: z.string(),               // the organization's name
  routes: z.array(hostRouteSchema), // tunnel only
  isActive: z.boolean(),           // replaces isActiveWorkspace on the host row
})

export const directoryResponseSchema = z.object({
  hosts: z.array(directoryHostSchema),                                     // machines only
  workspaces: z.array(directoryWorkspaceSchema).optional().catch(undefined), // new
})
```

- `hosts` lists machines only: personal hosts the caller owns or can use through
  an organization, and managed hosts. `hostKindSchema` loses `cloud`.
- `workspaces` lists one entry per organization the caller belongs to. The
  grant route is unchanged (`workspace:<organizationId>`); only the listing
  moves.
- Rollout: solus-cloud emits both the `kind: 'cloud'` host rows and
  `workspaces` until every supported client reads `workspaces`, then drops the
  rows (§8, step 5).

## 5. The client

### 5.1 The registry

`ServerConnections` (`packages/client-core/src/server-connections.ts`) keeps one
socket per endpoint, as today, and exposes the two concepts separately:

```ts
workspace(): WorkspaceConnection | null      // the active organization's workspace
recordHome(record): CollaborationApi         // the home of one record: a workspace or a machine
isKnownServer(id: string): boolean          // see §6
defaultMachineId(): string | null            // where new work goes
```

- `registerPrimary`, `defaultServerId()`, `setPrimary` and
  `WorkspaceContext.fallbackServerId` go away. `setPrimary` becomes
  `setDefaultMachine`.
- The default machine is, in order: the machine the person chose last (a device
  setting that replaces the part of `activeServerId` that named a machine), the
  machine cloud onboarding chose, the organization's managed host, and the first
  online machine the person owns. It is only ever a host that serves `execution`
  (`hostRolesStore.hasExecution`), so the workspace service can never be picked.
- The workspace is the active organization's service, or null when the account
  is in no organization or signed out. Switching organization swaps it.

### 5.2 Typed APIs by plane

Derive two views of `SolusAPI` from `RPC_PLANES`:

```ts
type CollaborationMethod = { [M in RpcMethod]: (typeof RPC_PLANES)[M] extends 'collaboration' ? M : never }[RpcMethod]
type CollaborationApi = Pick<SolusAPI, CollaborationMethod>
type ExecutionApi = Pick<SolusAPI, ExecutionMethod>
```

`workspace().api` and `recordHome(record)` are a `CollaborationApi`; a live
machine's `api` is an `ExecutionApi` (a laptop, the home of its own records,
hands out both). A call such as
`workspace().api.start()` is then a compile error, not a runtime
`PLANE_DISABLED`. `PLANE_DISABLED` remains the server's guard against an older
client.

### 5.3 Boot

`bootFromCatalog` has two steps, not one list of candidates:

1. **Workspace.** When the account is signed in, dial the active organization's
   workspace from the directory's `workspaces`.
2. **Machines.** Every saved machine gets a supervisor
   (`startCatalogSupervisors`, unchanged), and the default machine is resolved
   (§5.1). At a machine's origin that machine is saved as before.

Either one mounts the app: a workspace with no machine, or a machine with no
workspace. With neither, the page is the hostless home, as today.

### 5.4 What moves where

The ~85 primary reads fall into four groups:

- **Execution with no run**: `refreshUsage` → `usageLimits()`, plugin commands
  for a hostless draft, voice model, browser, attachments. They go to
  `defaultMachine()` and do nothing when it is null.
- **Startup facts** (§5.5): `initStaticInfo` → `start()` goes away.
- **Collaboration**: tasks, works, automations, insights, the task page. They go
  to the record's home (`recordHome`); boards read every home they show.
- **Machine chosen by the caller**: pickers, settings' host selector, project
  favicon, Git dropdown. They already have a machine id from their context and
  keep it; the fallback becomes `defaultMachine()`.

### 5.5 Startup facts become machine facts

`StaticInfo` (`workspace-lifecycle.store.svelte.ts`) is six facts about one
machine: `version`, the agent account's `email` and `subscriptionType`,
`projectPath`, `homePath`, `workspacePath`. Today they are read once at mount by
`start()` on the primary and read as if the window had one machine (about 45
reads in 21 files).

`start()` is already a per-machine read; what is wrong is where it is sent. Step
1 sends it to the default machine and reads nothing when there is none:
`staticInfo` is the default machine's facts, read again when the default machine
changes (a machine that connects after boot). Step 6 moves each reader to the
machine it names, keyed by machine, and deletes the single `staticInfo`:

| Reader | Machine | With no machine |
|---|---|---|
| draft and project chip, `defaultRunConfig`'s folder | the run's machine, else the default machine | the chip reads "Choose a machine"; Send is disabled |
| status bar version and agent account | the active tab's machine | hidden |
| Settings (projects folder, agent account) | the host the settings selector names | the selector offers only machines; empty with none |
| automations builder and launchpad | the automation's machine | "Choose a machine" |
| breadcrumbs and favicons (paths shown relative to home) | the session's machine | the path is shown whole |

A machine that has not answered yet reads as loading, not as missing.

## 6. Machine references

A stored machine id is **known** when `serverConnections.isKnownServer(id)`
says so: a registered target, a live connection, or a saved host — the ids
`resolveTarget` answers for. Anything else names a machine that was deleted or
was never listed at this origin.

**Reads treat an unknown host as unusable, never as an error.** Nothing asks
`apiFor` for it:

- `hostRolesStore` gives an unknown host no roles, so every gate that asks
  `hasExecution` or `hasCollaboration` (the Run-on list, dispatch, the Git
  environment read, plugin commands) skips it.
- `defaultStartProject` treats a remembered project on an unknown host as down.
- Saved prompts list nothing for it.

**Writes wait until the saved hosts are authoritative.** The saved list only
loses a directory host on a successful directory read (`mergeDirectoryIntoSaved`),
and a paired host that was unlinked keeps its direct route and stays known. A
failed read changes nothing. `markDirectoryAnswered()` (`server-registry.ts`)
marks a successful merge, at boot (`apps/client/src/main.ts`) and on every
refresh (`serversStore.refreshDirectory`).

**One owner for removal.** `reconcileMachineReferences`
(`contexts/workspace/machine-references.ts`) updates every reference to an
unknown host; readers do not each handle a ghost. It runs from
`initializeRuntime` after restore, on every successful directory read, and when
a machine connects — but only once a directory has answered this load, or when
the client has no directory at all:

| Reference | When its machine is unknown |
|---|---|
| `settings.lastProject` | cleared; `defaultRunConfig` falls to the default machine |
| an unstarted draft or tab | moved to where a new session starts (the default machine and its folder), as a fresh draft would be; with no machine, it stays until one connects |
| a draft opened from a task | moves as above and keeps the task's home, unless that is unknown too |
| a started tab | kept on its machine: its conversation lives there |

A live connection to a host the directory dropped is kept (a refresh never cuts
a working session), and the host stays known while it is connected.

Left for later: the Run-on chip's "Host removed — choose a machine" text, and
a started tab's read-only "This machine was removed" state.

## 7. What stays the same

- The server: roles, `PLANE_DISABLED`, grants, the runner protocol, the mirror.
- One socket per endpoint, and supervisors per machine.
- Desktop: the local machine is the home of its own records and the default
  machine; signed in, it also holds the active organization's workspace, as the
  web does. The same model, not a special case.
- Joining an organization moves nothing. A person's machine keeps its records
  and keeps writing new ones locally (`tasksAreCloudOwned` is true only on a
  managed host); "Move to Solus Cloud" moves one record on purpose. Adding a
  repository as a Solus Cloud project may later offer to bring that project's
  existing tasks along; that is a separate change.
- Guests: a guest link opens a workspace-only window with no machines.

## 8. Order of work

Each step ships alone and leaves the tree green.

1. **Default machine** (client). `serverConnections.defaultMachineId()`
   (`chooseDefaultMachine` in `server-registry.ts`); `start()`, `usageLimits`,
   and `fallbackServerId` use it; nothing is read with no machine, and
   `start()` is read again when a machine connects; plugin commands are read
   only from a host that serves `execution` (§5.5). *Fixes the
   `PLANE_DISABLED` errors.*
2. **Machine references** (client). `isKnownServer`, no roles for an unknown
   host, `defaultStartProject` treating it as down, the Git and saved-prompt
   reads skipping it, `markDirectoryAnswered`, and
   `reconcileMachineReferences` (§6). *Fixes `Unknown Solus server`.*
3. **Boot in two steps** (client). Workspace first, machines second;
   `registerPrimary` and `activeServerId` stop naming the workspace.
4. **Directory `workspaces`** (contract, then solus-cloud). Emit the new field
   beside the old rows; the client reads `workspaces` when present and the
   `kind: 'cloud'` rows otherwise.
5. **Drop the cloud rows** (solus-cloud) once clients from step 4 are the
   oldest supported. Remove `kind: 'cloud'`, `isActiveWorkspace`,
   `isCloudServer`, `cloudConnections`, and `savedCloudServerIds`.
6. **Typed plane APIs** (client). `CollaborationApi`/`ExecutionApi`; move the
   remaining primary reads (§5.4) and delete `defaultServerId`,
   `fallbackServerId`, and `defaultHostApi`.

## 9. Proofs

- Unit: `defaultMachine()` never returns a collaboration-only host; the `gone`
  rule over successful, failed, and missing directory reads; each row of the
  §6 table.
- Unit, the regression: a cloud origin whose saved `lastProject` and a draft
  name a machine the directory no longer lists loads with no
  `Unknown Solus server` and no `PLANE_DISABLED`.
- Lab: a workspace-only member (no machine) opens tasks, a mirrored session,
  and a work, and the composer says "Choose a machine".
- Lab: deleting the organization's managed host while a client is open moves
  its drafts and leaves its started tabs read-only.
- Type: `workspace().api.start` does not compile (a `@ts-expect-error` test).

## 10. Decisions

- **Several organizations**: one active organization per window, from the team
  switcher, on desktop and web alike. It chooses which cloud records the boards
  show and where new cloud things go; an existing record always goes to its own
  home (§3).
- **A machine joining an organization**: nothing moves; records stay local
  first; moving is explicit (§7).
- **Startup facts**: per machine, in the capability record; every reader names
  its machine and has a "no machine" state (§5.5).
