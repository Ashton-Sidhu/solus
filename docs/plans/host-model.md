# One object per host — host facts in the client

Status: implemented 2026-10-08 on `main` (decisions in §8, limits in §9). Solus
has no users, so this shipped as one change with no compatibility layer.

Supersedes the deferred step 6 of [Record homes and machines](workspace-and-machines.md)
(§5.5) and replaces its "machine work" group (§5.4).

## 1. Why

On 2026-10-08 two bugs had one cause:

- **Usage.** The project panel showed the quota of the default machine, not of
  the tab's host. Quota belongs to a host's agent logins.
- **Voice.** On a desktop whose default host is a remote server, the mic button
  and ⌥⇧Space disappeared. The remote server reported `voiceModel: false`, and
  the voice store copied that answer into its one `supported` flag. Only the
  desktop main process transcribes, and the recorder already sent audio to the
  local machine. The gate and the recorder asked different hosts.

Both stores kept **one copy of a fact about one host** and showed it as a
global fact. The copy followed `defaultMachineId()`. When the default machine
was also the host the reader meant, the bug did not show. When the default was
remote, the fact was wrong and nothing reported an error.

The copies exist because a host's facts have no home. Each fact lives in its own
store, keyed by host id, and each store adds its own shortcut for "the" host.

## 2. What the code did before this change

Host facts were spread over these stores. Each one keeps its own map from host
id to one fact, and some also keep a single copy.

| Store | Per-host data | Single copy |
|---|---|---|
| `hostCapabilitiesStore` (`connections/host-capabilities.store.svelte.ts`) | `HostCapabilities` from `serverGetCapabilities` | — |
| `connectionsStore` (`connections/connections.store.svelte.ts`) | `ServerCapabilities` from `getServerCapabilities` (`capabilitiesByServer`) | `capabilities`, which follows `defaultMachineId()`; `desktopHandlersAvailable` reads it |
| `connectionsStore` | server info, endpoints, connected sessions, GitHub provider status | the whole set is one host at a time (`metadataServerId`, `providerServerId`) |
| `hostRolesStore` (`connections/host-roles.store.svelte.ts`) | roles | — |
| `voiceModelStore` (`app/voice-model.store.svelte.ts`) | `statusByHost`, `supportedByHost` | `status`, `supported`, `ready`, `progressPct`, which follow `transcriptionHostId()` |
| `usageStore` (`usage/usage.store.svelte.ts`) | limits per host | — (removed on 2026-10-08) |
| `toolsStore` (`app/tools.store.svelte.ts`) | detected editors and terminals | `resolvedTerminal`, for the local machine |
| `hostSettingsStore` (`app/host-settings.store.svelte.ts`) | host config | — |
| `WorkspaceLifecycleStore.staticInfo` | — | version, agent account, project, home, and workspace paths of the default machine (about 45 reads in 21 files, §5.5 of the earlier plan) |

There are also two capability records, from two RPCs:

- `HostCapabilities` (`serverGetCapabilities`): which handlers this build has.
  `ServerConnections` also caches it in each connection's supervisor, so it has
  two client caches.
- `ServerCapabilities` (`getServerCapabilities`): runtime facts — agents
  installed, agent and Git auth, platform, projects folder, task policy.

`defaultMachineId()` has 23 call sites. They fall into three groups:

1. **The host for new work** (9): `workspace.context` (`defaultServerId`,
   `fallbackServerId`), automation drafting, seeding, and the builder's first
   choice, onboarding, the first host in Settings, `runtime-boot`.
2. **A fallback after a narrower owner** (6): `ProjectFavicon`, the project
   picker, desktop and web attachments, insights. Each one reads the tab's or
   the run's host first.
3. **A single copy of a host fact** (8): `connectionsStore.capabilities` and the
   two connect-time refreshes that fill it, `staticInfo` and
   `refreshAgentAvailability`, and the voice copy.

Group 3 is the bug. Groups 1 and 2 are correct, but nothing in their names says
which question they answer.

## 3. Target model

### 3.1 Vocabulary

- **host** — the machine and Solus server a client connects to (CLAUDE.md).
- **`Host`** — the client's reactive object for one host. It owns that host's
  facts.
- **host fact** — data that describes the host itself and has no narrower
  owner: what it can do, who it is, how it is reached, its agent logins and
  quota, its tools, its settings.
- **device host** — the host on the machine the user holds. On desktop it is the
  local server. A web or mobile client has none.
- **Run on host** — the host that the Run on picker selects when nothing
  narrower names one. It is the last host the user picked in a Run on picker.
  This is the meaning `defaultMachineId()` had in group 1.

Do not use "default machine", "default host", or "primary" for a host fact.
"Primary" stays only for the record home (the earlier plan, §5.4 "Records").

### 3.2 Two layers: `HostFacts` in client-core, `Host` in workspace-ui

Mobile does not use the Svelte stores, and it must show the same host state
(CLAUDE.md, "Multi-surface"). So fact loading lives in client-core, and each
client adds only its own reactivity.

**`HostFacts` (client-core, `host-facts.ts`)** — plain TypeScript, one per host.
It loads, caches, and reloads that host's facts, and notifies listeners.

```ts
type HostFact<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error'; message: string }

class HostFacts {
  readonly serverId: string
  get(key): HostFact<...>        // capabilities, serverInfo, machine, usage, voiceModel, tools
  value(key): ... | undefined    // the value when ready
  ensure(key): void              // lazy facts load on first ensure
  refresh(key, { maxAgeMs? }): Promise<void>
  when(key): Promise<...>        // the value once ready; capabilities never fail
  set(key, value): void          // a pushed answer or a mutation result
  sessionChanged('fresh' | 'recovered' | 'lost'): void
  subscribe(listener): () => void
  dispose(): void
}
```

It takes the host's `HostApi` and `HostEventSubscriber`, not a
`ServerConnections`, so desktop, web, and mobile build it from their own
connection layer (`ServerConnections` on desktop and web, `HostConnections` on
mobile).

Rules:

- `capabilities` loads when the connection is accepted. `machine`, `usage`,
  `voiceModel`, and `tools` load on the first `ensure`, because each one costs a
  request and many hosts never need them.
- A fact that has not loaded reads as `loading`, never as a guessed value.
- The supervisor reports server-session edges (`onSessionChange`). A fresh
  session reloads every fact a reader asked for; a recovered one loads only
  what is missing; a lost one clears `capabilities` and `serverInfo` (an absent
  record hides actions) and keeps the others' last answers.
- An answer from before a session change never overwrites the new session.
- A failed read never holds the next one back (`maxAgeMs` counts only ready reads).
- Live topics (`usage.limitsChanged`, `voice.modelStatusChanged`) write into the
  facts of the topic's server id only.
- Concurrent loads of one fact join one request.

**`Host` (workspace-ui, `contexts/hosts/host.svelte.ts`)** — a thin reactive
wrapper. It reads its `HostFacts` directly and has one `createSubscriber` per
fact, so a change to one fact invalidates only the readers of that fact. It uses
no compiled runes, so a module that imports it also loads in a plain Bun test.
Reading a lazy fact calls `ensure` outside the reactive read (`queueMicrotask`).

**Mobile** reads `HostFacts` with `facts.when(key)` from its `HostConnection`.
No mobile screen shows a live host fact yet; add a `useSyncExternalStore` hook
over `facts.subscribe` when one does.

The voice store's "assume supported until told otherwise" becomes an explicit
rule for the mic only: show the mic while `capabilities` is `loading`.

### 3.2.1 What stays in feature stores

Stores that hold **editing state** for one host keep it. They already name
their host on every call, guard stale answers, and own the writes:

- `hostSettingsStore` (host config and its writes)
- `connectionsStore`'s Settings state: server info, endpoints, connected
  sessions, pairing, and GitHub provider status

They lose only their capability copy. These are not the bug pattern: none keeps
a single copy that follows another host.

### 3.3 The registry and the three ways to get a host

```ts
hosts.get(serverId): Host            // throws for an unknown id
hosts.find(serverId): Host | null    // null for an id this client does not know
hosts.device: Host | null            // the device host
hosts.runOn: Host | null             // the Run on host
hosts.transcription: Host | null     // hosts.device ?? hosts.runOn
hosts.rolesFor(serverId)             // never opens a connection
```

A tab's host is `hosts.find(run.serverId)`: a restored tab may name a host that
was deleted.

`hosts` (workspace-ui, `contexts/hosts/hosts.svelte.ts`) holds one `Host` per
host id, created on first use. Each `Host` wraps the `HostFacts` that
`ServerConnections` keeps for that connection, and follows a replacement
connection's facts (`bind`). A `Host` for a host that is away stays, with its
session facts at `loading`, so a tab on that host shows a loading state and not
a missing one.

`ServerConnections` (client-core) keeps transport, supervision, the API, and
each connection's `HostFacts` (`factsFor(serverId)`). It keeps `localServerId()`
and the primary (`primaryServerId`, still stored in `solus.activeServerId`; see
decision 3). `defaultMachineId()` becomes `runOnHostId()`: the same choice,
named for the picker it serves. `transcriptionHostId()` is deleted; voice reads
`hosts.device ?? hosts.runOn`.

A reader gets a `Host` from the owner it means:

| Owner | Use | Examples |
|---|---|---|
| The tab | `hosts.find(run.serverId)` | usage in the project panel, a restored tab's project path, a resumed session's home folder, a new chat's folder |
| The device | `hosts.device` | mic and transcription (`hosts.transcription`), screenshots, design mode, open in editor, the resolved terminal |
| The Run on picker | `hosts.runOn` | the agent list, a new session, automation drafting and seeding, onboarding, the first host in Settings, GitHub on the home page |
| An explicit choice | `hosts.get(selectedServerId)` | Settings → General, Voice, Tools, and Skills for the selected host; an automation's own host |

Voice reads `hosts.device ?? hosts.runOn`. A web client has no device host, so
it transcribes on the Run on host.

## 4. What stays out of `Host`

- **Domain records.** Projects, tasks, plans, works, sessions, and automations
  stay in their feature stores, keyed by host. They answer domain questions,
  and putting them on `Host` makes it the default home for everything.
- **Connections.** Transport, supervisor, routes, and the API stay in
  `ServerConnections`.
- **Selections.** Which host the Settings page or an automation builder shows
  is UI state. It holds a server id and calls `hosts.get`.

## 5. What changed

1. **One capability RPC.** The `ServerCapabilities` fields moved into
   `HostCapabilities` (optional, so a missing key still reads as unsupported).
   `serverGetCapabilities` returns them; the server probes them for the
   caller's principal (`probeHostCapabilities`) in parallel with the editor
   probe. `getServerCapabilities`, its handler, its Solus API stub, its plane
   entry, and its demo handler are deleted; the guest allow-list names the
   merged method, and a guest gets no `name` or `editors`. The dead
   `agentTaskLifecyclePolicy` field (no server set it; it is a setting) is gone.
2. **`HostFacts` in client-core.** `host-facts.ts`. `ServerConnections` keeps
   one per connection (`factsFor`), and `capabilitiesFor`, `cachedCapabilitiesFor`,
   and `serverInfoFor` read it. `HostSupervisor` no longer loads capabilities; it
   reports session edges. `defaultMachineId()` is `runOnHostId()`;
   `transcriptionHostId()` is deleted; `onPrimaryChange` tells `hosts.runOn`
   to answer again.
3. **`Host` and `hosts` in workspace-ui.** Deleted: `hostCapabilitiesStore`,
   `hostRolesStore`, `voiceModelStore` (and its context), `usageStore`, and the
   capability copy, `refreshCapabilities`, and `desktopHandlersAvailable` of
   `connectionsStore`. `toolsStore` keeps only the device's resolved terminal.
   The connect-time capability refreshes in the desktop and web shells are gone:
   each `Host` reads its own facts.
4. **`staticInfo`.** Deleted with `initStaticInfo` and
   `hydrateStaticInfoFromCache`. Readers use the `machine` fact of their owner's
   host; the agent list follows the Run on host (`readRunOnAgents`, §9). The
   start cache is one entry per host.
5. **Mobile.** `HostConnection` keeps a `HostFacts`. `host-agents.ts` and
   `use-open-project.ts` read it, and the media, favicon, and prompt paths read
   `facts.when('capabilities')`.
6. **Guard.** The oxlint rule `solus/explicit-host-choice` rejects
   `serverConnections.runOnHostId()`, `localServerId()`, and `localHostApi()` in
   the clients outside `contexts/hosts/` and a frozen list of the Run on and
   device surfaces that existed on 2026-10-08. A new surface gets its host from
   `hosts`. (CLAUDE.md names a `bun run lint:hosts` script; there is none.
   Host rules are oxlint rules in `tools/oxlint/solus/rules/`.)
7. **Docs.** This plan, `workspace-and-machines.md`, and CLAUDE.md's Codebase Map.

## 6. Clients and providers

- **Desktop and web** share workspace-ui, so both get `Host` in this change.
- **Mobile** builds `HostFacts` from its own `HostConnection`. Same facts, same
  loading rules.
- **Providers.** Usage and agent auth are per host and per provider already.
  No provider-specific change.

## 7. Proofs

- `tests/unit/host-facts.test.ts`: loading is never a guess; readers share one
  request; a topic writes only its host; an unreadable capability record is
  empty; voice is unsupported without asking on a host that cannot transcribe;
  a drop clears capabilities and keeps machine facts; a fresh session reloads;
  a stale answer never overwrites a new session; `maxAgeMs`; a waiting reader
  retries once.
- `tests/unit/host-supervisor.test.ts`: each session edge is reported.
- `tests/unit/host-voice.test.ts`: the desktop transcribes for its mic when the
  Run on host cannot (the 2026-10-08 regression); a host without the capability
  hides the mic; a downloading model keeps it.
- `tests/unit/host-roles.test.ts`: asking for roles never opens a connection; an
  unknown host serves nothing; a host's own answer wins.
- `tests/unit/usage-refresh-throttle.test.ts`: one usage read per host per
  minute, a failed read does not hold the next back, and one host's quota never
  replaces another's.
- `tests/unit/default-machine.test.ts`: the Run on host is never the Solus API;
  the agent list reads nothing with no machine and reads once when one is there;
  the transcription host is the device, else the Run on host.
- `tools/oxlint/solus/rules/explicit-host-choice.test.ts`.

## 8. Decisions

Decided 2026-10-08:

1. **One capability RPC.** `HostCapabilities` and `ServerCapabilities` merge
   into one record from `serverGetCapabilities`. `getServerCapabilities` is
   deleted.
2. **Fact loading in client-core.** `HostFacts` is plain TypeScript in
   client-core, so mobile reuses it. `Host` in workspace-ui is a thin reactive
   wrapper.
3. **Run on storage unchanged.** The Run on choice stays in
   `solus.activeServerId`. `defaultMachineId()` becomes `runOnHostId()` and
   `chooseDefaultMachine` becomes `chooseRunOnHost`. Amended during
   implementation: `primaryServerId` keeps its name. The same field is the
   record home (`defaultServerId()`, the Solus API at the account origin) and the
   Run on choice when it names a machine, so `runOnServerId` would misname the
   record-home use.
4. **Editing state stays in feature stores** (§3.2.1). `hostSettingsStore` and
   `connectionsStore`'s Settings state already name their host and own writes.
   Moving them gives no correctness gain.

## 9. Known limits

- **The agent list is the Run on host's.** `AgentContext.agents` (models and
  availability for the pickers) is one list, read from the Run on host's
  `machine` fact. That is the existing decision pending WP6 host framing
  (`docs/plans/multi-host-parity.md`). Making it per tab is that plan's work.
- **Editing state stays where it is** (decision 4).
