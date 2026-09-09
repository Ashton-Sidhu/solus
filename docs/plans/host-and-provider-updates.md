# Host and provider updates

How Solus tells the user that a connected host runs an old Solus release, or
that a coding provider on a host has a newer release, and how the user acts on
that. This extends `docs/plans/desktop-updates.md`, which owns the desktop app's
own update. Read that plan first; this one reuses its words and adds only what
hosts and providers need.

## Problem

A user runs Solus on several hosts: the desktop app hosts one, a headless server
runs on a workstation or a cloud machine, and the web or mobile client connects
to all of them. Today nothing tells the user that a host is behind. The host
reports its version in `HostCapabilities.version`, and the client compares it to
its own version in `versionSkewNotice`, but no surface renders that notice, and
neither side knows the latest release. The only code that knows the latest
release is `solus update` in the CLI, and it runs only when the user types it.

Providers are worse. `HostReadiness.agents` says only `installed` and `signedIn`.
No code reads `claude --version` or `codex --version`, and no code asks a
registry for the latest version. A user finds out that Claude Code is stale when
the provider itself prints a notice in a transcript.

## Vocabulary

- **host update** — a Solus release newer than the Solus that runs on a host.
- **provider update** — a release of Claude Code or Codex newer than the one
  installed on a host.
- **update check** — asking the release source for the latest version of one
  thing. A host runs its own checks; clients never talk to a release source.
- **check state** — where one check is. One of **idle**, **checking**,
  **up-to-date**, **available**, **error**. These are the desktop update
  states without **downloading** and **ready**, so the same words mean the same
  thing on both surfaces.
- **host update status** — the host's Solus version, how Solus was installed
  there, its check state, and one provider update status per provider. This is
  the whole object a host owns and every client mirrors.
- **install kind** — how Solus got onto the host: **desktop** (the app hosts
  it), **homebrew**, **tarball** (the CLI installer), **source** (a checkout),
  or **unknown**. The install kind decides the remediation.
- **remediation** — the one action that brings a thing up to date, in the
  user's words.
- **update provider** — reinstall a provider to its latest release. It is the
  same command as install; the row calls it *Update*.

The desktop app's own update keeps its words: **release**, **update**,
**update state**, **restart to update**. A desktop-hosted host never has a host
update of its own; its remediation is the desktop update.

## Ownership

The host owns its update status. It runs every check, spawns the provider
binaries, calls the release sources, and broadcasts each change on one typed
topic. This is the only correct owner: a mobile client cannot spawn `claude`,
and a client that asks GitHub for every saved host would multiply outbound
traffic by client count.

Clients mirror the status in one store, `hostUpdatesStore`, keyed by server id.
The store loads on connect, subscribes to the topic, and drops the entry when the
host is forgotten. Surfaces read the store and call its commands; the store
carries no UI of its own.

The desktop app's `updatesStore` stays as it is. On desktop, the local host's
install kind is **desktop**, so its host row points at `updatesStore` for the
state and the commands. Nothing is duplicated; the local host's provider rows are
ordinary provider rows.

`solus update` in the CLI keeps its own fetch and swap logic. The version
comparison and the install-kind detection move to a shared module so the CLI,
the server, and `versionSkewNotice` use one comparator. Today there are two.

## Reuse from desktop updates

The desktop update work in the working tree already solves the shape of this
feature once. This plan copies its patterns instead of inventing second ones.

| Desktop piece | What it gives this feature |
|---|---|
| `DesktopUpdateState` in `desktop-update-types.ts` | The state names, `checkedAt` on **up-to-date**, and **error** that keeps its release. `UpdateCheckState` is the same union with two members removed and `latestVersion` in place of `release`. |
| `reduceUpdateState` in `main/updates/update-status.ts` | A pure reducer with an event union, testable without Electron. The host service uses a `reduceCheckState` of the same shape, testable without a network. |
| `registerUpdateIpc` in `main/updates/ipc.ts` | The `publish` and `apply` closures: reduce, skip when unchanged, log `update_state_changed`, broadcast. The host service keeps this structure with the typed topic in place of the IPC channel. Its `FIRST_CHECK_DELAY_MS` and four-hour interval become the host cadence too, so there is one number. |
| `UpdatesStore` in `contexts/updates/updates.store.svelte.ts` | The store owes each prompt once per version and holds the version, not a flag, so a re-broadcast never re-arms it. `pendingPrompt` and `markPromptShown` decide *what* is owed; the shell decides *when*. `manualCheckOutcome` and `markManualCheckReported` make only a user-started check earn a result toast. `hostUpdatesStore` keeps all four, keyed by server id. |
| `installDesktopUpdates` in `renderer/shell/desktop-updates.svelte.ts` | The toast rule: Editor mode only, hold a prompt while the affected host is busy, one fixed toast id, and `untrack` around the show. The host notices use the same function shape but live in `workspace-ui`, because web and mobile need them. |
| `update-status-text.ts` in `components/settings/lib/` | `updateStatusLine` and `formatCheckedAt` render one state as one sentence. `formatCheckedAt` becomes exported and shared; the host and provider rows get sibling functions with the same signature style, including a `command`-and-`label` answer like `updateCommandFor`. |
| `SettingsAboutSection.svelte` | The `SettingsRow` with a `control` snippet for the one command and a `body` snippet for the status line. The host version row in Host detail uses the same composition. On desktop, the provider summary line lands in this section. |
| `global.check-for-updates` in the keybinding manifest | The command already exists. Its "desktop only" comment goes; the command checks the desktop and every connected host, and is visible when either can be checked. |
| `tests/unit/desktop-updates-store.test.ts` | The `$state` stub and fake-API constructor pattern for testing a store without Svelte. The host store test copies it. |

Nothing in the desktop feature changes except the manifest comment and the
`formatCheckedAt` export.

## Check states

```text
idle ──check──▶ checking ──same──▶ up-to-date
                        │
                        ├──newer──▶ available
                        │
                        └──failed──▶ error (keeps the last latestVersion)
```

- A check moves any state to **checking**. **up-to-date** and **available**
  record when. **error** carries a message and keeps the last known latest
  version, so a row can still say what it knew.
- **idle** is the state before the first check, and the permanent state when a
  check is not possible: a **source** install, a provider that is not installed,
  or a host that runs without network access to the release source. The row
  says why.
- There is no download and no **ready** state. A host or a provider is updated
  in place by a command the user runs; the next check confirms it.

## Cadence and cost

The host runs its first checks ten seconds after boot and every four hours
after that, the desktop updater's numbers, with an `unref` timer in the shape
of `startAutomationScheduler`.
A manual check from any client runs at once, but not more than once a minute
per host; a second request inside that window returns the current status.

Provider version reads spawn `claude --version` and `codex --version` with a
five-second timeout and `getCliEnv()`. They run on the update cadence only.
They never run inside `probeHostReadiness`, which promises not to hang the
readiness rail and to touch no network. The readiness probe stays as it is.

Release sources:

- Solus: `https://api.github.com/repos/<repo>/releases/latest`, the same call
  the CLI makes, with the same `SOLUS_RELEASE_REPO` override.
- Claude Code: the `latest` dist-tag of `@anthropic-ai/claude-code` on the npm
  registry. The native installer ships the same version numbers. If that stops
  being true, the row reports a false update; this is the assumption to revisit
  first.
- Codex: the `latest` dist-tag of `@openai/codex` on the npm registry. This is
  the package the installer already uses.

Each call has a ten-second timeout and one `user-agent` of `solus-server/<v>`.
A failed call moves only that check to **error**; the others proceed. Nothing
is retried inside a cadence tick.

The status lives in memory. A restarted host shows **idle** for ten seconds,
then real states. Persisting it would add a file for a value that a
check recomputes in one second.

## Install kind and remediation

The host detects its install kind once at boot:

- **desktop** when `platformServices().appInfo` is present.
- **homebrew** when the install directory is under a Homebrew Cellar, by the
  existing `isBrewManaged` rule.
- **tarball** when the install directory has the CLI installer's marker, by the
  existing `isTarballInstall` rule.
- **source** when the process runs from a repository checkout.
- **unknown** otherwise.

Remediation is a string the host builds so every client says the same thing:

| Install kind | Row text when available |
|---|---|
| desktop, this client | Reads `updatesStore` directly: *Download*, *Restart to update*, and so on |
| desktop, other client | "Update the Solus app on *host*." |
| homebrew | "Run `brew upgrade solus-server` on *host*, then restart it." |
| tarball | "Run `solus update` on *host*, then restart it." |
| source | Never available. Row says "Development build". |
| unknown | "Install Solus *latest* on *host*." with the release page link |

Solus does not update a remote host from a client in this version. The CLI
swap replaces the directory under the running process, and restarting the
server drops every live session on it. That deserves its own plan with a drain
step; it is out of scope here.

Provider remediation is one action. *Update* runs `setupInstallAgentCli` with
the same command as install, because both installers install the latest
release. The row shows the existing setup stream through the existing
`install-claude` and `install-codex` steps; the label says *Updating…* while the
step is busy. No new step id is added.

## Contract

`packages/contracts/src/host-update-types.ts` declares:

```ts
export type HostInstallKind = 'desktop' | 'homebrew' | 'tarball' | 'source' | 'unknown'

export type UpdateCheckState =
  | { kind: 'idle'; reason: string | null }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; latestVersion: string; checkedAt: number }
  | { kind: 'error'; message: string; latestVersion: string | null; checkedAt: number }

export interface ProviderUpdateStatus {
  agent: SetupAgent
  installedVersion: string | null
  check: UpdateCheckState
}

export interface HostUpdateStatus {
  currentVersion: string
  install: HostInstallKind
  /** Null for desktop and source installs; the row derives its own words. */
  remediation: string | null
  releaseUrl: string | null
  check: UpdateCheckState
  providers: ProviderUpdateStatus[]
}
```

RPC methods in `packages/contracts/src/rpc.ts` and `host-api.ts`:

- `hostUpdateStatus(): Promise<HostUpdateStatus>` — the current status.
- `hostCheckForUpdates(): Promise<HostUpdateStatus>` — run every check now,
  subject to the one-minute limit.

Event topic `host.updateStatusChanged` carries the full `HostUpdateStatus`. The
object is small, so a full broadcast is simpler than a diff.

`HostCapabilities` gains `hostUpdates?: boolean`. An older host omits it, and
`FEATURE_WORDING` in `version-skew.ts` names it `'update checks'`, so the skew
notice can say what the old host cannot do. A client must treat a missing
capability as unknown, never as up to date and never as out of date.

`/health` does not change. It withholds `name` and `os` before authentication
over the tunnel by design, and a version would leak the same way. A saved host
that is not connected shows no update status.

`setupInstallAgentCli` does not change. The install handler already runs the
latest release, and the update-status service reruns the provider version read
when the install step finishes so the row settles without a cadence tick.

## Server

`packages/server/src/updates/` is a focused domain, like `automations/`:

- `install-kind.ts` — detection at boot.
- `release-sources.ts` — the three fetches, each returning a version or throwing.
- `provider-versions.ts` — spawn and parse. The parser takes the first
  `major.minor.patch` token in the output, so `1.0.98 (Claude Code)` and
  `codex-cli 0.42.0` both work.
- `check-state.ts` — `reduceCheckState(state, event)`, pure, in the shape of
  the desktop reducer.
- `update-status-service.ts` — owns the `HostUpdateStatus`, the cadence, the
  manual-check limit, and the broadcast, with the desktop IPC module's
  `publish` and `apply` structure.
- `handlers/update-handlers.ts` — registers the two RPC methods.

The version comparator and install-kind rules move from `apps/cli/src/lib/update.ts`
to `packages/contracts/src/version.ts`, which the CLI, the server, and
`version-skew.ts` import. This deletes the second comparator in
`version-skew.ts`.

Logs use the existing contract: `host_update_check` with `{ target, state,
latestVersion }`, and `host_update_check_failed` with `{ target, error }`.

## Client

`packages/workspace-ui/src/contexts/updates/host-updates.store.svelte.ts`,
beside `updates.store.svelte.ts`:

- `SvelteMap<string, HostUpdateStatus>` keyed by server id.
- Loads on `onConnectionCreated` and on `status === 'connected'`, like
  `hostCapabilitiesStore`, and only when the host advertises `hostUpdates`.
- Subscribes to `host.updateStatusChanged` through `subscribeAllHosts`.
- `check(serverId)` and `checkAll()` commands. `checkAll` is what the palette
  command calls, after `updatesStore.check()` when that is available.
- Derived answers: `hostUpdateFor(serverId)`, `providerUpdatesFor(serverId)`,
  `anyUpdateAvailable`, and `pendingCountFor(serverId)`.
- Owed notices, in the desktop store's pattern: `pendingNoticeFor(serverId)`
  returns the host or provider notice not yet shown for its latest version,
  and `markNoticeShown(serverId, notice)` records that version. A status
  re-broadcast for the same version never re-arms it; a newer latest version
  does. *Later* on a toast is the same as the desktop *Later*: it dismisses
  for this run.
- `manualCheckOutcomeFor(serverId)` and `markManualCheckReported(serverId)`,
  so only a check the user started earns an "up to date" or error toast.

A dismissed toast hides the toast only. Rows, badges, and dots always show
the true state; a notice the user cannot find again is a lying UI.

The toasts live in
`packages/workspace-ui/src/contexts/updates/host-update-notices.svelte.ts`, a
function in the shape of `installDesktopUpdates` that the desktop shell and the
web client bootstrap both call. It holds a prompt while any session on that
host is busy, uses one toast id per host, and shows in Editor mode only.

Row copy lives in `components/connections/lib/host-update-rows.ts`, beside the
onboarding row builders, and follows `update-status-text.ts`: one function
that turns a state into a sentence, one that answers with the command and its
label. `formatCheckedAt` moves out of `update-status-text.ts` to be shared.

## Surfaces

Every surface reads the same store, so Editor mode and Pill mode agree, and
desktop, web, and mobile expose the same state.

- **Connections list.** A host row shows a small accent dot when its host update
  or any provider update is **available**. The dot uses the same style as the
  gear dot in the desktop plan. The Connections item in Settings navigation
  shows the same dot when any connected host has one.
- **Host detail → Overview.** The "This host" section gains a *Solus version*
  row: the version, the check state, and the remediation. *Check for updates*
  sits beside the existing *Test* button and runs both. On the local desktop
  host, this row shows the desktop `updatesStore` state and its commands, and
  the row says "Updates with the Solus app."
- **Host detail → Providers.** Each provider row's detail gains the installed
  version and the check state while keeping the sign-in status visible:
  "Installed and signed in · 1.0.98 · Up to date" or
  "Installed · not signed in · 1.0.98 · 1.0.101 available". *Update* becomes the row's
  `secondary` action when **available**; it is disabled while the row is busy.
  After an update, a signed-in provider offers *Switch account* as an optional
  action. It does not require another sign-in. A signed-out provider keeps *Sign in*.
  The two `comingSoon` rows do not change.
- **Settings → General → About Solus.** On desktop, `SettingsAboutSection`
  gains one row under the app status that summarizes the local host's
  providers: "Claude Code and Codex are up to date" or "1 provider update on
  this computer", which opens the local host's Providers page. Web and mobile
  show only the version row, as the desktop plan says.
- **Toasts.** One toast per host per latest version: "Solus *v* is available for
  *host*" with a close button, and "Claude Code *v* is available on *host*"
  with *Update* and *Later*. No update toast opens Settings. Progress names the
  provider: "Updating Claude Code…" or "Updating Codex…".
  Toasts use a fixed id per host so they never stack.
  They show in Editor mode only, and only when no session on that host is busy,
  by the same rule the restart prompt uses. Pill mode shows no toast.
- **Command palette.** The existing `global.check-for-updates` command also
  checks every connected host. On web and mobile, where the desktop check is
  not available, the command checks hosts only. One command, one name.
  `global.restart-to-update` stays desktop only.
- **Web and mobile host picker.** The meta line in `ServerSetupSurface`'s host
  row gains " · update available" after the status label when a host update is
  **available**. This is the one per-host fact that fits there.

Reverse states: a check that returns **up-to-date** removes the dot, the row
action, and the toast. **error** shows the message in the row and never shows a
toast. A reconnect reloads the status; a stale entry from the previous
connection is cleared on `reconnecting`, like capabilities.

## Providers

- **Claude Code** — version from `claude --version`, latest from npm, update by
  the install script.
- **Codex** — version from `codex --version`, latest from npm, update by
  `npm install -g @openai/codex`. When `npm` is absent the install builder already
  throws; the row shows that message and no *Update* action.

Both are decided; nothing is provider-generic by accident.

## Connection modes

- **Desktop, local host.** Host update reads `updatesStore`. Provider updates
  are real rows on the local host, which is what "the provider check for
  desktop" means.
- **Desktop, remote hosts** and **web or mobile, any host.** Host and provider
  rows read `hostUpdatesStore`. Remediation is text, not an action, for the host
  update.
- **Tunnel and uplink.** The status travels over the authenticated RPC only.
  Nothing new is exposed before authentication.
- **Offline saved host.** No status; no dot; the picker meta line shows only the
  connection state.

## Tests

- `tests/unit/version-compare.test.ts` — the shared comparator, including
  `v`-prefixed tags and unequal part counts. The old `version-skew` comparison
  cases move here.
- `tests/unit/host-update-check-state.test.ts` — every transition, that
  **error** keeps the last latest version, and that **idle** carries its
  reason for source installs and missing providers. Same shape as
  `desktop-update-status.test.ts`.
- `tests/unit/provider-versions.test.ts` — the parser on real `claude` and
  `codex` output, on empty output, and on a timeout.
- `tests/unit/update-status-service.test.ts` — the cadence with a fake clock,
  the one-minute manual limit, one failed source not blocking the others, and
  the rerun after an install step completes. Deterministic; no sleeps.
- `tests/unit/host-updates-store.test.ts` — load on connect, clear on
  reconnecting, topic application, a notice owed once per latest version, a
  re-broadcast that does not re-arm it, a newer version that does, and a
  result toast only for a manual check. Uses the `$state` stub and fake-API
  pattern from `desktop-updates-store.test.ts`.
- `tests/unit/host-update-rows.test.ts` — row copy for every install kind and
  every check state, and that a missing `hostUpdates` capability renders as
  unknown.

## Out of scope

- Updating a remote host from a client. Needs a drain plan.
- Automatic provider updates without a click.
- Provider updates for providers Solus did not install, such as a Codex from a
  distribution package. The check still reports; the *Update* action reruns the
  Solus installer, which is what the user asked for by clicking it.
- A version on `/health`.
- Any change to the desktop update state machine, its IPC, or its toasts.

## Implementation notes (2026-09-08)

Implemented in the shared server and workspace UI. The current desktop client
uses the same host WebSocket RPC path as web and mobile. These host methods do
not need native preload methods. The desktop app updater remains native.

The comparator is in `packages/contracts/src/version.ts`. Installation rules
are in the separate Node-only `packages/contracts/src/host-install.ts`, so
clients can import the comparator without importing filesystem code. The CLI
and host detection both use these rules. Update cadence constants are shared
in `packages/contracts/src/update-cadence.ts`.

The shared app core installs host notices for all clients. Overlay (Pill)
windows suppress them. Host and provider rows, Settings navigation, the host
directory, the web/mobile picker, and command palettes read the same store.
Provider updates retain the existing setup event subscription and show its
output in the Providers page. The host detail tab is held in `connectionsNav`
so About can open Providers directly. The provider toast's Update action keeps
the current page open. Provider updates started from any surface show a progress
toast, followed by success or the installer error.

The npm latest-tag assumption in this plan remains in use. Remote host
self-update and automatic provider installation remain out of scope.

Validation: focused tests cover version comparison, check transitions, source
and provider failures, manual rate limiting, cadence and timer disposal,
post-install refresh, reconnect and late-response rejection, notice deduplication,
and row actions. The desktop/web build passes. Existing package type errors and
Svelte configuration/type errors elsewhere in the working tree prevent a clean
whole-project type check. No live provider install or remote upgrade was run.


### VM verification

Tested on `10.10.1.22` using a temporary server installation and data directory.
The existing `/opt/solus` installation and user data were not changed.

- The real GitHub feed reported Solus 0.30.0 as current. npm reported updates
  for Claude Code 1.0.98 and Codex 0.42.0.
- Authenticated RPC, status events, the manual-check limit, and the version-free
  health endpoint passed.
- The actual provider row updated an isolated Codex installation from 0.42.0
  to 0.153.4, showed progress, then removed its Update action. A second client
  received the new state without a reload.
- Offline/reconnect, reload, busy-host notice suppression, and Later dismissal
  passed in a focused browser harness using the production components and stores.
- Phone screenshots exposed clipped provider version text. The provider detail
  now wraps. Light/dark phone checks showed no clipped details or horizontal
  overflow. Focused tests, lint, and the full build pass after this fix.

The full web workspace reported CodeMirror module-identity errors and failed
navigation, so whole-workspace and native desktop verification remain open.
The isolated update components and notices produced no browser errors. The
Claude native installer was not run. Test processes were stopped and the VM's
temporary installation was removed. Local evidence is in
`.solus-local/host-update-vm-test/`.
