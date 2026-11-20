# Host and agent updates

## Ownership

The host owns update checks, downloads, installation selection, and update state. All clients read `hostUpdateStatus` and follow `host.updateStatusChanged`. Desktop and web share the provider controls. Native mobile shows the same facts and commands in the host settings.

`UpdateStatusService` schedules checks at startup and every four hours. It holds one `AgentSoftware` module for Claude and one for Codex. Each module owns its status, automatic-update rule, pending check and install, locks, download verification, and package selection. The host status is a projection of those two modules; it does not hold a second copy of their update state.

Each module receives one agent adapter at construction: `new AgentSoftware(new CodexSoftwareAdapter(), options)` or `new AgentSoftware(new ClaudeSoftwareAdapter(), options)`. The adapter owns release metadata, package layout, source configuration, external install detection, and compatibility checks. Claude checks CPU support. Codex checks app-server initialization. The shared workflow checks the executable version in an isolated home before it calls the adapter's protocol check. `AgentSoftware` has no branches for individual agents.

Callers select the agent once:

```ts
hostUpdates.agents.codex.status
await hostUpdates.agents.codex.check()
await hostUpdates.agents.codex.install()
await hostUpdates.agents.codex.install('native')
await hostUpdates.agents.codex.install('existing')
```

Setup only validates the RPC request and dispatches to that module. Boot supplies host settings and policy once. It does not select release sources, compute install ownership, connect installer callbacks, or refresh state after an install. The separate ownership, native-release, and native-installer modules were removed.

Command discovery uses the smaller `AgentExecutable` module in `cli-env.ts` to read the selected executable without loading the update machinery. Its agent identity is also bound once. Both modules read the same `current.json` format; there is no second installation registry.

Each agent has one update in progress. An on-disk lock also excludes a second server process that uses the same install directory. The server update waits for agent updates before it restarts.

Hosts provisioned by Solus Cloud keep their image update policy. Clients cannot change their agent software. An organization policy with `updates.mode: off` also stops checks and installation on other hosts.

## Installations

New agent installations use native vendor releases. They do not need Node or npm. The host needs curl; Codex also needs tar. macOS, Linux, and Windows targets are selected on the host. Linux Codex uses the musl package. Claude uses the matching glibc or musl binary where the vendor publishes it.

Solus keeps packages under `SOLUS_DATA_DIR/agents/<agent>/releases/`, or `~/.solus/agents/<agent>/releases/` when no data directory is set. `current.json` selects the executable. This is an installation for Solus, not a change to the user's shell PATH.

An existing npm, Homebrew, WinGet, native vendor, or custom installation stays under its existing manager. Update checks follow that installation. npm checks use npm's registry, authentication, and proxy settings. A failed npm check never silently switches to the public registry. A native installation never needs npm for a version check.

The host settings show the active executable path, install method, automatic update setting, check time, available version, and update operation. An external installation shows its update command. **Use native installation** downloads and checks a native package, then selects it for Solus. It does not remove the old installation. **Use existing installation** returns to the executable on the host's PATH. Active agent processes keep their current executable in both cases.

The `setupInstallAgentCli` RPC accepts an optional `installation: native | existing` selection. With no selection, it installs an absent agent or updates the native installation that Solus already owns. It refuses to overwrite an external installation. The existing RPC registry and both transports carry this typed argument; no client-local install command is used.

## Automatic updates

The host setting `agentAutoUpdates` defaults to true. It applies only to selected native packages managed by Solus. It does not migrate or change existing external installations. Every client can turn it off and on, subject to host administration and update policy.

When a check finds a new release, an enabled host downloads and checks it. A failed automatic attempt waits for the next four-hour cadence. A manual retry remains available. Each agent has its own lock, so Claude and Codex can update independently.

Existing processes continue with their current package. New processes use the new selection. In particular, a long-lived Codex app-server can keep using the previous release until that process ends. The completion message states this. No update stops an active turn or forces an app-server restart.

## Download and activation

1. Read the version and checksum metadata from the selected source.
2. Download into a temporary directory beside the managed releases.
3. Verify SHA-256 before extraction or execution.
4. For Codex, inspect archive paths and entries, then extract the whole package. Keep its companion executables and resources. Refuse path traversal, links, and special files.
5. Run `--version` in an empty temporary provider home. For Codex, also start a separate app-server and complete the same initialization request Solus uses. Refuse versions older than Solus's minimum protocol version. This check makes no paid turn and uses no saved login.
6. Move the complete package to a new immutable release directory. Atomically replace `current.json` only after verification succeeds.

A failure before selection leaves the previous package selected. Temporary files are removed. Old successful releases stay on disk because active processes can still need their companion files. This change does not prune those releases while agents may be running.

The host broadcasts downloading, verifying, succeeded, and failed states. Clients do not infer an install from an available release. An update-check error means the latest version is unknown; it does not mean the installed agent cannot run. Reconnects load the host's current state and ignore older responses.

## Restricted networks and approved mirrors

Native downloads use curl with HTTPS, certificate verification, connection and total time limits, bounded retries, and response size limits. curl receives the host's proxy and `NO_PROXY` settings. It uses `CURL_CA_BUNDLE`; when that is unset, Solus passes `NODE_EXTRA_CA_CERTS` as the CA bundle. Raw downloader output is not sent to clients because it can contain proxy credentials.

An administrator can set these environment variables on the host process:

- `SOLUS_CODEX_RELEASE_BASE_URL`: defaults to `https://releases.openai.com/codex`.
- `SOLUS_CLAUDE_RELEASE_BASE_URL`: defaults to `https://downloads.claude.ai/claude-code-releases`.

A base URL must use HTTPS and contain no credentials, query, or fragment. Restart the host after a source change. Clients report **Approved mirror** for a custom source. No client can supply a download URL in an install request. A mirror failure never falls back to a public source.

The Codex mirror preserves `/channels/latest` with `tag_name` and the vendor `assets` entries, including SHA-256 digests. Packages are read from `/releases/<version>/codex-package-<target>.tar.gz`. The Claude mirror preserves `/latest`, `/<version>/manifest.json` with `platforms.<target>.checksum`, and `/<version>/<target>/claude` (or `claude.exe`). Mirror the original vendor artifacts without modifying them.

## Verification

Focused tests cover source selection, platform targets, checksum requirements, native command discovery, ownership, concurrent installation, preservation of the previous selection, policy and automatic update controls, and client status text.

`bun tests/unit/helpers/provider-update-smoke.ts` uses temporary packages and fake executables to check real archive extraction and app-server initialization. It never runs an installed agent or makes a paid turn. This separate fixture script also avoids this host's Bun test-runner issue with child-process output.

The update setting applies to the host's default agent installations. Explicit provider runtime paths and member-owned operating-system installations keep their own ownership. Turning automatic updates off stops future automatic attempts; it does not cancel a download already in progress.

Review note: the existing `boot-server.ts`, `setup-handlers.ts`, and `claude-agent.ts` exceed the file-size guidance. This change keeps their edits to composition, setup dispatch, and executable selection. The new update modules stay small.

### Checks for this change

- Focused tests exercise `AgentSoftware.check()` and `AgentSoftware.install()` for source selection, ownership, retries, concurrency, compatibility, and stale responses. Host tests verify scheduling and projection of agent state.
- Mobile and shared-contract TypeScript checks pass.
- The five changed Svelte components compile and analyze without warnings. Focused lint passes for the update modules, command discovery, client status helpers, and state stores.
- The isolated fixture script passes version checks, Codex initialization, complete package extraction, and unsafe-link rejection. A separate Node ESM check confirms command discovery still loads outside a bundle.
- The macOS ARM64 Codex 0.170.0 archive was inspected without installation. Its complete package layout matches the installer.
- Broader checks have unrelated failures in the current tree: Bun child-process tests return empty output; the host-policy test expects a boolean where the current API returns `off`; three existing host-to-transport imports fail the module-boundary test; server and workspace TypeScript checks report errors outside the update implementation.
- No interactive client test or real agent turn was run. Windows and Linux release selection have fixture coverage; their native executables were not run on this Mac.

### Primitive refactor verification

Fourteen focused unit-test files pass after the adapter split. Tests cover each agent's package-manager paths and update commands, including rejection of the other agent's package path. The update modules, command-selection module, and changed tests pass focused lint. The fixture script checks complete installation, health failures, and archive safety through `AgentSoftware.install()`. The server typecheck reports existing errors outside the update modules; it reports no errors in the update modules. Standalone Node ESM command discovery passed during the earlier command-selection change. This adapter change applies to both agents on the host, for local and remote clients. The RPC contract and desktop, web, and mobile controls are unchanged.
