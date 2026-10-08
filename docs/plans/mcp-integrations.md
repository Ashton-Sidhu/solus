# MCP integrations: catalog, gateway, and policy

Status: phases 1 to 3 implemented in the working tree on 2026-10-08 (§12);
phase 4 not started. OpenAPI is in the first release and policy is not
(§9, §6). This plan takes the model of
Executor v2 (`UsefulSoftwareCo/executor`, branch `v2`) and maps it onto Solus.
It locks the vocabulary and the ownership. It names what Solus takes from
Executor, what it does not take, and why.

## 0. What Executor v2 is

Executor is a layer between agents and services. Its model, in its own words:

| Executor term | Meaning |
|---|---|
| Provider | A service and its authentication methods, declared in app code (`secrets` fields or `oauth2`). |
| Account | One saved, reusable instance of a provider method: a label plus the credential. Owned by an organization or the local instance. Personal or shared. |
| App | A deployed program that exposes tools. An MCP server, an OpenAPI document, or authored TypeScript. Runs in workerd. |
| Profile | One person's choice of accounts for one app. `tools.<app>.profiles["<id>"].<tool>`. Every call runs with the caller's own profile. |
| Catalog | The public integrations.sh feed plus built-in apps. Only MCP servers are added directly: Executor probes the server anonymously and decides `Anonymous`, `OAuth`, `CredentialsRequired`, or `Undetermined`. |
| Approval | A rule on one tool: `approved`, `denied`, or `user-approval`. MCP servers added from the catalog ask before tools the server marks `destructiveHint`. |
| Authorization policy | Per grant: which apps, which tools (`all`, `readOnly`, `selected`), and which profiles. Scoped connections are named MCP URLs with such a policy. |
| Execution | One MCP endpoint with three tools: `skills`, `execute({ code })` (codemode in a sandboxed interpreter), and `resume`. Tool calls leave the sandbox into the trusted runtime where credentials live. |
| Elicitation | A paused call asks the person in one of three modes: `model` (the agent relays), `native` (MCP elicitation), or `browser` (a signed-in page). |

The property the maintainers asked for is already Executor's core rule: a
tool call runs with the caller's own account, and nobody runs with another
person's account choices. A login to Executor is not an account. A tool never
receives the login token.

## 1. The decision

Solus becomes the MCP client. Agents do not.

Today an MCP server reaches a Solus agent only through the provider CLI's own
configuration in the person's seat home (`docs/provider-seats.md`,
`docs/plans/agent-auth-commands.md`). Solus can sign a seat in to such a
server. It cannot list, add, or govern one, and the two providers differ.

In this plan a host holds a set of **integrations**. For each integration, each
person signs in with their own account. Solus opens the upstream MCP session
itself, with that person's credential, and exposes the server's tools to the
agent through the `solus` toolbox that both providers already load. The
credential never reaches the agent process. Sign-in state and, later, policy
are checked in Solus, once, for both providers, over every transport.

This is Executor's "one endpoint, credential never in the agent" rule, applied
inside Solus instead of beside it.

### What Solus takes from Executor

- The catalog feed and the anonymous probe that decides how a server connects.
- Per-person sign-in with OAuth discovery, dynamic client registration, PKCE,
  and refresh, with the token audience bound to the server.
- A per-tool policy with a default derived from the server's annotations.
- Elicitation from a running tool as a card.
- The rule that every call runs as the acting person.
- **Codemode, for OpenAPI documents only.** An OpenAPI integration is one
  Solus tool that runs an agent-written program over the document's
  operations, so a document of a thousand operations adds nothing to the
  prompt and a full result set never enters the model's context. Solus drops
  `resume`, the pending-interaction store, the three elicitation modes, and
  workerd (§5.2). MCP servers do not use it: each upstream tool is one direct
  Solus tool, so the provider's native loop, with parallel calls and retries,
  handles them. Decisions of 2026-10-08.

### What Solus does not take

- **Apps, deployments, and workerd.** Solus governs servers and documents,
  not programs. Only the agent's program runs in the sandbox, and every tool
  call leaves it through the gateway. Authored apps are out of scope.
- **Scoped connections and grants.** Those exist because Executor is an MCP
  server for many clients. Solus has one client, itself.
- **Policy, in the first release.** Allow, ask, and block per tool come
  later (§6). The first release uses the provider's own permission system
  through the existing `requiresApproval` flag.
- **Profiles.** One connection per person per integration in this plan. Several
  accounts for one service (`work`, `personal`) is a later step, named in §9.
- **Effect.** Solus ports the behavior, not the library.

### 1.1 No code per integration

This is a constraint, not a goal. Solus ships one gateway, one probe, one OAuth
flow, and one Settings page. Adding an integration adds a record: a name, a
URL, and an auth kind. It adds no file to the
repository and no release.

The MCP server or the OpenAPI document describes itself, so there is nothing
to write by hand:

| Need | Where it comes from |
|---|---|
| The tools, their names, input schemas, descriptions | `tools/list` |
| Read-only and destructive hints for `requiresApproval` and the later policy | tool annotations |
| How to sign in | the `WWW-Authenticate` challenge, protected-resource metadata (RFC 9728), authorization-server metadata (RFC 8414) |
| The OAuth client | dynamic client registration (RFC 7591) or the client ID metadata document |
| Input a tool needs mid-call | `elicitation/create` |
| Server identity for the connection label | `initialize` |
| An OpenAPI service's operations, schemas, and auth | the document's operations and `securitySchemes` |

The boundary that keeps it generic: Solus implements the MCP authorization
specification and nothing beyond it. Executor's per-service OAuth options
(`scopeSeparator`, `tokenRequestFormat: "json"`, nested token paths, extra
authorization parameters) exist for its OpenAPI apps, which wrap arbitrary
REST APIs. Solus does not wrap REST APIs. A server whose sign-in does not
follow the specification gets `client-required` (an admin enters a client) or
`bearer` (the person pastes a key). It does not get an adapter.

The existing hand-written connections (GitHub, Google, Atlassian, Cloudflare)
stay as they are. No new one is added for a service that has an MCP server or
an OpenAPI document.

## 2. Vocabulary

Use these words everywhere. Do not coin synonyms.

| Term | Meaning | Owner |
|---|---|---|
| **Integration** | One remote MCP server or OpenAPI document a host knows: kind, name, slug, URL, and how it authenticates. A root record with an `organization_id` (`local` or an organization), as every root record (`organization-scope.md` §3). | `packages/server/src/integrations/` (new domain) |
| **Catalog** | The list a person adds an integration from: the public integrations.sh feed, and a URL the person types. Read on demand; never stored. | same |
| **Probe** | The anonymous check of a server: `initialize` and `tools/list` without credentials, then the OAuth metadata its challenge names. Decides `anonymous`, `oauth`, `credentials-required`, or `undetermined`. | same |
| **Connection** | One person's sign-in to one integration. Reuses the word Solus already uses for GitHub, Google, Atlassian, and Cloudflare (`packages/contracts/src/connections.ts`). Status, label, and the identity the server reported. The token is in that person's store, never in the record. | same |
| **Policy** | The integration's rules: a default rule and per-tool overrides. A rule is `allow`, `ask`, or `block`. Later; not in the first release (§6). | same |
| **Gateway** | The server-side MCP client. One upstream session per (integration, person), opened on first use. Lists tools, calls them, relays elicitation. | same |
| **Integration tool** | One Solus agent tool the agent calls. For an MCP server, one per upstream tool, named `<slug>__<tool>`. For an OpenAPI document, one per document, named by its slug, whose input is a program (§5.2). | `execution/agents/tools/integrations/` |
| **Program** | The JavaScript an agent writes for one call of an OpenAPI integration tool. It calls `tools.<group>.<operation>(input)` and `tools.search(...)`, and returns a value. | — |
| **Sandbox** | Where a program runs: an isolate with no network, filesystem, process, or imports. Its only exit is a gateway call. | `integrations/sandbox.ts` |

"Integration" is the user-facing noun. The Settings page is **Integrations**.
The existing `/mcp login` commands keep their name because they act on the
CLI's own servers (§8).

## 3. Catalog

### 3.1 Sources

- **Feed.** `https://integrations.sh/api.json`, the registry Executor reads.
  It is published by UsefulSoftwareCo under the MIT license
  (`github.com/UsefulSoftwareCo/integrations`), served from Cloudflare with a
  four-hour cache, as a versioned envelope `{ version: 1, generatedAt, data }`.
  One record per surface: `id, kind, slug, name, description, icon, domain,
  categories, popularity, connectUrl`, and on a minority `auth` (a kind and a
  header template) and `scopes`. On 2026-10-08 it held 1,314 MCP entries
  (1,302 with a server URL; 285 marked OAuth) and 3,521 OpenAPI entries
  (2,290 with a spec URL, most from the APIs.guru directory). Solus lists
  kinds `mcp` and `openapi` that have a `connectUrl`. GraphQL and CLI entries
  are not shown.
- **Custom URL.** An HTTPS URL without credentials, query, fragment, or
  placeholders, for an MCP server or an OpenAPI document. Same rule as
  Executor's `ImportUrl`.
- **An agent.** `create_integration` writes a record from a service's
  documentation (§9.1). The registry's `/api/<domain>/surface` and `/discover`
  endpoints are sources an agent may read.

The host fetches the feed on request and keeps the last good copy. A feed
whose envelope version is unknown shows "catalog unavailable"; the custom
URL path does not depend on it. A Solus-published daily copy on app.solus.sh,
as `model-profiles.json` is published from `main`, is a later option for
insulation and curation. It is not part of the first release.

For an OpenAPI entry the feed gives the spec URL and little else. The auth
declaration comes from the document's own `securitySchemes`: an API key with
its name and location, HTTP bearer or basic, or OAuth 2 flows with the
authorization URL, token URL, and scopes. The probe reads them (§3.2). An
entry without an OpenAPI document, such as Google Workspace's Discovery
documents, is not added; the hand-written Google connection stays.

### 3.2 Probe

Port `detectMcpAccess` from `packages/catalog/src/implementation/detection.ts`.
The probe records signals (status, media type, challenge scheme, metadata
results), never bodies or URLs. Its result decides the integration's `auth`:

| Probe result | Integration `auth` | What a person does |
|---|---|---|
| `anonymous` | `none` (with `oauth` kept when the server also advertises it) | Nothing. Tools work for everyone. |
| `oauth` | `oauth { discover, registration: 'dynamic' \| 'metadata-document' \| 'client-required' }` | Signs in once, in the browser. |
| `credentials-required` | `bearer` | Pastes an API key, which is stored as their connection. |
| `undetermined` | — | Sees the reason. Can retry. The integration is not created. |

A server with non-standard sign-in lands in `bearer` or `client-required`.
There is no per-server branch in the probe or the flow (§1.1).

For an OpenAPI document the probe fetches and parses the document, counts
operations, and maps `securitySchemes` to `auth`: `apiKey` and `http` become
`bearer` with a binding (header, query, or basic part); `oauth2` with an
authorization-code flow becomes `oauth` with explicit endpoints and
`registration: 'client-required'`; no scheme becomes `none`. A document that
cannot be parsed is reported with the parser's reason and is not created.

The probe runs on the host, with the host's egress. It runs again from the
integration page on request, so a server that gains OAuth later can be
upgraded.

### 3.3 Records

Table `integration`:

```
id, organization_id, kind ('mcp' | 'openapi'), slug, name, url, auth (json),
created_by, created_at, updated_at

A `policy` column is added with §6.2, not before.
```

Table `integration_connection`:

```
integration_id, user_id ('' = the host owner: SQLite NULLs are distinct in a
composite primary key), status
('connected' | 'needs-sign-in' | 'error'), label, info (json: display name,
email, avatar as the server reported), updated_at
```

`slug` is unique per organization and is the tool prefix. The host owner and an
organization admin manage integrations. Any member connects their own account.

## 4. Per-person sign-in

This is the property the plan exists for.

### 4.1 Rules

1. **A connection belongs to one person.** `currentCredentialUserId()` from the
   acting scope (`plans/019-acting-identity.md`) selects it: `null` is the host
   owner's own store; a user ID is that member's. A guest uses their own account,
   as `credentialUserFor` already decides.
2. **No connection, no call.** An integration tool called by a person with no
   connection returns `CONNECTION_REQUIRED` and raises the connect card, as
   `connection_status` does for GitHub today. The agent must not ask for a secret
   in chat.
3. **The token stays on the host.** It is written with the host secret store
   (`platform/secrets.ts`) under `integration-token-<id>-<userId or host>`, and a
   registered client under `integration-client-<id>`, which the desktop
   encrypts with `safeStorage`. It is read only inside the gateway, inside the
   acting scope of the call. It is never sent to a client, never logged, and
   never put in a process environment.
4. **The token goes only to its server.** The gateway sends it in
   `Authorization` to the integration's URL and to nothing else. This is
   Executor's `CredentialHost` rule.
5. **Sign-in state is visible.** The connection card and the Integrations page
   show `connected`, `needs-sign-in` (refresh failed or the server returned 401),
   and `error`, with Reconnect. A refreshed token is saved again under the same
   scope, as `google/oauth.ts` does.

### 4.2 Why the host, not the account vault

GitHub, Google, and Atlassian connections of a member live in the account vault
at app.solus.sh (`plans/010-standard-oauth.md`). MCP tokens differ: the OAuth
client is registered per host origin (dynamic client registration), and the
token audience is the server. The host runs the sign-in, so the host holds the
token. This is the same shape as a seat: a member signs in on each host they
use. It needs no solus-cloud change. A later step can let managed hosts keep a
member's MCP tokens in the vault; that is §9.

### 4.3 The flow

`integrationConnectStart(integrationId)` runs as the caller:

1. Read the integration's `auth`. For `bearer`, return `input: 'token'`; the
   card collects the key and `integrationConnectSubmit` stores it.
2. For `oauth`, resolve the client: a saved registration for this host and
   server, else dynamic client registration, else the client ID metadata
   document, else `client-required` (the admin enters a client ID and secret on
   the integration page).
3. Build the authorization URL with PKCE and `resource` set to the server URL.
   Remember the pending flow with its `ActingScope`, as `startGoogleOAuthFlow`
   does. Return `waiting { flowId, url, input: 'redirect-url' | 'callback' }`.
4. The callback is `/oauth/integration/callback` on the host HTTP server
   (`transport/http.ts`). The redirect base is the origin the client reached the
   host on, as `callbackBaseUrl` works for Google. When the browser cannot reach
   the host, the person pastes the redirect address into the card, as
   `/mcp login` already supports.
5. On success, exchange the code, store the token, run one `initialize` with it
   to read the server's identity, and write the `integration_connection` row.
   Emit `host.integrationAuthFinished` to the clients of that person only.

`integrationDisconnect` removes the token and the row. It does not revoke at the
server unless the metadata names a revocation endpoint.

## 5. Execution environment

### 5.1 The gateway

`packages/server/src/integrations/gateway.ts` holds upstream sessions:

- Key: `(integrationId, credentialUserId)`. Opened on first use with the
  `@modelcontextprotocol/sdk` client over streamable HTTP. Closed after idle
  time and on disconnect.
- `tools/list` is cached per key and invalidated on `notifications/tools/list_changed`.
- A call runs inside the acting scope of the turn (`run-launcher.ts` sets it).
  Its timeout is the call's own, separate from the turn.
- `elicitation/create` from the server becomes a `question_request` with
  `kind: 'mcp_form'` or `'mcp_url'`. Both kinds exist already for Codex
  (`codex-permissions.ts`) and render in `QuestionCard.svelte`. Now both
  providers get the same card, because Solus is the client.

### 5.2 Tools as the agent sees them

Integration tools are Solus agent tools in the `solus` toolbox, selected in
`prompt-dispatch.ts` and wrapped by `credentialScopedAgentTools` like every
other Solus tool. There is no global entry point. The provider's own tool
search is the discovery: Claude defers MCP tool descriptions until tool
search, and Codex uses `deferLoading` (`docs/session-orchestration.md`).

#### 5.2.1 An MCP server: one tool per upstream tool

- **Name** `<slug>__<tool>`. Claude sees `mcp__solus__<slug>__<tool>`; Codex
  sees it in the `solus` namespace. The description is the server's, with the
  integration name in front. `alwaysLoad: false`.
- **Input** is the server's JSON Schema. `executeAgentTool` parses with Zod
  today; the adapter gains a JSON Schema input kind. **Output** is MCP
  content: text as text, images as attachments, `structuredContent` as JSON.
- **The provider's loop runs it.** Parallel calls, retries, and the model's
  own error handling are the provider's. One transcript card per call, as for
  every Solus tool.
- **`requiresApproval`** is set when the server marks the tool
  `destructiveHint: true`. That is the only gate in the first release (§6).
- **The catalog of a session** is the tools of every integration the acting
  person may use, read from the gateway's cached `tools/list` per
  (integration, person). It is built when the run starts and refreshed on
  `integration.changed` and `tools/list_changed`. A person with no connection
  to an OAuth integration still sees its tools; the first call fails with
  `CONNECTION_REQUIRED` and raises the connect card. This is Executor's
  `AppProfileRequired`: visible, not usable.
- **Elicitation** from the server during a call is a `question_request` of
  kind `mcp_form` or `mcp_url`, which `QuestionCard` renders today.
- Disabled Solus tools stay disabled. `solusTools` grows no entry per
  integration tool; removing the integration removes its tools.

#### 5.2.2 An OpenAPI document: one tool per document

Decision of 2026-10-08. An OpenAPI integration is one deferred Solus tool:

- **Name** is the integration's slug, such as `vercel`. `alwaysLoad: false`.
- **Description** is the document's title, its summary, and its tag list, so
  the provider's tool search finds the integration by the service's name.
- **Input** is `{ code }`: a program over that document's operations, run in
  the sandbox. Inside it, operations are `tools.<group>.<operation>(input)`,
  grouped by tag as Executor names them, and `tools.search` and
  `tools.describe` are scoped to the document. This is Executor's codemode,
  ported, without `resume`.
- **The sandbox is an isolate.** No `fetch`, `process`, filesystem, timers
  beyond a budget, or imports. Its only exit is a gateway call. The
  implementation choice is QuickJS compiled to WebAssembly: no native module,
  so it runs in the Electron host and the standalone server alike, with
  memory and time limits and async host functions. Executor's interpreter
  package is a development build and is the fallback.
- **Limits are fixed by the host.** Executor's defaults: 65,536 characters of
  source, 100 gateway calls, 5 minutes, 65,536 bytes of output. A program
  that exceeds one fails with the limit named.
- **The sandbox is not the host boundary.** In `full-access` the agent already
  has Bash on the host. The sandbox keeps credentials out of the program and
  bounds its time and output; nothing more is claimed for it.
- **No rerun.** A failed call fails inside the program, which may continue or
  throw. Solus never reruns a program, because earlier calls may have taken
  effect.
- **`requiresApproval`** is set on the document tool when the document has
  any operation with an unsafe method, in the first release. A finer gate per
  operation is §6.
- **A missing connection** fails the first gateway call with
  `CONNECTION_REQUIRED` and raises the connect card.
- **The transcript shows one card per call**: the program, the returned
  value, and the gateway calls it made in order with outcome and duration,
  which is Executor's `toolCalls` list. Each gateway call is recorded as
  session activity with the acting person, so the audit is per call.
- **The catalog build** compiles one document into one tool, so the size of
  the document never reaches the prompt.

A program that spans two services needs two calls, one per tool, and the
agent joins the results in its own context. That is the cost of this shape.

### 5.3 Not a provider MCP server

Solus could pass the server to the CLI (`mcpServers: { x: { type: 'http',
url, headers } }` for Claude; `config.toml` for Codex). It does not, because
the token would enter the agent process, the two providers would diverge, the
policy could not be checked, and a web or mobile client could not see the
sign-in state. The gateway is one path for both providers and every transport.

## 6. Policy

Decision of 2026-10-08: no policy in the first release. Get the integrations
working, then govern them.

### 6.1 The first release

The only gate is the one every Solus tool has today, the `requiresApproval`
flag, and the provider's own permission system decides what to do with it
(`docs/plans/permission-modes.md`): the provider asks in `supervised`,
`accept-edits`, and `auto`, refuses in `plan`, and runs in `full-access`.
Solus keeps no allow rules of its own, which is that plan's rule unchanged.

| Tool | `requiresApproval` when |
|---|---|
| MCP upstream tool | the server marks it `destructiveHint: true` |
| OpenAPI document tool | the document has an operation with an unsafe method |

"Allow for session" works as it does for every other tool. No settings, no
page, no store.

### 6.2 Later

A policy per integration: `{ default: Rule, tools: Record<toolName, Rule> }`
with `Rule = 'allow' | 'ask' | 'block'`, derived from annotations as Executor
does (`destructiveHint` to `ask`, `readOnlyHint` and safe methods to `allow`),
edited by the host owner or an organization admin, with `block` removing a
tool from every catalog and, for a document tool, refusing the operation
inside a program. Whether `ask` holds in `full-access`, which would make it a
gateway rule rather than a provider rule, is decided then, not now. The
plan-mode read-only refusal inside a program is part of the same step.

## 7. Surfaces

Every entry applies to desktop, web, and mobile. Desktop and web share the
Svelte UI; mobile is a React Native implementation of the same capability.

- **Settings → MCP.** One search over the installed servers and the
  catalog; the catalog as a list that grows as the person scrolls
  (`integrationCatalogList` takes `offset` and answers `{ entries, total }`); a one-step Add that probes, creates, and
  starts the person's sign-in at once (an `undetermined` probe creates
  nothing); tools listed only for an open server or a connected one; one
  integration row (its tools, the OAuth client when
  `client-required`, the person's own connection with Connect, Reconnect,
  Disconnect; the policy editor is §6.2). Store: `integrations.store.svelte.ts`,
  listening to `integration.changed` and `integration.connectionChanged`.
  Mobile: a screen under Host settings, beside Connections.
- **Conversation cards.** Connect needed (reuses the connection card chassis
  with a `browser` or `token` completion), approval (`PermissionCard`), and
  elicitation (`QuestionCard`, kinds `mcp_form` and `mcp_url`). After each,
  focus returns to the input.
- **Command palette.** "Connect <integration>" and "Open integrations".
- **Agent tools.** The integration tools (§5.2). `connection_status` grows an
  `integration` argument, so an agent can ask whether the person is signed in
  and raise the card.
- **Project panel.** Nothing. Integrations are host state, not project state.

## 8. Relation to CLI-configured servers

A server in a seat's `.mcp.json`, Claude settings, or `config.toml` stays the
CLI's. `/mcp login` and `/mcp logout` keep working on those. The Integrations
page lists Solus integrations only. The two can overlap; the agent would see a
tool twice, with different names. The page shows a note when a CLI server with
the same URL is present in the init event (`InitEvent.mcp_servers`, which
Solus reads today but does not forward). `docs/solus-tools.md` changes its
sentence on external MCP servers to say which servers are whose.

## 9. Phases

The first release is phases 1 to 4. Decision of 2026-10-08: OpenAPI is in
the first release.

1. **Catalog, gateway, anonymous MCP servers.** Records, probe, feed, custom
   URL, gateway sessions, one tool per upstream tool in both providers with
   the JSON Schema input kind, `requiresApproval` from `destructiveHint`,
   Settings page on all three clients, elicitation cards,
   `connection_status` growth. Tests: probe decisions from recorded signals,
   the tool name and input adapter, a call carries the acting scope, a
   destructive tool asks in `supervised` and refuses in `plan`, and
   `tools/list_changed` refreshes the catalog.
2. **Per-person OAuth sign-in.** Discovery, registration, PKCE, callback,
   refresh, `needs-sign-in`, the connect card with `redirect-url` input for
   remote clients, `host.integrationAuthFinished`. Tests: a flow remembers its
   acting scope, two people on one host never share a token, a token is sent
   only to its server, a 401 moves the connection to `needs-sign-in`.
3. **Bearer connections and client-required OAuth.** Pasted API keys; an admin
   enters a client for servers without registration.
4. **OpenAPI integrations** (§9.1). The compiler and request builder, the
   sandbox, one program tool per document (§5.2.2) with its transcript card,
   the `securitySchemes` mapping in the probe, explicit OAuth endpoints and
   the six quirk fields in the flow, `create_integration`, operations by tag
   on the integration page. Sandbox tests: a program cannot reach the network
   or the process, every limit fails with its name. Tests: a recorded
   document compiles to the expected operations and schemes, parameter
   serialization styles, a credential binding lands in the right place and
   nowhere else, safe methods default to `allow`.

Later, in this order of demand:

- Policy: allow, ask, block per tool (§6.2).
- Several accounts for one person on one integration (Executor's profiles).
- A shared account an admin connects for a group (Executor's shared account).
- Remembered approvals.
- Stdio servers on the host, with the person's environment from their seat.
- Member tokens in the account vault for managed hosts.
- A Solus-published copy of the feed (§3.1).
- GraphQL as an integration kind.

### 9.1 OpenAPI integrations, sized

Executor's OpenAPI support is about 2,500 lines: a compiler from an OpenAPI
3.x or 2.0 document to operations with input and output schemas, a request
builder that serializes parameters and binds the credential, and the document
loader. Its OAuth options for services that stray from RFC 6749
(`scopeSeparator`, `tokenRequestFormat`, a nested token path, extra
authorization parameters, the token endpoint auth method, `resource`) are six
declarative fields in one flow. Executor does not add OpenAPI services from
its catalog: the user's agent authors the provider and the router, and a
health check validates it. Google Discovery and Microsoft Graph needed real
converters; those stay out.

In Solus this is a second integration kind, still with no code per service:

- The record holds the spec URL, the base URL, an auth declaration as data
  (named methods: pasted fields, or OAuth with explicit endpoints, scopes, and
  the six fields), and credential bindings (which header, query, or basic
  part receives which field).
- The compiler and request builder, standards only, about the size of the MCP
  gateway's server side again.
- Phase 2's OAuth flow learns explicit endpoints beside discovery and treats
  `client-required` as the normal case.
- A `create_integration` agent tool writes the record from the service's
  documentation. The probe fetches the spec, counts operations, and runs one
  safe read with the credential.
- One Solus tool per document, taking a program (§5.2.2).
- The integration page lists operations by tag, with the auth form and the
  client entry, on all three clients.

Maintenance is bounded by the OpenAPI specification (serialization styles,
`oneOf` bodies, multipart, reference cycles), not by the number of services.

## 10. Contracts

New in `packages/contracts/src/rpc.ts`, each with a server handler under
`transport/handlers/integration-handlers.ts`, a preload entry, and both
transports:

```
integrationCatalogList, integrationProbe, integrationList, integrationGet,
integrationCreate, integrationUpdate, integrationRemove,
integrationTools, integrationConnectStart, integrationConnectSubmit,
integrationConnectCancel, integrationDisconnect
```

Events: `integration.changed`, `integration.connectionChanged` (to the
person's clients only), `host.integrationAuthFinished`.

Types in `packages/contracts/src/integration-types.ts`: `Integration`,
`IntegrationAuth`, `IntegrationConnection`, `IntegrationProbeResult`,
`CatalogEntry`. `IntegrationPolicy` and `IntegrationRule` come with §6.2. No
`Record<string, unknown>`.

## 11. Open questions for the maintainers

1. Is one connection per person per integration enough for the first release
   (§1, profiles)? The plan says yes.
2. Should the host owner's integrations be `local` records only, or may an
   organization admin add one that every linked host of the organization
   mirrors? The plan starts with host records and leaves the mirror to the
   organization-scope work.

Decided on 2026-10-08: OpenAPI is in the first release; an MCP server is one
tool per upstream tool; an OpenAPI document is one program tool; no policy in
the first release.

## 12. Phase 1, step by step

The build order for phase 1 (§9), with the files each step touches.

1. **Contracts.** `packages/contracts/src/integration-types.ts`: `Integration`,
   `IntegrationAuth`, `IntegrationProbeResult`, `CatalogEntry`,
   `IntegrationToolSummary`, with Zod schemas for handler parsing. Methods
   `integrationCatalogList`, `integrationProbe`, `integrationList`,
   `integrationGet`, `integrationCreate`, `integrationUpdate`,
   `integrationRemove`, `integrationTools` in `rpc.ts`, plane `execution` in
   `rpc-planes.ts`, signatures in `host-api.ts`, `integration.changed` in
   `host-events.ts`, access levels in `admission/access-policy.ts`, preload
   entries in `apps/desktop/src/preload/index.ts`. No connection methods:
   phase 1 servers are anonymous.
2. **Records.** A migration in `db/migrations.ts` for the `integration` table
   (§3.3, without the connection table).
   `packages/server/src/integrations/integration-store.ts` through
   `data/scope.ts`.
3. **Catalog and probe.** `integrations/catalog.ts` fetches the feed (§3.1)
   with a timeout and no redirects, validates the version 1 envelope, keeps the
   last good copy, filters to MCP entries with a URL. `integrations/probe.ts`
   ports Executor's detection (§3.2). The server declares
   `@modelcontextprotocol/sdk` as its own dependency.
4. **Gateway.** `integrations/gateway.ts`: one client session per
   `(integrationId, credentialUserId)` over streamable HTTP, opened on first
   use, closed after idle time; `tools/list` cached per key and dropped on
   `tools/list_changed`; `call` runs under the acting scope the turn set;
   `elicitation/create` becomes a `question_request` of kind `mcp_form` or
   `mcp_url` through the tool context's `emit`. The cache is warmed at create,
   probe, and boot, because step 6 reads it synchronously.
5. **Tool adapter.** `integrations/integration-tools.ts` makes one `AgentTool`
   per cached upstream tool (§5.2.1). The input bridge: `AgentTool.inputFields`
   is a Zod field map and both providers derive JSON Schema from it, so the
   upstream JSON Schema is converted with `z.fromJSONSchema` and its object
   shape taken. A schema that does not convert gets a loose object and a flag
   that makes `executeAgentTool` pass the input through unchanged. Output maps
   MCP content to `AgentToolResult`: text joined, the first image as the
   result image, `structuredContent` as JSON text.
6. **Into the session.** The two places that assemble a run's tools,
   `selectAgentTools` in `prompt-dispatch.ts` and the full-toolbox restore for a
   queued run in `run-scheduler.ts`, add the integration tools the acting person
   may use, from the gateway cache. `credentialScopedAgentTools` in
   `run-launcher.ts` already scopes every tool. Both provider adapters already
   defer and name them. `solusTools` is untouched.
7. **Settings on three clients.** Desktop and web: `SettingsTabIntegrations.svelte`
   and `integrations.store.svelte.ts`, shaped like `solus-tools.store.svelte.ts`,
   watching `integration.changed` and reloading on reconnect; list, add from
   catalog or URL with the probe result shown before create, one integration's
   tools; registered in `settings-search.ts`. Mobile: `IntegrationsScreen` under
   Host settings beside Devices, with `use-integrations.ts`.
8. **Tests** in `tests/unit/integrations/` against a fake MCP server over HTTP:
   probe decisions from recorded signals; the tool name and input bridge,
   including a schema that does not convert; a gateway call carries the acting
   scope and two people get two sessions; a destructive tool asks in
   `supervised` and refuses in `plan`; `tools/list_changed` refreshes the next
   catalog.
9. **Docs.** `docs/solus-tools.md` (the sentence on external servers) and
   `docs/integrations.md` (the page).

End-to-end check: add DeepWiki from the catalog, ask a Claude session and a
Codex session to call one of its tools, and see parallel calls under the
provider's own loop with one card each.
