# Solus API

The implemented contract is [openapi.json](openapi.json). It is generated from
`packages/contracts/src/solus-api/` and served at `GET /v1/openapi.json`.
Run `bun run api:generate` after a contract change and `bun run api:check` to
check for drift. The JSON file is self-contained.

## Scope and ownership

There are **23 operations on 17 paths**: task CRUD; work CRUD, work search, and
the import, publish, and pull of an external document; stored-session
list/get/text messages; a session admission for an execution host's organization
run; Insights list/get; credential exchange; capabilities; and OpenAPI discovery. See [routes](routes.md) and [Plan 008](../../plans/008-workspace-http-api.md).
There is no GitHub PR proxy, automation API, SQL endpoint, aggregate query, or
caller-supplied organization selector.

Covered record methods now use HTTP in the shared desktop/web/mobile connection
client. Their previous RPC handlers and registry entries are removed. Agent task
and work tools call the same authorized data operations in-process. Claude,
Codex, and OpenCode receive these provider-neutral tools through admitted turn
context. A member's tools cannot fall back to host authority.

Existing RPC remains for execution and events, task comments/links/sidebar
projections, work annotations/sharing/provider sync, and rich session history.
These operations are outside this small HTTP contract. The API's text projection
does not replace the rich conversation renderer. The desktop still runs its
combined server in the existing process; no additional desktop subprocess starts.

## Authentication

Every record request needs a bearer, including loopback requests. First exchange
an existing desktop/paired-device token or an access token from the account plane
at `POST /v1/auth/session`. Local pairing works without a cloud connection. The
configured issuer and JWKS verifier admit cloud and on-premises access tokens
(plans/010-standard-oauth.md).

The issuer verifies membership and binds the access token to an organization.
The API derives the principal, home, and organization from verified authority.
The exchange accepts requested scopes and an optional guest share secret. It
cannot choose a user or organization. Request bodies and queries are strict:
an unknown field, such as an organization selector, is rejected. Scopes restrict
operations; the operation itself checks them, so an in-process agent tool and an
HTTP caller cannot differ. Scopes do not replace resource ownership, sharing, or
parent access checks.

An execution host does organization work with a **delegated token**
(plans/010-standard-oauth.md): the first time a person's organization work reaches
the host, the host trades the access token the person's client presented there for
its own tokens (OAuth token exchange, RFC 8693). The access token names the person
(`sub`), the organization, and the host as the actor (`act.host_id`). The host keeps
the refresh token and refreshes about every five minutes, only while it has work for
that person; each refresh is the live check that the person is still a member and
that the host still reaches the organization. A prompt carries no token. The
credential acts as that person's agent on that host: `POST /v1/session-admissions`
admits the Solus session before the provider starts, and the host's first report of
that session takes its owner from the admission. The runner routes accept only a
delegated token, and they deliver as the person it names.

A delegated token also stands for the person's own account connections (GitHub,
Google, Atlassian), also after their client has closed. The account plane checks,
at each use, that the person is still a member and that the host still reaches the
organization. So an organization run can import, publish, or
pull an external document through the API: `POST /v1/works/import`, `POST /v1/works/{workId}/publish`, and
`POST /v1/works/{workId}/pull`. Without a connection the operation answers
`400` and asks the person to connect the account. It never uses another person's
connection or the host owner's connection. `GET /v1/works/search` searches the
title and content of the works the caller can see.

API credentials expire after at most five minutes and no later than the access
token they came from. Renewal needs another access token. Access tokens are bearer
tokens: the API does not spend them, and it refuses one that lives longer than ten
minutes. API credentials cannot exchange themselves or impersonate runners.
Device revocation is checked on each request; guest access checks read the current
share. Account membership changes take effect by credential expiry at latest.

Each connection caches its credential separately. A host or organization change
invalidates its context and rejects late responses. External clients can use the
HTTP API without a WebSocket connection.

```sh
curl "$SOLUS_URL/v1/auth/session" \
  -H "Authorization: Bearer $SOLUS_SOURCE_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  --data '{"scopes":["tasks:read","insights:read"]}'

curl "$SOLUS_URL/v1/tasks?limit=50" \
  -H "Authorization: Bearer $SOLUS_API_TOKEN"
```

## Reads, writes, and scale

Lists use keyset cursors: default 50 and maximum 200 items, and an opaque
`nextCursor` that names the last row. Task and work lists omit bodies. Resource
access is checked again on every page, so a cursor grants nothing by itself.
Repeating a page is safe, but pages are not a database snapshot of later edits
or deletions.

Insights has only GET list/get. The default range is seven days; a request may
cover at most 31 days. Filters match user, host, session, and provider exactly.
The returned window stays fixed across pages. SQL seeks by
`started_at DESC, host_id DESC, trace_id DESC`, with organization-prefixed indexes.
There is no OFFSET, COUNT, SUM, or scan into application memory. Only scalar
measurements leave the attributes JSON. The individual Insight ID is an opaque
encoding of host and trace identity; use the returned `id`, not `traceId` alone.
Insights requires an organization member. It grants no transcript access.
Local metrics retain the existing host Insights path.

Stored text is sliced in SQL and returned as ordered fragments. A continuation
includes sequence, offset, and revision. Clients reconstruct fragments in order;
a changed partial message requires a fresh read. Rich transcript hydration stays
on its existing authenticated RPC path.

Creates require `Idempotency-Key` (16–128 characters). Receipt and record commit
in one transaction; the same key and input return the current authorized record,
while changed input conflicts. Receipts last 24 hours. PATCH/DELETE require the
quoted `version` in `If-Match`; stale writes return 412. Google-linked works keep
their read-only rule. Work polling uses `If-None-Match`: unchanged content returns
304 without loading or transmitting the document body.

Resource errors have a stable code, message, and request ID. Data responses are
`Cache-Control: no-store`. The HTTP body is capped before JSON parsing (4 MiB
for tasks, 16 MiB for works, with additional field bounds). Each replica admits
at most 32 concurrent API requests and eight per actor, with a minute budget of
300 per actor and 60 credential exchanges per source. Busy/rate responses carry
`Retry-After`. PostgreSQL requests have a five-second statement timeout and a
one-second lock timeout. These limits bound work; they are not a throughput SLA.

## Separate service

The standalone entry branches to `boot-solus-api.ts` for `SOLUS_API=1`
before loading the execution composition. It registers data HTTP routes, scoped
Socket.IO events, stored-session reads, sharing, project directory, shared-prompt
relay, and runner intake. It creates no SessionRuntime, agent backends, browser
host, or automation scheduler. Host-owned execution and provider features stay
on an execution host.

Configure these deployment variables:

| Variable | Meaning |
| --- | --- |
| `SOLUS_API=1` | Start the API service composition |
| `DATABASE_URL` | PostgreSQL database; SQLite is allowed only as an explicit test setting |
| `SOLUS_CLOUD_ISSUER` | Trusted grant issuer |
| `SOLUS_CLOUD_JWKS_URL` | That issuer's public verification keys |
| `SOLUS_API_SIGNING_KEY` | At least 32 random bytes encoded as canonical base64; keep secret and share across replicas |
| `SOLUS_API_SERVICE_ID` | Stable service audience; defaults to the workspace audience |
| `SOLUS_DATA_DIR` | Service-owned data directory |
| `SOLUS_HOST`, `SOLUS_PORT` | Listener address and port |

Cloud and on-premises use the same composition and trust configuration. The
service is not an identity provider: an on-premises issuer must issue the existing
Solus grant contract. Use HTTPS at the deployment boundary. Rotate the shared key
to invalidate API credentials. Database migrations add paging indexes
and receipts; they do not publish or reassign existing records.

HTTP replicas can share credentials, receipts, and PostgreSQL records.
Live event delivery, presence, and the shared-prompt relay are process-local.
Use one service replica for the complete live workspace until a shared event and
relay transport is supplied. Horizontal HTTP reads alone do not solve live
workspace coordination. Rate budgets also apply per replica.

See [validation](validation.md) for executed checks and remaining verification.
