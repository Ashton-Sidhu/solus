# Workspace service

The cloud process every client of an organization connects to first
(docs/plans/cloud-service-model.md §15). It is the managed-host image
(`packaging/managed-host`) booted in **workspace mode**: `SOLUS_WORKSPACE=1`,
`SOLUS_ROLES=collaboration`, one Postgres for every organization, no link record,
no tunnel, no pairing, and a grant minted for `solus-workspace` as the only
credential. It runs no agent and holds no checkout; a runner linked to an
organization delivers its writes here (§16).

The image is the same one a managed host runs. Nothing in it is parameterized for
this role: `fly.toml` overrides the baked `SOLUS_MANAGED=1` with `0` and sets the
workspace variables; the entrypoint's volume layout lands on the machine's own
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
  SOLUS_VAULT_KEY="$(openssl rand -base64 32)"
```

`SOLUS_VAULT_KEY` (32 bytes, base64) encrypts the credential vault: the provider
logins members connect once here and runners lease for their turns, and the
GitHub, Google, and Atlassian connections each member makes here
(docs/plans/cloud-service-model.md §22). Without it the service still starts, and
every seat call answers `VAULT_NOT_CONFIGURED`. Rotating it invalidates every
stored credential; members connect again.

The OAuth clients those connections use are build-time environment of the image
(`SOLUS_GITHUB_CLIENT_ID`, `SOLUS_GOOGLE_CLIENT_ID` and `SOLUS_GOOGLE_CLIENT_SECRET`,
`SOLUS_ATLASSIAN_CLIENT_ID` and `SOLUS_ATLASSIAN_CLIENT_SECRET`), not secrets set
here. The Atlassian app the image is built with must register
`<service origin>/oauth/atlassian/callback` as its one callback URL — for the
deployment above, `https://solus-workspace.fly.dev/oauth/atlassian/callback` —
and the Google client must list `<service origin>/oauth/google/callback`. A
host's sign-ins use the loopback callbacks instead and are unaffected.

The service refuses to start without all three (`workspace_mode_applied` in the
log names the engine it opened). Migrations run at open on the first machine to
reach the database; the second waits on the same migrator table.

## Deploy

From the repository root, with the image already pushed
(`bun scripts/managed-image.ts` then `docker push`, as `packaging/managed-host/README.md`
describes; the tag in `fly.toml` must name that push):

```
fly apps create solus-workspace
fly postgres create --name solus-workspace-db   # or any Postgres; only DATABASE_URL matters
fly secrets set --app solus-workspace DATABASE_URL=… SOLUS_CLOUD_ISSUER=… SOLUS_CLOUD_JWKS_URL=…
fly deploy --config packaging/workspace-service/fly.toml --ha=false
fly scale count 1 --app solus-workspace
```

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
