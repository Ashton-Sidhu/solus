# Workspace service

The cloud process every client of an organization connects to first
(docs/plans/cloud-service-model.md §15). It is the managed-host image
(`packaging/managed-host`) booted in **workspace mode**: `SOLUS_WORKSPACE=1`,
`SOLUS_ROLES=collaboration`, one Postgres for every organization, no link record,
no tunnel, no pairing, and a grant minted for `solus-workspace` as the only
credential. It runs no agent and holds no checkout; a runner linked to an
organization delivers its writes here (§16).

The image is built from `packaging/managed-host/Dockerfile`, which managed hosts
no longer use (they run on Sprites). `fly.toml` sets the workspace variables, and
`SOLUS_MANAGED=0` explicitly; the entrypoint's volume layout lands on the machine's own
disk, which holds nothing worth keeping (the SQLite file it creates carries only
runner-local tables that stay empty here).

## Environment

Set in `fly.toml`:

```
SOLUS_MANAGED=0
SOLUS_WORKSPACE=1
SOLUS_ROLES=collaboration
SOLUS_HOST=0.0.0.0
SOLUS_PORT=3000
SOLUS_NO_LAN_DISCOVERY=1
SOLUS_DATA_DIR=/data/state
```

Secrets, never in the file:

```
fly secrets set --app solus-workspace \
  DATABASE_URL='postgres://…' \
  SOLUS_CLOUD_ISSUER='https://app.solus.sh' \
  SOLUS_CLOUD_JWKS_URL='https://app.solus.sh/api/auth/jwks' \
  SOLUS_INTEGRATION_SERVICE_KEY='<shared account-backend executor key>'
```

GitHub, Google and Atlassian connect at the **account origin**, normally
`https://app.solus.sh/connections`. The account Worker owns OAuth client secrets,
callbacks, encrypted storage and refresh. Do not register integration callbacks on
this workspace service or put OAuth client secrets into its image.

`SOLUS_INTEGRATION_SERVICE_KEY` must equal the account Worker's
`INTEGRATION_SERVICE_KEY`. It identifies the service when it asks the account
backend for a user's integration access token. Each request also requires the
user's current signed workspace grant; the service key alone cannot select a user.
Personal and managed execution hosts use their existing host token plus that
user's host grant. The desktop's local server uses its main-process account session.

Claude and Codex logins remain on each execution host. The service cannot run a
login or store a seat. Migration `0010_account_integrations` removes the old cloud
credential tables. Before this release is deployed, tell members to connect their
integrations on the account website and verify their agent login on each host.
No old cloud credential is copied to another host. Existing local provider files
are not deleted by this migration. Remove the obsolete `SOLUS_VAULT_KEY` after
cutover; it is not read by this release.

Account setup and the exact callback URLs are in the sibling repository's
`docs/account-integrations.md`.

The service refuses to start without all three (`workspace_mode_applied` in the
log names the engine it opened). Migrations run at open on the first machine to
reach the database; the second waits on the same migrator table.

## Deploy

From the repository root, with the image already pushed
(`bun scripts/managed-image.ts` then `docker push`, as `packaging/managed-host/README.md`
describes; the tag in `fly.toml` must name that push):

```
fly apps create solus-workspace
fly secrets set --app solus-workspace DATABASE_URL=… SOLUS_CLOUD_ISSUER=… SOLUS_CLOUD_JWKS_URL=… SOLUS_INTEGRATION_SERVICE_KEY=…
fly deploy --config packaging/workspace-service/fly.toml --ha=false
fly scale count 1 --app solus-workspace
```

`DATABASE_URL` is the one Postgres 17 the account website shares (its Worker reaches
it through Hyperdrive; the two keep separate migration tables). It must have a
**public TLS hostname**: Hyperdrive dials it from Cloudflare's edge, so a database
that only answers on a private network — Fly Managed Postgres, whose only address
is `direct.<id>.flympg.net` — cannot serve it. The deployed choice is PlanetScale
for Postgres (PS-5, AWS `us-east-1`, next to Fly `iad`), on the direct port 5432
with `sslmode=require`; do not use its PgBouncer port 6432, since Hyperdrive is
already the pooler and `postgres-js` prepared statements misbehave behind it.

`fly deploy` replaces the single machine; this briefly interrupts connections.
The health check on `/health` (which answers `requireAuth: true` here) gates it. A new release is a new image
tag in `fly.toml` and another `fly deploy`; nothing on a machine survives it and
nothing needs to.

## What the control plane needs

```
WORKSPACE_SERVICE_URL=https://solus-workspace.fly.dev
```

The control plane puts that origin in every organization's directory row
(`hostId: workspace:<organizationId>`, `kind: cloud`, one `tunnel` route) and in
the `routes` of every runner grant it mints (`POST /v1/hosts/:hostId/runner-grant`).
Grants for the service carry `aud: solus-workspace`, `hostKind: cloud`, and the
organization; the service admits members of any organization and runners of any
organization, and scopes every row by the grant.

## Verify

```
curl -s https://solus-workspace.fly.dev/health                       # {"ok":true,"installationId":…,"requireAuth":true}
curl -s -o /dev/null -w '%{http_code}' -X POST https://solus-workspace.fly.dev/pair   # 404
```

Then, from a client signed in to the control plane, the organization's workspace
row lists and connects, `connectionsGetServerInfo` answers
`hostKind: 'cloud'` with `roles: ['collaboration']`, and a task made there is seen
by another member of the organization. The Lab's `cloud-workspace` scenario is the
same proof against a local build (`packages/lab/README.md`).

## Runner routes

Two `POST` routes exist here and nowhere else, both under
`Authorization: Bearer <runner grant>` (verified without consuming the grant, so
one grant serves its ten minutes), with the body's `hostId` required to be the
grant's own:

- `/runner/outbox` — `{ hostId, ops: [{ seq, op }] }` → `{ lastSeq, failed: [{ seq, error, permanent }] }`
- `/runner/session-records` — `{ hostId, reports: [{ seq, record }] }` → `{ lastSeq }`

`packages/server/src/server/uplink/runner-protocol.ts` is the schema of both.

### P4 public sharing

Deploy the account Worker and the workspace service together. The Worker must have
`WORKSPACE_SERVICE_URL`; `/w/:id`, `/s/:id`, and `/t/:id` serve the client bundle.
`/v1/workspace/guest-grant` replaces the per-host guest-grant endpoint. Old host links
must be recreated in the cloud. Runners must also use the updated image to receive
live shared-session prompts.

Run **one workspace service instance** while using the P4 process-local prompt
relay. A stopped runner remains readable through mirrored history but accepts no
prompt. The relay does not retry an uncertain receipt or retain prompts across
service restarts. Prompts are text-only. Local ownership/access tables are still
used by the signed-out host; they are not a public guest-sharing backend.

### Cloud work changes

Clients check the saved version of open cloud works through the normal RPC
connection. No LISTEN connection or Yjs storage is required. Migration 0010 now removes the
obsolete credential vault; it is unrelated to work editing.
Update the service and client bundle together; there is no live-work API
compatibility layer. Keep the single-instance session relay rule above.
