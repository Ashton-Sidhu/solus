# Managed host

A managed host (docs/plans/managed-hosts.md) is the same standalone Solus server a
personal host installs, booted in managed mode (`SOLUS_MANAGED=1`) on one Fly
**Sprite** per organization. The Sprite's disk is persistent and backed by object
storage; the release installed on it is replaceable.

This directory also holds the Docker image (`Dockerfile`, `entrypoint.sh`) that
managed hosts used to run on Fly Machines. Managed hosts no longer use it; the
workspace service does (`packaging/workspace-service`), so it carries neither
`cloudflared` nor Litestream and bakes no managed-host settings.

## How a Sprite boots

The control plane creates the Sprite with a public URL and writes two files into it:

- `/home/sprite/solus-managed/bootstrap.sh`, its own short script. It downloads
  `solus-server-linux-x64.tar.gz` and `SHA256SUMS` for the pinned release,
  verifies the checksum, and installs the release read-only under
  `/opt/solus/releases/<version>`.
- `/home/sprite/solus-managed/link.json`, only when it has a new link: the
  `EnrollHostResponse` for this host, with **no connector token**. The bootstrap reads
  it into `SOLUS_MANAGED_LINK` and deletes the file before anything else runs.

It registers one Sprite service, `solus`, with `--http-port 34118`, running the
bootstrap. The bootstrap then execs this release's own
`libexec/managed/sprite-boot.sh` (from `sprite-boot.sh` here; `scripts/package-server.ts`
ships it in every linux tarball), which:

1. Once per release: installs Debian packages, the `solus` user, the latest
   `@anthropic-ai/claude-code` and `@openai/codex` (at `<release>.agents`), and the
   Chromium revision this release's `playwright-core` drives (at `<release>.browsers`).
2. Every boot: lays out `/data` (below), giving each directory and its immediate
   children to `solus` without walking the whole tree.
3. Drops to `solus` with `setpriv` and execs the server. `solus` has no sudo; the
   server and every agent it spawns run as that one user (§5).

The Sprite's proxy forwards its URL to the server's proxied listener on
`127.0.0.1:34118`, so the server treats every request from the URL as tunnel traffic:
only `/health`, `/auth/ws-ticket`, and signed assets exist there, and every caller
needs a grant. There is no `cloudflared` and no tunnel.

A running service does not keep the Sprite awake. Only inbound HTTP work, or a live
Tasks API hold (one hour at most, renewed), keeps it running; with neither, the Sprite
pauses. An agent turn makes only outbound calls, so a turn with no client connected
can pause with the Sprite. The control plane is to hold a task while a turn runs,
while a permission or question waits, and for scheduled automations
(`plans/004-shared-host-collaboration.md`, "A pause stops everyone"). That hold is
not built yet. Stopping the host stops the service; starting it is the control plane
starting the service again.

## Layout on the disk (§3)

```
/data/state          0700 solus:solus   database, works, settings, link record, secret store
/data/state-seats    0700 solus:solus   member seats (provider-seats.md §3.1)
/data/home           0755 solus:solus   HOME, with the .claude and .codex transcript roots
/data/projects       0755 solus:solus   repositories and worktrees
```

## Releases and rollback

The control plane pins the release (`MANAGED_HOST_RELEASE`). A new release is a config
change followed by a reconcile: the bootstrap installs the new version beside the old
one and `sprite-boot.sh` provisions it once. Roll back only to a release whose
`server-release.json` `storage` hash matches the running one, or an older one: a newer
server may have migrated the database, and an older server must not open a migrated
file. Before a risky roll, take a Sprite checkpoint (`sprite checkpoint create`); a
restore puts the whole disk back.

## What a managed host does not do

- No `solus update`, no update supervisor.
- No setup wizard and no pairing. `/pair*` answers 404 on both listeners.
- No host login. Every agent turn runs on a member's seat.
- No per-member process isolation (§5).

## The Docker image (workspace service)

```
bun scripts/managed-image.ts            # → registry.fly.io/solus-managed:<package.json version>
bun scripts/managed-image.ts --tag x:y  # a disposable local tag
fly auth docker && docker push registry.fly.io/solus-managed:<tag>
```

Tag every push; never move a tag. See `packaging/workspace-service/README.md` and
`scripts/release-workspace.ts`.
