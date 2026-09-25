# Record homes and machines — separating where records live from where work runs

Status: steps 1–4 implemented (2026-09-24): Solus `refactor/record-homes-and-machines`, solus-cloud `feat/directory-workspaces`. Step 5 waits on rollout; step 6 is deferred.

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
defaultServerId(): string | null             // the window's own record home (the primary)
defaultMachineId(): string | null            // where new work runs; never the workspace service
isKnownServer(id: string): boolean           // see §6
```

- **The primary is the window's record home.** Boot registers it: the desktop's
  own machine, the machine that served a web page, or — at the account origin —
  the organization's workspace service. Records with no narrower home (a new
  task, a work, an automation listing, pins, push) go there. That is right in
  every case, so boot is unchanged (revised 2026-09-24: an earlier draft made
  boot stop registering the workspace service; once machine work stopped
  reading the primary, that change had nothing left to fix).
- **The default machine** (`chooseDefaultMachine`, `server-registry.ts`) is the
  primary when it is a machine, else the desktop's own, else the active
  organization's managed host, else the first connected machine; null when there
  is none. It is never a `cloud` row. Every read that means "a machine" uses it
  (§5.4); `WorkspaceContext.fallbackServerId` is it, then the primary.

### 5.2 Typed APIs by plane

Derive two views of `SolusAPI` from `RPC_PLANES`:

```ts
type CollaborationMethod = { [M in RpcMethod]: (typeof RPC_PLANES)[M] extends 'collaboration' ? M : never }[RpcMethod]
type CollaborationApi = Pick<SolusAPI, CollaborationMethod>
type ExecutionApi = Pick<SolusAPI, ExecutionMethod>
```

A host's API is a `CollaborationApi` when it serves only that plane (the
workspace service) and both when it is a machine; `apiFor` answers with the
narrow type for a `cloud` row. A call such as `start()` on the workspace service
is then a compile error, not a runtime `PLANE_DISABLED`. `PLANE_DISABLED`
remains the server's guard against an older client.

### 5.3 Boot

Unchanged (§5.1): boot registers the window's record home as the primary, and
every saved machine gets a supervisor (`startCatalogSupervisors`). A window at
the account origin with no machine mounts on the workspace service alone.

### 5.4 What moves where

The primary reads (`defaultServerId()`, `fallbackServerId`, the workspace's own
sessionless default) fall into two groups:

- **Machine work** uses `defaultMachineId()` and reads nothing when it is null:
  `start()`, usage, plugin commands, voice model and transcription, insights
  (`metrics*` are execution), attachments, the directory picker and its Git
  identity, project favicons, skills, the capability mirror
  (`connectionsStore.capabilities`: agents, dictation, desktop handlers), local
  onboarding, remote history scanning, the Settings host selector (it lists
  machines only), automation drafting and seeding, and sessionless Git and
  context calls. Web prompt dispatch asks for a host when the run's host runs no
  agents.
- **Records** keep the primary: tasks, works, the automation listing, pins,
  push subscription, notification labels, host discovery.

Left as it is: the task page offers no "start session" for a task whose home is
the workspace service (its own stated rule), although `openTaskSession` can
route such a task to a machine. Whether to offer it is a product call.

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
3. **Split the primary reads** (client). Machine work moves to
   `defaultMachineId()`; records keep the primary (§5.4). Boot stays as it is
   (§5.1). Steps 1–3 are on `refactor/record-homes-and-machines`.
4. **Directory `workspaces`** (contract, then solus-cloud). Emit the new field
   beside the old rows; the client reads `workspaces` when present and the
   `kind: 'cloud'` rows otherwise (`directoryHostsOf`). Done: the contract and
   client on the Solus branch, the route on solus-cloud
   `feat/directory-workspaces`. The Solus side ships first: the control plane's
   contract copy must match Solus `main` (`src/lib/shared/uplink.test.ts`).
5. **Drop the cloud rows** (solus-cloud) once clients from step 4 are the
   oldest supported. Remove `kind: 'cloud'`, `isActiveWorkspace`,
   `isCloudServer`, `cloudConnections`, and `savedCloudServerIds`. Waits on that
   rollout.
6. **Typed plane APIs** (client). Deferred (2026-09-24). `apiFor(serverId)`
   takes ids that are only known at run time, so a type split protects nothing
   unless every record read moves to a separate accessor — a wide API change for
   a guard that steps 1–3 already give at each call site. Revisit if a machine
   call on the workspace service reappears.

## 9. Proofs

- Unit (`tests/unit/default-machine.test.ts`): the default machine is never the
  workspace service; usage and `start()` read nothing with no machine and read
  once when one is there.
- Unit (`tests/unit/machine-references.test.ts`): each row of the §6 table, and
  which ids are known.
- Unit (`tests/unit/cloud-origin-startup.test.ts`): only a merged directory
  marks the saved hosts authoritative.
- Lab: a workspace-only member (no machine) opens tasks, a mirrored session,
  and a work, and the composer says "Choose a machine".
- Lab: deleting the organization's managed host while a client is open moves
  its drafts and leaves its started tabs read-only.
- Unit (`tests/unit/directory-workspaces.test.ts`, solus-cloud `hosts.test.ts`): both directory forms give the same saved rows; a malformed `workspaces` reads as absent.

## 10. Decisions

- **Several organizations**: one active organization per window, from the team
  switcher, on desktop and web alike. It chooses which cloud records the boards
  show and where new cloud things go; an existing record always goes to its own
  home (§3).
- **A machine joining an organization**: nothing moves; records stay local
  first; moving is explicit (§7).
- **Startup facts**: the default machine's, read again when it changes; each
  reader moves to the machine it names later (§5.5).
- **Boot**: unchanged. The primary is the window's record home; machine work
  reads the default machine instead (§5.1).
