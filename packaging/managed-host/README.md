# Managed host image

The Linux image a managed host runs (docs/plans/managed-hosts.md). It is the same
standalone Solus server a personal host installs, booted in managed mode
(`SOLUS_MANAGED=1`) on one Fly Machine with one persistent volume at `/data`.

The image is replaceable; the volume is authoritative.

## What is in it

| Part | Where | Pinned in |
|---|---|---|
| Solus server and web client (`scripts/package-server.ts` tarball, linux-x64) | `/opt/solus` | the repository at build time |
| Node | `/usr/local/bin/node` (`/opt/solus/bin/node` links to it) | `Dockerfile` base image `node:24.18.0-bookworm-slim` |
| `@anthropic-ai/claude-code`, `@openai/codex` | global npm | `Dockerfile` args `CLAUDE_CODE_VERSION`, `CODEX_VERSION` |
| `cloudflared` | `/opt/solus/bin/cloudflared` (`SOLUS_CLOUDFLARED`) | `Dockerfile` arg, same release and checksum as `apps/cli/src/lib/cloudflared.ts` |
| `litestream` | `/usr/local/bin/litestream` | `Dockerfile` arg with the release checksum |
| `git`, `ripgrep`, `procps`, `openssh-client`, `ca-certificates` | Debian | base image |
| user `solus` | `/etc/passwd` | the one non-root user the server and every agent run as (§5) |

Environment baked into the image:

```
HOME=/data/home
SOLUS_DATA_DIR=/data/state
SOLUS_INSTALL_DIR=/opt/solus
SOLUS_NO_LAN_DISCOVERY=1
SOLUS_MANAGED=1
SOLUS_TUNNEL_PORT=34118
SOLUS_PROJECTS_ROOT=/data/projects
SOLUS_CLOUDFLARED=/opt/solus/bin/cloudflared
```

Environment the control plane sets per machine (§2, §6):

```
SOLUS_MANAGED_LINK=<EnrollHostResponse as JSON> # the link the control plane enrolled; the host deletes it from its env on read
LITESTREAM_REPLICA_URL=s3://<bucket>/<host prefix>   # optional; without it no replication runs
LITESTREAM_REPLICA_ENDPOINT=https://<account>.r2.cloudflarestorage.com
LITESTREAM_ACCESS_KEY_ID=…
LITESTREAM_SECRET_ACCESS_KEY=…
```

## What the image does not do

- No `solus update`, no update supervisor. A new server or agent version is a new
  image; the control plane replaces the machine's image.
- No setup wizard and no pairing. Nothing is trusted by network position; `/pair*`
  answers 404 on both listeners and no pair code is printed at boot. Every person
  arrives through the tunnel with a grant.
- No host login. Every agent turn runs on a member's seat.
- No per-member process isolation. The entrypoint starts as root, lays out the
  volume, and drops to `solus` with `setpriv` before the server starts; the server
  and every agent it spawns run as that one user (§5).

## Layout on the volume (§3)

`entrypoint.sh` creates these on every boot, so a fresh or restored volume works
without a hand step. It gives each directory and its immediate children to
`solus`; it never walks the whole volume.

```
/data/state          0700 solus:solus   database, works, settings, link record, secret store
/data/state-seats    0700 solus:solus   member seats (provider-seats.md §3.1)
/data/home           0755 solus:solus   HOME, with the .claude and .codex transcript roots
/data/projects       0755 solus:solus   repositories and worktrees
```

## Build

From the repository root, with Docker running:

```
bun scripts/managed-image.ts            # → registry.fly.io/solus-managed:<package.json version>
bun scripts/managed-image.ts --tag x:y  # a disposable local tag
```

or directly:

```
docker build --platform linux/amd64 -f packaging/managed-host/Dockerfile -t registry.fly.io/solus-managed:<version> .
```

Stage 1 runs on the build machine's own architecture and packages the linux-x64
server tarball; stage 2 is the amd64 runtime. Nothing is pushed by the script.

## Push

```
fly auth docker
docker push registry.fly.io/solus-managed:<version>
```

The control plane names the image tag when it creates or updates a machine (§7).
Tag every push with the release version; never move a tag.

## Local run

A disposable container, no cloud, no real data:

```
docker volume create solus-managed-proof
docker run -d --name solus-managed-proof -v solus-managed-proof:/data solus-managed-proof:local
docker exec solus-managed-proof stat -c '%a %U' /data/state          # 700 solus
docker exec solus-managed-proof ps -o user= -C node                  # solus
docker exec solus-managed-proof curl -s localhost:34118/health       # {"ok":true,...,"requireAuth":true}
docker exec solus-managed-proof curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/pair   # 404
docker rm -f solus-managed-proof && docker volume rm solus-managed-proof
```

Without `SOLUS_MANAGED_LINK` the host boots unlinked: it serves, it refuses
every credential-free caller, and its connector never starts. That is the expected
state of an image test, not a fault.

## Restore drill (§6)

Two copies exist: the daily Fly volume snapshot (five-day retention, whole `/data`)
and Litestream's continuous replica of `/data/state/solus.db`. The database must
never be older than the files, so the replica is restored over the snapshot's copy.

1. **Fence the old machine.** On the control plane, revoke the host's link and
   advance its connection generation before the replacement boots. A restored
   copy that still holds the old tokens then learns it is superseded instead of
   fighting the new one for the tunnel (`uplink_superseded` in the host log).
2. **New volume from the snapshot.**
   `fly volumes create data --snapshot-id <id> --app <app> --region <region> --size <gb>`
3. **Restore the database over the snapshot's copy.** Start a machine on the new
   volume with the image but the entrypoint overridden, so no server opens the file:
   ```
   fly machine run <image> --app <app> --volume data:/data --entrypoint sh -c \
     'rm -f /data/state/solus.db /data/state/solus.db-wal /data/state/solus.db-shm && \
      litestream restore -config /etc/litestream.yml -o /data/state/solus.db /data/state/solus.db'
   ```
   `litestream restore` reads the replica named for that path in `litestream.yml`
   from `LITESTREAM_REPLICA_URL`, so pass the same Litestream environment.
4. **Re-enroll.** The link record on the volume names a generation the control
   plane revoked in step 1. Create the machine with a fresh `SOLUS_MANAGED_LINK`
   from a new enrollment: its generation is newer than the record's, so the host
   adopts it at boot (§2). Nothing on the volume needs removing.
5. **Verify.** `managed_link_adopted` in the host log, `ready` on the host's
   directory row, and a member opens a session whose transcript predates the restore.

Recovery objective: the age of the newest snapshot for files, plus Litestream's
sync interval (1 s in `litestream.yml`) for the database. No zero-data-loss claim.

## Rollback

An image is rolled back by pointing the machine at the previous tag; the volume is
untouched. Roll back only to an image whose `server-release.json` `storage` hash
matches the running one, or one older than it: a newer image may have migrated the
database, and an older server must not open a migrated file. When in doubt, restore
the snapshot taken before the update instead.
