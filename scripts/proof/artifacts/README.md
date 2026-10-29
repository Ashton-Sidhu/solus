# Cloudflare Artifacts proof

This is an experimental storage proof. It does not install an Artifacts adapter
in the Solus product or change publication. All repositories contain synthetic
fixtures. Local databases and checkpoints use temporary directories. Cloud runs
create uniquely named repositories and a test Worker, then remove them.

The product rule is local first: local works keep their current storage and
offline behavior. Publication transfers their history to Artifacts.

## Prerequisites

- Install workspace dependencies. The recorded run reused the primary checkout's
  dependencies through a temporary `node_modules` link. Bun's workspace paths
  resolved source files in this worktree.
- Bun, Node, Git, and npm are needed for the local proof.
- Cloud tests need Workers Paid and an authenticated Wrangler with
  `artifacts:write`. Set `CLOUDFLARE_ACCOUNT_ID` explicitly. Credentials are read
  from `CLOUDFLARE_API_TOKEN`, or from the macOS Wrangler login file. Token values
  are never saved in the reports.
- The Worker proof defaults to the Wrangler installed in the sibling
  `solus-cloud/host-worker`. Set `ARTIFACTS_PROOF_WRANGLER` for another installation.
- ArtifactFS needs Linux and `/dev/fuse`. The recorded run used the Omarchy VM at
  `10.10.1.79`. Its source was pinned to
  `2b87a48691ef4ae82d391b7bbe4976c06c7fadf7`.

## Run

```sh
# Current Solus behavior, without Cloudflare.
bun test tests/unit/work-version.test.ts tests/unit/work-revisions.test.ts \
  tests/unit/work-reviews.test.ts tests/unit/work-live.test.ts \
  tests/unit/work-write-paths.test.ts

# Work snapshots, pending receipts, concurrent writes, and Git recovery.
ARTIFACTS_PROOF_RESULTS=.solus-local/artifacts-proof/results \
  bun test scripts/proof/artifacts/work-proof.test.ts

# The same proof against real Artifacts, including the larger history fixture.
CLOUDFLARE_ACCOUNT_ID=<account-id> ARTIFACTS_PROOF_CLOUD=1 \
  ARTIFACTS_PROOF_RESULTS=.solus-local/artifacts-proof/results/cloud \
  bun test scripts/proof/artifacts/work-proof.test.ts

# Use the current cf login and disposable repositories in the default namespace.
CLOUDFLARE_ACCOUNT_ID=<account-id> ARTIFACTS_PROOF_AUTH=cf \
  ARTIFACTS_PROOF_CLOUD=1 \
  ARTIFACTS_PROOF_RESULTS=.solus-local/artifacts-proof/results/cf-refresh \
  bun test scripts/proof/artifacts/work-proof.test.ts

# Partial-clone comparison and unfinished-change checkpoint recovery.
CLOUDFLARE_ACCOUNT_ID=<account-id> \
  bun scripts/proof/artifacts/repo-proof.ts .solus-local/artifacts-proof/results --cloud

# Deploy a disposable Worker to test the binding, then delete it.
CLOUDFLARE_ACCOUNT_ID=<account-id> bun scripts/proof/artifacts/worker-proof.ts

# Lint and targeted types. Worker proof generates the binding declarations first.
bunx oxlint scripts/proof/artifacts
bunx tsc --project scripts/proof/artifacts/tsconfig.json
```

The work prototype uses native Git in a Node/Bun process. The Worker proof tests
binding reads, history, forks, token revocation, and authenticated access. It
does not implement a Worker-only Git writer.

With cloud mode enabled, import and restore, lost-response recovery, pre-push
failure, invalid-history refusal, and concurrent-writer checks also use real
Artifacts repos. The import check uses a separate SQLite destination, restores
a revision through the Solus work API, then writes that restored snapshot back
to Artifacts. It does not invoke the product's cloud upload handler.
Git credentials pass through an askpass process; they are absent from Git
configuration and remote URLs. Git tracing is disabled for this proof.

The Postgres baseline uses the existing unit runner, which creates and drops a
database for each file. `POSTGRES_ADMIN_URL` must name a disposable server:

```sh
POSTGRES_ADMIN_URL=<disposable-postgres-url> \
  bun scripts/test-unit.ts --engine=postgres work-version.test.ts
```

Run the other four named files the same way. No production database is used.

## ArtifactFS

Build the pinned external ArtifactFS source for Linux amd64 with Go 1.26 or
later. Copy that binary to the test VM as
`/tmp/solus-proof-artifact-fs-2b87a48`. Compile only this proof entry:

```sh
bun -e 'const result = await Bun.build({entrypoints:["scripts/proof/artifacts/fuse-proof.ts"],outdir:".solus-local/artifacts-proof/bundle",target:"node"}); if(!result.success) {console.error(result.logs);process.exit(1)}'
scp .solus-local/artifacts-proof/bundle/fuse-proof.js \
  10.10.1.79:/tmp/solus-proof-fuse-2b87a48.mjs
scp scripts/proof/artifacts/askpass.mjs 10.10.1.79:/tmp/askpass.mjs

# File-backed upstream, entirely on the VM.
ssh 10.10.1.79 'node /tmp/solus-proof-fuse-2b87a48.mjs /tmp/solus-proof-artifact-fs-2b87a48 /tmp/solus-proof-fuse-results-2b87a48'

# Real Artifacts remote. Repo credentials travel over SSH stdin.
CLOUDFLARE_ACCOUNT_ID=<account-id> \
  bun scripts/proof/artifacts/run-fuse-cloud.ts
```

Each FUSE run creates and removes its own fixture and daemon. It captures the
daemon PID and stops only that process. The copied binary, bundle, askpass helper and result
directories on the VM must be removed after their reports are copied back.

## Interpretation

`results/` contains the recorded evidence. See
`docs/plans/cloudflare-artifacts-proof.md` for the outcome and remaining product
checks.

- Disk samples count allocated filesystem blocks. FUSE samples measure its
  backing state, not the apparent size of its mounted tree.
- Both repository lanes use the same fixture and full commit history. It has
  about 16 MiB of obsolete binary content, 8 MiB of current assets, 100 source
  modules, one real npm dependency, 16 MiB of explicitly synthetic dependencies,
  and 8 MiB of synthetic output. Network latency differs between local and
  Cloudflare remotes, so their startup times are not comparable network benchmarks.
- The scale check measures the publisher's temporary Git storage. Its
  experimental input still contains the entire exported snapshot. It does not
  prove bounded application memory or a production incremental-write interface.
- Recovery checks cover Git, a SQLite pending-operation journal, tar checkpoints,
  and FUSE daemon restarts. They do not cover a managed Cloudflare container loss,
  R2 restore, native root snapshots, or a deployed Solus version.
- Existing review decisions are absent from the current `WorkTransfer`. The
  proof records that gap instead of inventing a new transfer contract.
- Artifacts request counters count this client's control-plane calls. They are
  not billed operation counts and do not include Git traffic.
- The proof does not validate desktop, web, mobile, real provider turns, asset
  serving, a Postgres import from Artifacts, or Google-linked work publication.

Exit status fails on a failed check or failed cleanup. A report can also contain
blocked product checks; a zero exit status does not mean those checks passed.

### Multiplayer work storage through real Cloudflare

`lab-proof.ts` starts the Lab's isolated record service with the production
Artifacts adapter. Alice writes; Bob reads edits, archived revisions, restores,
and a live diagram update; Carol cannot read the organization work. A separate
local host publishes an HTML work and its history. Publication must return only
after Cloudflare accepts the archive. Each disposable remote is deleted and its
404 response is checked at the end. No deployment is made.

Set `SOLUS_LAB_ENTRY` to the current light Lab build. Run from this worktree:

```sh
SOLUS_LAB_ENTRY="$PWD/.solus-local/lab-build/standalone.js" \
SOLUS_LAB_AUTH_HOME="$HOME" \
HOME="$PWD/.solus-local/lab-home" \
CODEX_HOME="$PWD/.solus-local/lab-home/.codex" \
bun --tsconfig-override ./tsconfig.json scripts/proof/artifacts/lab-proof.ts
```

The cf CLI refreshes its existing login. Credentials remain in memory and child
environments. The default namespace is used; only new synthetic work repositories
are removed. Evidence is `.solus-local/lab-cloud/evidence/artifacts/summary.json`.
The broad multiplayer suite is a separate run; this proof does not imply that
session sharing, runner delegations, seats, or client screens pass.
