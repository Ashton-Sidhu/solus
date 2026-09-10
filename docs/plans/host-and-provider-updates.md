# Server and provider updates

## Current implementation

Solus owns standalone installation, service lifetime, and updates. No backward
compatibility with the former Homebrew server formula is required. Homebrew
remains a desktop cask only. `scripts/install.sh` installs the bundled Node,
server and CLI under `~/.local/share/solus/versions/<version>`. An atomic `current`
symlink selects the active release. `~/.local/bin/solus` is the stable launcher.
The native service always starts the launcher, never a hard-coded version.

`solus setup` writes a per-user systemd unit or macOS LaunchAgent and verifies
health. Custom data/runtime paths and host/port settings are persisted in the
service configuration. Linux setup checks the user manager and lingering;
macOS requires a logged-in, awake user. Service start/stop/restart/uninstall
and status work independently of package managers. Uninstall preserves data.

## Update transaction

The CLI and desktop/web/mobile use the same authenticated hostCheckForUpdates,
hostInstallUpdate, hostCancelUpdate, and hostUpdateStatus RPCs. The host broadcasts
host.updateStatusChanged. Existing stores retain reconnect and stale-reply guards.
Checks use the shared 10-second startup/four-hour cadence and one-minute manual
check limit. Installation is explicit.

The supervisor acquires an install lease and stages an exact release. It verifies
SHA256, the manifest version and protocol, required files, and bundled Node.
Downloads do not block active work. Once downloaded, admission closes to new
user work/automation triggers; accepted queues, provider runs, helper runs and
setup operations drain. Waiting can be cancelled. The supervisor stops its own
server child normally, snapshots the full host data directory after exit, and
atomically activates the candidate version. Runtime and data directories cannot
contain one another.

The snapshot includes SQLite/WAL files and auxiliary stores. Symlinks are copied
without following them. Project files and provider state outside the host data
root are not restored. Candidate startup can run migrations, but work admission,
external RPC mutations and HTTP requests stay blocked until readiness is
confirmed. A failed or timed-out candidate is stopped before restoring the
snapshot and previous version. A durable receipt makes recovery retryable after
interruption. Recovery refuses to proceed if the old server still owns the data or the snapshot belongs to another data directory.
The backup is removed only after a committed result or recorded rollback.
Previous runtimes are retained; do not remove a runtime still used by the parent.

The shared UI stays on the current page and names Solus or the provider being
updated. Pill mode suppresses update toasts. Desktop-hosted Solus uses the desktop
updater; standalone service management supports Linux/macOS, not Windows.

## Providers

Provider checks still use the published Claude Code/Codex versions. Installation
checks the executable already on PATH: native Claude and the active npm Codex
installation can use their existing installers. Other/unknown installations are
refused with manual remediation rather than replaced by a competing copy. No
live provider installation was performed in this follow-up.

## Verification, September 9, 2026

Direct implementation continued from the isolated executor baseline. Tests found
and fixed missing data restoration, lost custom service settings, macOS start
after stop, and a missing automatic idle-check timer. The Linux package was run
on 10.10.1.22 under the dedicated solusverify account, with separate host data,
port and systemd service. Test releases 0.31.10–0.31.13 are synthetic versions of
the packaged application served by a local HTTPS release fixture; they are not
published releases. TLS used the fixture certificate as an explicit trust root.

Passed: fresh installer, setup/health, custom data path/port, actual systemd
status, successful 0.31.10 to 0.31.11 update with unchanged supervisor PID,
checksum rejection without restarting the server, failed candidate that mutates
host data followed by binary/data restoration, interrupted-trial receipt recovery,
service stop/start and uninstall preserving data. Interrupted recovery was tested
by constructing the exact persisted state at the interrupted checkpoint while
stopped. Focused Node-process tests also cover candidate timeout and lease conflicts.

HTTP and RPC gates are checked separately. Native macOS service execution and
fresh graphical desktop/mobile verification have not been performed in this
follow-up. README and public docs now describe the owned installation. Publishing
the installer is part of the next server release; no release or PR was created.
Evidence is retained under `.solus-local/owned-server-qa` in the main checkout.

The final integrated build and CLI typecheck/lint pass. VM test services were stopped; the solusverify account was removed after proving data-preserving uninstall. The prior executor test account remains with its service uninstalled. Production data was preserved.
