# Solus-owned server installation

Status: Implemented directly in main; Linux VM verification and focused tests recorded in .solus-local/owned-server-qa. Native macOS service execution not exercised.
Planned at: f4227582 plus the current uncommitted server update implementation.

## Authorization and outcome

The user approved replacing server Homebrew installation/service/update ownership. Backward compatibility is not required. Implement, test on the freely available VM 10.10.1.22, prove the behavior, then update README and docs. Do not create a PR. Preserve unrelated working-tree edits and existing live data. Desktop Homebrew cask remains supported.

## Architecture

One user-owned installation with bundled Node, stable launcher, immutable versions and atomic active-version state. Default command in ~/.local/bin/solus; runtime under ~/.local/share/solus; user data stays ~/.solus. Explicit isolated install/data configuration must work for tests. Never use test state in live data directories.

The same authenticated host-owned update operation must serve CLI and desktop/web/mobile actions. Download and verify while existing work continues, then drain accepted work, stop, consistently back up required persisted state, start candidate with work admission blocked, commit after readiness/migrations, or restore previous version and persisted state. Persist recovery state before mutations and recover after interruption. No filesystem rollback while a child still owns data. Exact versions, archive integrity, protocol compatibility, one supervisor lease, candidate timeout, and installed/running version reporting are required. The stable launcher and its bundled Node need an explicit safe update ownership model too; do not leave a permanent hidden dependency on the original version directory.

Commands: solus setup; solus start (foreground); solus status; solus logs; solus update; solus service start/stop/restart/uninstall. Setup installs/starts per-user launchd or systemd service, verifies health and offers pairing/cloud connection, with explicit unattended flags. Linux checks/enables lingering when authorized and reports actionable privilege failures. macOS documents login and sleep limits. Uninstall preserves user data. Status reports health, running/installed versions, startup behavior, connection/provider readiness and repair advice where available.

A portable installer downloads the existing per-platform bundle including Node. No server Homebrew/npm/system Node prerequisite. Wire installer into packaging/release/site delivery; do not claim an unpublished URL is live. Remove obsolete server formula, Brew update adapter, and release tap publishing for server only. Preserve desktop cask workflow.

Provider Update must use the installer owning the executable already in use; unknown ownership must offer truthful manual remediation rather than create a competing installation. SSH host installation should reuse the canonical installer where installation is offered; align pairing copy with actual behavior and preserve client-local capability boundaries.

## Scope and existing source

Read AGENTS.md/map first. Primary scope: apps/cli/src/index.ts and lib/{runtime,server-supervisor,server-release,update-journal,homebrew-update,update,connect}.ts; apps/standalone-server/src/index.ts; packages/server/src/updates and server handlers/bootstrap; packages/contracts/src/{server-update,host-update-types,host-install,rpc,host-api}.ts; shared update stores and connection/server setup UI; scripts/package-server.ts; packaging/homebrew server definition; applicable release workflows/site installer route; README.md; user docs and docs/plans/host-and-provider-updates.md; focused tests under tests/unit. Immediate dependencies can be changed only as needed for this feature; explain additions. Do not modify unrelated conversation, composer, usage, rate limit or desktop packaging work.

The current supervisor keeps its PID while replacing its child, with receipts/lease and admission drains in RemoteUpdateService/ControlPlane. It currently swaps tarball directories or upgrades Brew kegs and rejects a storage hash change. Reuse necessary drain/admission behavior, replace obsolete installation ownership. Current CLI's update path is separate and must be consolidated. Existing update store has reconnect/stale guards and shared UI actions; retain them. Existing docs refer to removed claim/status commands and old formula names; correct after verification.

## Execution

1. Create an isolated worktree. Capture the current dirty main tree as a baseline in that worktree (including relevant untracked update modules); never stash, reset, discard, or accidentally commit unrelated edits. Record baseline versus implementation changes separately. Inspect current source rather than assuming prior excerpts are unchanged.
2. Implement owned runtime/installer and native service lifecycle, with focused filesystem and OS-command tests. Match existing TypeScript/Svelte style and exact typed contracts; no broad unknown records or unnecessary forwarding wrappers.
3. Implement shared transactional update/recovery and CLI access. Tests must cover concurrent requests, active-work drain, cancellation, integrity/preflight failure, success/reconnect, failed candidate and interrupted recovery, state preservation, and startup offline.
4. Integrate provider ownership and truthful setup/status on shared surfaces. Exercise relevant desktop/web/mobile and Editor/Pill states if UI changes. No need to change native window behavior.
5. Build and run actual packaged Linux bundle on VM. Use a disposable test account or isolated service/install/data names, never the live ~/.solus. Verify setup, status, restart, stop/start, uninstall preserving data, foreground, pairing/auth RPC, update success, rollback and recovery with actual server processes. Use locally built versioned release fixtures where an unpublished release is required; label them as fixtures. Verify real checksum failure and data preservation, not just mocked callbacks. Capture evidence. Clean only owned services/processes/files.
6. Fix failures, run focused tests, CLI targeted typecheck/lint and bun run build. Preserve exact commands/results. Platform-service unit tests do not substitute for Linux VM execution; state native macOS checks separately.
7. Update README, public docs and architecture plan to final tested behavior. Return implementation diff, worktree/branch, command outcomes, evidence location, limitations and cleanup record. No PR or deployment required.

## Done criteria

All approved commands work against owned install. CLI and remote Update share lifecycle and report real outcome. A failed trial restores previous executable and required persisted state. Service uninstall leaves data intact. Build and focused tests pass. VM proof exists for fresh install, lifecycle, upgrade and failure recovery. Docs match shipped files and commands. Surface limitations and any unavailable publication endpoint are explicit.

## Review and maintenance

Reviewer independently reads diff/tests and reruns core verification before reporting completion. Keep task 01M1ZN60ZVY29T3RWTZKTH5Z3A in progress. Source integration must preserve concurrent main-tree changes; return or apply only the implementation delta after checking for drift. User authorized implementation, so do not ask again for routine integration. Never merge/push a PR. Report a real blocker if VM privilege/network or platform constraints prevent proof; do all independent work first. Changes to persisted formats and launcher protocol must preserve the trial/commit recovery contract.
