# Plan 008: One HTTP API for workspace records

**Status:** Implemented in the working tree on 2026-09-28 and simplified the same
day: one record schema per resource (no duplicate public projections of stored
fields), one scope check on the operation, plain keyset cursors with no signing or byte budget, and the Lab
scenarios on the record API. Verification is recorded in
[docs/api/validation.md](../docs/api/validation.md). The reduced contract is
[docs/api/openapi.json](../docs/api/openapi.json), generated from runtime schemas.
Interactive client verification remains to be run. No deployment or pull request
was requested.

**Outcome:** Provide a small authenticated request API for Solus-owned records.
Desktop, web, mobile and external callers share the same authorized domain
operations. The API can run independently of agent execution; desktop continues
to bundle both in its existing process.

## 1. Agreed scope

| Domain | Initial HTTP operations |
| --- | --- |
| Tasks | List, read, create, update, delete |
| Works | List, read, create, update, delete |
| Stored sessions | List, read metadata, read text transcript |
| Insights | GET list and GET one agent-turn record |
| Foundation | Credential exchange, capabilities, implemented OpenAPI |

There are 15 resource operations and three foundation operations. No duplicate
Local/organization route bindings. Paths start at `/v1/tasks`, `/v1/works`,
`/v1/sessions` and `/v1/insights`.

GitHub already provides pull request data and operations. Do not build a PR
proxy in this API. Solus-owned links, session associations and saved review
works remain Solus records, with existing association operations retained.

Comments, sharing administration, projects, saved prompts, upstream tasks,
document publication, assets and detailed transcript hydration remain on their
current routes. Automation definitions, history and scheduling remain host-owned.
Session creation/admission, prompt execution, terminal/files/browser, pairing,
provider login, raw SQL, aggregate queries and bulk exports are outside this
initial contract. The earlier session-admission integration remains separate
future work under the broader cloud feature, not a completion criterion here.

Keep existing resource privacy and organization Insights policy. This transport
work does not change root task/work privacy. New cloud session privacy remains
owned by the cloud feature decision. Follow the current organization-scope
vocabulary: record home, organization, actor/owner, grants and execution host
are distinct. Local scratch stays Local until explicitly published.

## 2. Authentication and organization context

Use `/v1/auth/session` to exchange verified source authority for a short-lived
API bearer. Account authentication selects and authorizes the organization when
issuing a source grant. The exchange derives the actor, audience and organization
from that verified grant. Its body can request narrower scopes and, for a guest,
supply the required share secret. It cannot select an organization or actor.

Local desktop/paired-device authority produces a Local context bound to its host.
Signed claims or equivalent server-side token state bind each API credential to
one context. Resource paths, bodies and query/header values cannot override it.
Keep separate credentials per connection/window. Do not infer a mutable account-
wide active organization; switching organizations obtains a new credential.

All data requests require explicit authentication, including loopback. Consume
one-time cloud grants once; do not reuse WebSocket tickets or disable their replay
protection. Tokens last at most five minutes, bounded by source expiry. Renewal
requires source authority, with single-flight refresh in the client. Device and
guest revocation is checked per request; account/membership revocation follows
available signals and takes effect by credential expiry at latest.

Scopes are `tasks:read/write`, `works:read/write`, `sessions:read` and
`insights:read`. They limit operations but do not grant record access. Guest
resource restrictions remain in force. Machine grants alone cannot impersonate
users. Server-side scope, owner and parent checks apply before all lookups,
filters, cursors, events and returned references.

Insights list/get currently requires organization context and its existing
Insights policy. Local Insights continues on its host path. Session visibility
is checked separately; Insights permission does not expose transcripts.

## 3. Shared operations and current change points

Read current sources before implementation; other work is active in this tree.

| Area | Source | Change |
| --- | --- | --- |
| HTTP | `packages/server/src/transport/http.ts` | Mount the small versioned route set on the existing listener |
| Admission | `packages/server/src/admission/{principal,access-policy,auth,host-grants}.ts` | Preserve principals/resource checks; add credential-bound request context |
| Contracts | `packages/contracts/src/{rpc,rpc-planes,host-api,host-events}.ts` | Inventory only affected operations/callers; retain unrelated RPC and events |
| Handlers | `packages/server/src/transport/handlers/` task, Folio, history and organization handlers | Extract shared authorized operations where needed |
| Data | `packages/server/src/data/{tasks,works,sessions,insights}/` | Reuse storage/domain rules; add scoped seek pagination and individual Insight lookup |
| Agent tools | `packages/server/src/execution/agents/tools/` task, work and Insights tools | Use the same operation with admitted actor/home; preserve retained commands |
| Client | `packages/client-core/src/` connection and transport modules | Add typed HTTP calls alongside existing execution/event transport |
| Stores | `packages/workspace-ui/src/contexts/` task, work and session stores | Migrate covered reads/writes only after caller parity is proven |
| Composition | `packages/server/src/{boot-core,boot-server}.ts` and standalone entry | Reuse API composition without requiring an execution runtime |

Add a small operation/schema registry under `packages/contracts/src/solus-api/`.
It declares method/path, exact inputs/outputs, scopes, bounds and retry behavior.
Use runtime schemas for validation, inferred client types and generated OpenAPI.
Port this reviewed draft into that registry; do not maintain a second contract.

HTTP adapters decode and encode. Shared admission checks verified context,
operation scope, capability and current resource access. Domain operations own
rules, transactions and committed events. Existing RPC and in-process tools can
call those operations directly; no loopback request or duplicate business logic
is required. A wrapper must do useful validation or orchestration.

Preserve the Data/Execution/Sync/Transport dependency boundaries. Keep admission
independent of domain stores by injecting narrow authorization lookups. Remote
routing belongs at client/tool boundaries, never inside a data store. Existing
runner intake remains its own authenticated bulk protocol with receipts and
ordering; do not replace it with a request per streamed token.

## 4. OpenAPI and client contract

The draft uses OpenAPI 3.1.1 and local JSON references. After approval, add a
deterministic generator plus `api:generate` and `api:check`. Generate typed client
operation metadata from the same registry. Check schema conversion against the
installed Zod version. Reject unsupported schemas instead of emitting loose DTOs.

CI must validate OpenAPI with a pinned independent validator, references,
examples, schema rejection cases, unique operation IDs, and equality between
registered routes, served spec and client metadata. Only implemented routes may
appear in the deployed `/v1/openapi.json`; the generated contract is served by the implemented router.
Keep Socket.IO event contracts separate from HTTP OpenAPI.

Use one discovered endpoint and context-bound request handle per connection.
Support abort, typed errors, refresh, safe retries and stale-result rejection.
Cache keys include service, actor, context and resource. A 403 never causes a
fallback to Local or a different identity. Extend CORS and tunnel allowlists for
these exact operations and required headers; never expose unrelated bootstrap.

## 5. Scale, Insights and consistency

All list reads use keyset cursors, default 50 items and maximum 200. No offset
paging or exact count on every request. Task lists omit bodies; work lists omit
content. Detail routes return content. Collections sort by `createdAt DESC, id DESC`.
A cursor is an opaque position and nothing more: every page checks resource
access again, so signing, expiry and actor binding add no protection and were removed.

Insights has only `GET /v1/insights` and `GET /v1/insights/{insightId}`. One record is
one agent turn. List defaults to the last seven days and accepts at most a 31-day
startedAt window, returned in the response and fixed across pages. Filters are
exact user, host, session and provider matches. Order by `startedAt DESC,
hostId DESC, traceId DESC`; individual lookup binds organization, host, and trace ID together. The returned opaque ID encodes host and trace.
No total cost, count, SQL, expression language, POST query or aggregation route.
Read older history in successive bounded ranges. Late imports or updates can
require a fresh traversal; this is not a frozen database snapshot.

The current `data/insights/organization-turns.ts` uses OFFSET and count/sum queries.
The new public list needs a separate bounded seek path that shares its policy and
row mapping, without forcing existing aggregate RPC callers into the new shape.
Inspect actual database keys and indexes before implementing trace identity.

Use scope-prefixed indexes for the sort and supported filter combinations,
including organization/trace identity lookup. Apply filters and LIMIT in the DB,
with no unbounded in-memory scan. Set statement/request deadlines, bounded pools
and per-actor/context rate and concurrency budgets. Return 429/503 with Retry-After.
Choose budgets from deployment limits and measurements. Verify representative
large-data query plans, tie cases, deep pages and selective filters on SQLite and
Postgres. Horizontal service deployment, sharding and replicas are separate work.

Transcript reads return bounded text fragments through one cursor endpoint.
Message sequence, revision and content offset permit exact reconstruction without
silent truncation; a message that changed under a partial read answers INVALID_CURSOR. This is a text projection;
keep rich-renderer hydration and attachment reads on their existing paths.

Creates require transactional idempotency receipts retained at least 24 hours;
updates/deletes require ETag/If-Match. Return 201 only after commit, 204 after
delete, 412 on stale version. Recheck access before replaying receipts. Preserve
linked-document read-only rules. Emit events only after committed mutations.
Existing WS invalidations and reconnect refetch keep store state current; HTTP
does not require a socket. Do not introduce new external-provider write receipts.

## 6. Implementation and verification

| Stage | Deliverable | Required proof |
| --- | --- | --- |
| 0 Review | Approve this small contract; map affected callers and retained RPC | No excluded family is silently migrated or removed |
| 1 Contract | Runtime schemas, generator, client metadata and independent validation | Deterministic spec, valid examples, invalid-input rejection, route coverage |
| 2 Tasks and auth | Credential exchange, shared operation gate, task CRUD | Local/org context isolation, two-window separation, guest/parent access, retry/version behavior |
| 3 Works and stored sessions | CRUD and bounded metadata/text reads | Read-only works, stored reads without execution, no private-resource leaks, complete text reconstruction |
| 4 Insights | List/get and indexed bounded query path | Same policy for both routes, context-bound ID lookup, a window fixed on the first page, bounds and large-data query plans |
| 5 Composition and caller cutover | API-only startup and covered client/tool calls | No execution workers in API boot; desktop keeps combined process; no duplicated domain rules |

The API-only composition uses existing SQLite/Postgres adapters and can retain
required intake/event infrastructure without constructing `SessionRuntime`, agent
backends, browser hosts or automation schedulers. Desktop reuses that composition
on its existing listener. A separate deployment does not require a new desktop
subprocess or imply horizontal event delivery.

Migrate desktop/web/mobile stores, tools and other immediate callers only where
this contract covers their behavior. Do not replace rich transcript UI with a
text-only projection. Remove obsolete RPC wrappers once all their callers move;
retain operations that still serve excluded or richer behavior. Update transport
instructions to document the new boundary when implementation begins.

Use isolated fixtures and focused contract, auth, resource, client, cursor and
boot tests. Include repeated timestamps, empty/last/short pages, new rows during
paging, changed visibility, malformed cursors, expired credentials,
missing resource IDs, oversized writes, and exact multi-part transcript recovery.
Use disposable databases for query plans; no live user data. Both Claude and
Codex tools must preserve admitted actor/home on covered operations.

After implementation, one agreed integration pass covers desktop Local/cloud,
web and mobile, including loading/error/stale states and reconnect. This plan
itself authorizes no build, deployment, PR or interactive app launch. The task remains in progress; see the validation record before release.
