# Cloudflare managed hosts

The first Cloudflare host implementation lives in the adjacent `solus-cloud`
repository under `host-worker/`. It uses Cloudflare Containers with Sandbox 1.0 file
and backup APIs. Postgres remains the cloud application's database.

The existing remote host RPC, provider adapters, and proxied listener remain the
client boundary. No client should need a Cloudflare SDK or know a container path.
The trial must verify desktop, web, and mobile, and both Claude and Codex.

`ManagedHostActivity` supports both host runtimes. Sprites holds its local task;
a host with `SOLUS_MANAGED_RUNTIME=cloudflare` writes an atomic heartbeat to
`/run/solus-managed/activity.json`. The container supervisor creates that private
directory for the `solus` user. Both runtimes still report activity and the next
automation time to the cloud control plane. Other host categories do neither.

The Cloudflare controller uses the heartbeat to avoid stopping an active host.
Before a planned stop, it stops the server and saves the native `/data` directory
to R2. It can also use a root filesystem snapshot for a later start. Repositories
and SQLite databases are not placed on an R2 object mount.

This is an opt-in implementation for an isolated trial. Production has not moved.
Unexpected container loss can lose changes since the last checkpoint. The local
Linux trial now passes native snapshot restore and R2 restore into a fresh image,
including Git changes and a SQLite transaction. It also verifies that an active
detached writer prevents a checkpoint. The cloud repository's
`host-worker/README.md` records the setup, acceptance tests, and cutover limits.

The separate `spikes/cloudflare-computer/` proof passed local tests for user file
isolation, Dynamic Worker shell execution, read-only R2 input, and persistence
across a full runtime restart. It is not a replacement for the native host yet.
