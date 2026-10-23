# MCP integrations: catalog, gateway, and policy

Status: phases 1 to 3 implemented in the working tree on 2026-10-08 (§12);
phase 4 not started. OpenAPI is in the first release and policy is not
(§9, §6). §13 (connecting with less setup) was decided on 2026-10-22 and is
not started. This plan takes the model of
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

Correction of 2026-10-22: on 2026-10-13 (commit `27f130b9` on `v2`) Executor
stopped reading integrations.sh. Its catalog is now its own feed,
`https://catalog.executor.sh/index.json`: 1,839 vetted app packages, each the
TypeScript source of one service (provider, curated tools, and tools generated
from OpenAPI). Gmail, Zoom, and HubSpot are such packages, not MCP entries.
Solus keeps the integrations.sh feed (§3.1) and does not run Executor's app
code (§13). The table above describes Executor before that change.

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
- **Profiles.** Executor's profile is a choice of accounts per app. Solus does
  not take that object. Several accounts for one person on one integration
  (`Work`, `Personal`) are §13.3, as extra connections, not as profiles.
- **Effect.** Solus ports the behavior, not the library.

### Manual OAuth client setup (2026-10-22)

Every OAuth integration offers **Use your own OAuth app**, including servers
that advertise automatic registration. Manual setup shows the full host
callback URL and takes a client ID and optional secret. Saving a client selects
host sign-in on desktop, web, and mobile, since the host holds that client's
secret. Removing the client restores automatic setup when available. A pending
sign-in is cancelled when the client changes. Registration errors distinguish
callback refusal, registration restrictions, invalid responses, and temporary
service failures. A provider error page that does not return to Solus cannot
update the form; manual setup remains available while it waits.

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

The existing hand-written connections (GitHub, Google, Atlassian)
stay as they are. No new one is added for a service that has an MCP server or
an OpenAPI document.

Exception of 2026-10-22: for a service that has no usable MCP server, Solus
writes its own MCP server, in this repository (§13.6). It is still an MCP
server behind the same gateway, not a new kind of connection. Google is first.

## 2. Vocabulary

Use these words everywhere. Do not coin synonyms.

| Term | Meaning | Owner |
|---|---|---|
| **Integration** | One remote MCP server or OpenAPI document a host knows: kind, name, slug, URL, and how it authenticates. A root record with an `organization_id` (`local` or an organization), as every root record (`organization-scope.md` §3). | `packages/server/src/integrations/` (new domain) |
| **Catalog** | The list a person adds an integration from: the public integrations.sh feed, and a URL the person types. Read on demand; never stored. | same |
| **Probe** | The anonymous check of a server: `initialize` and `tools/list` without credentials, then the OAuth metadata its challenge names. Decides `anonymous`, `oauth`, `credentials-required`, or `undetermined`. | same |
| **Connection** | One person's sign-in to one integration. Reuses the word Solus already uses for GitHub, Google, and Atlassian (`packages/contracts/src/connections.ts`). Status, label, and the identity the server reported. The token is in that person's store, never in the record. | same |
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
URL path does not depend on it. The Solus catalog (§13.5) adds the servers the
feed does not list.

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
integration_id, user_id (the person's user key, the host's owner included),
status
('connected' | 'needs-sign-in' | 'error'), label, info (json: display name,
email, avatar as the server reported), updated_at
```

`slug` is unique per organization and is the tool prefix. The host owner and an
organization admin manage integrations. Any member connects their own account.

## 4. Per-person sign-in

This is the property the plan exists for.

### 4.1 Rules

1. **A connection belongs to one person.** `currentPersonKey()` from the
   acting scope (`plans/019-acting-identity.md`) selects it. It is always a
   person's user key (`ownerKeyOf`, the acting scope's `personKey`): a member's account, and the host's
   owner as the host's user (`local:<id>`, or their account once the host is
   linked). There is no host-wide connection, so a host with no owner (a managed
   host) works the same as a personal one. A guest is their own guest key,
   so they hold no connections and get the connect card. `null` is only
   the host's own work, which has no person: it lists a server anonymously and
   holds no connection. Linking and unlinking the host move the owner's records,
   connections, and tokens with their key (`host-user-rows.ts`).
   These keys are separate from `currentCredentialUserId()`, where `null` still
   means the host's own GitHub, Google, and Atlassian logins.
2. **No connection, no call.** An integration tool called by a person with no
   connection returns `CONNECTION_REQUIRED` and raises the connect card, as
   `connection_status` does for GitHub today. The agent must not ask for a secret
   in chat.
3. **The token stays on the host.** The vault (`vault/vault.ts`,
   `docs/plans/access-model.md` §2.6) writes it with the host secret store
   (`platform/secrets.ts`) under `integration-token-<id>-<base64url(person key)>`,
   unless the person's account holds the connection (plans/020 §5). A
   registered client is under `integration-client-<id>`. The desktop
   encrypts both with `safeStorage`. It is read only inside the gateway, inside the
   acting scope of the call. It is never sent to a client, never logged, and
   never put in a process environment.
4. **The token goes only to its server.** The gateway sends it in
   `Authorization` to the integration's URL and to nothing else. This is
   Executor's `CredentialHost` rule.
5. **Sign-in state is visible.** The connection card and the MCP page
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

- Key: `(integrationId, personKey)`. Opened on first use with the
  `@modelcontextprotocol/sdk` client over streamable HTTP. Closed after idle
  time and on disconnect.
- `tools/list` is cached per key and invalidated on `notifications/tools/list_changed`.
  Nothing is listed at boot. A run lists its person's tools when it starts
  (`run-launcher.ts` → `integrationAgentTools(actor)`), with that person's
  connection, so a typed, queued, restored, or agent-started run gets the same
  tools. A server that does not list in 10 seconds adds no tools to that run;
  the list goes on, and the next run reads it.
- A call runs inside the acting scope of the turn (`run-launcher.ts` sets it).
  Its timeout is the call's own, separate from the turn.
- `elicitation/create` from the server becomes a `question_request` with
  `kind: 'mcp_form'` or `'mcp_url'`. Both kinds exist already for Codex
  (`codex-permissions.ts`) and render in `QuestionCard.svelte`. Now both
  providers get the same card, because Solus is the client.

### 5.2 Tools as the agent sees them

Integration tools are Solus agent tools in the `solus` toolbox, added at launch
in `run-launcher.ts` and wrapped by `credentialScopedAgentTools` like every
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

Decision of 2026-10-14: one per-tool rule ships now, on or off. An
integration record carries `disabledTools`, the upstream tool names its owner
turned off (an off list, so a tool the server adds later is on).
`integrationAgentTools` leaves them out of every catalog, and the gateway
refuses a call to one, so a run built before the change cannot use it.
`integrationUpdate` takes the whole list; `mayChange` decides who edits it,
as for a rename. A change keeps the upstream session. This is the `block`
rule of §6.2 alone, without `ask` and without derived defaults.

Decision of 2026-10-22: the list is in the agent profile entry
(`plans/020-agent-profile.md`). An integration is personal (D3), so a switch is
its owner's choice and follows them to every host.

Beside it, the only gate is the one every Solus tool has today, the `requiresApproval`
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
  catalog; a rail of views (All, Installed, and the Solus categories of
  `CATALOG_CATEGORIES`, which `integrationCatalogList` filters by `category`)
  that is a chip row in a narrow page; the catalog as a two-column list that
  grows as the person scrolls (`integrationCatalogList` takes `offset` and
  answers `{ entries, total }`); a connect dialog that probes and creates a
  new server (an `undetermined` probe creates nothing), takes the OAuth
  client when `client-required`, runs the sign-in, and then takes the tools
  to keep on, and takes back a server it added when closed before the end;
  tools listed only for an open server or a connected one; one integration
  row (its tools with their on/off switches, the OAuth client when
  `client-required`, the person's own connection with Connect, Reconnect,
  Disconnect). The page uses a wider measure than the 48rem settings column. Store: `integrations.store.svelte.ts`,
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

- Connecting with less setup (§13): the agent's connect tool, the probe
  hand-off, several accounts, first-party clients.
- Policy: allow, ask, block per tool (§6.2).
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
   (§1, profiles)? The plan says yes. Several accounts follow in §13.3.
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

## 13. Connecting with less setup

Decisions of 2026-10-22. The aim: a person who asks for Gmail, Zoom, or
HubSpot gets a working connection in as few steps as the service allows, from
the conversation or from Settings, with Claude and with Codex. These four
steps take the useful parts of Executor's connect flow
(`apps/docs/content/connect-an-account.mdx` on `v2`). They do not take its
app packages (§0).

**Every connector goes through the Solus gateway.** The server holds the
token, and Claude and Codex get the same integration tools (§5.2). A
provider's own connectors, such as the claude.ai connectors a Claude session
sees, are not a way in: Codex does not have them. Decision of 2026-10-22:
Solus does not use them. A service a person wants in Solus comes through the
gateway, for Claude and Codex alike. Turning them off in the Claude sessions
Solus starts needs the Claude Code setting that controls them; find it and
record it here before that change.

The order of work, the build steps, and the status of each part are in
`connect-with-less-setup.md`. This section is the design it builds.

### 13.1 The client chain

Status on 2026-10-23: steps 1 to 3 below work, and first-party clients for
GitHub and Google work on the host path (`connect-with-less-setup.md`, step 6).

Most business services run an MCP server but do not let an unknown client
register (no RFC 7591). On 2026-10-22, Zoom (`mcp.zoom.us`) and HubSpot
(`mcp.hubspot.com`) published no `registration_endpoint`; Asana did. Those
servers are `client-required`, and the client, not the tools, is the work.

`clientFor` in `integrations/oauth.ts` resolves a client in this order today:

1. A saved client registered for this callback.
2. The owner's client on the integration record (§1, manual setup).
   Correction of 2026-10-22: an integration is personal (access-model D3), so
   its owner enters this client, and it serves only that owner. There is no
   organization-wide client today. A client that an admin enters once for
   every member needs shared integrations or an organization client record;
   that is a separate decision, not part of this step.
3. A new dynamic registration.
4. Refusal with `OAUTH_CLIENT_REQUIRED_MESSAGE`.

Add one step between 2 and 3:

- **A first-party client.** An OAuth app that Solus registers with a vendor
  (Google, Microsoft, Zoom, HubSpot, Slack). It is defined in code, in
  `first-party-clients.ts` in `@solus/contracts`: id, label, authorization and token
  endpoints, `allowedScopes`, and the hosts its token may go to. Only its
  credentials are configuration. It is offered for an integration only when
  the discovered endpoints equal its endpoints and every requested scope is in
  `allowedScopes`. A token response with a scope outside `allowedScopes` is
  refused. The token goes only to the listed hosts (§4.1 rule 4). This is
  Executor's `FirstPartyOAuthClient`
  (`apps/hosted/server/src/implementation/first-party-oauth.ts`).

The owner's client stays ahead of the first-party client: an explicit choice
wins. A server with dynamic registration does not need a first-party client,
so the order between steps 3 and the new step matters only when a vendor has
both; then the vendor-verified client wins, because its consent screen names
Solus.

**Where a first-party client runs.** Decision of 2026-10-22: it follows the
rule every credential follows today (`plans/020-agent-profile.md` §5.1). Not
signed in, or sync off: the host holds the token and refreshes it. Signed in
with sync on: the account vault holds it and the cloud refreshes it. There is
no separate rule per vendor. A vendor that offers only a confidential web app
with fixed HTTPS redirect addresses (Zoom, HubSpot, Slack) cannot run on a
host, because its secret cannot ship in a build; its first-party client exists
only on the signed-in path. Tool calls never pass through the cloud: they go
from the host to the vendor.

**Vendor work outside the code.** Each first-party client needs the vendor's
review: Google app verification (Gmail scopes are restricted and also need an
annual security assessment), Microsoft publisher verification, the Zoom App
Marketplace, the HubSpot app listing, and the Slack Marketplace for use
outside one workspace. Start these first. They take weeks, and they gate this
step, not the code.

**The interface: one registry, no screen per vendor.** A first-party client
is one entry in a code-defined registry, `first-party-clients.ts` in
`@solus/contracts`, so the host, the cloud, and the clients read the same
list. Only the client ID and secret are configuration, and they live in the
cloud only. An entry:

```ts
{
  id: 'github',
  label: 'Solus for GitHub',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  allowedScopes: ['repo', 'read:org', 'gist', 'project'],
  authorizationParams: {},          // Google: { access_type: 'offline', prompt: 'select_account consent' }
  tokenHosts: ['api.githubcopilot.com'],
}
```

It is matched automatically, never chosen by a person: when the endpoints an
integration's discovery returns equal an entry's endpoints and every
requested scope is in `allowedScopes`, sign-in uses the entry. Requested
scopes outside `allowedScopes` are left out; a token response that reports
one is refused. The connect dialog and the card then show "Sign in with
Solus for GitHub" and no client form. Nothing else in the UI changes, on
desktop, web, and mobile.

**A service with no Solus client** keeps the generic path, as Executor does:
the owner's client form (§1, "Manual OAuth client setup"), the callback URL to
copy, the vendor's help link (§13.5 `authHelp`), and the agent hand-off
(§13.4). Executor has no client for Salesforce, Zoom, or HubSpot either. Its
Salesforce app says "the org's External Client App supplies the client", and
its Zoom and HubSpot apps say the connect page asks for the person's own OAuth
app. Its own first-party clients are three: GitHub (a GitHub App), Google
(verified, 35 scopes), and Slack (unlisted, because Slack allows MCP outside
one workspace only for apps in the Slack Marketplace). Its definitions are MIT
code and a template for ours. Its clients, secrets, and verification belong
to Executor and cannot be reused.

**The first first-party clients are the ones Solus already owns.** Solus ships
OAuth clients for GitHub, Google, and Atlassian (`SOLUS_GITHUB_CLIENT_ID`,
`SOLUS_GOOGLE_CLIENT_ID`, and the Atlassian client) for its hand-written
connections. They come before any new vendor registration:

1. **GitHub.** GitHub's MCP server (`https://api.githubcopilot.com/mcp/`)
   names `https://github.com/login/oauth` as its authorization server, which
   has no dynamic registration, so today a person who adds it brings their own
   client. Its supported scopes include every scope Solus's GitHub client asks
   for (`repo`, `read:org`, `gist`, `project`; checked 2026-10-22). Registered
   as a first-party client, a person connected to GitHub in Solus signs in to
   GitHub's MCP server with one click.
2. **Google.** Status on 2026-10-22, from the Google Cloud console: branding
   is verified; Data Access declares one scope, `drive.file` (non-sensitive),
   so no data-access review has been needed. The build also asks for
   `drive.readonly` (`contracts/google-auth.ts`), which is restricted and not
   declared. A user who grants it sees Google's unverified-app warning. Fix it
   in the console, not in code or GitHub: Google Auth Platform → Data Access →
   Add or remove scopes. Add `drive.readonly` and the Calendar and Gmail scopes
   §13.6 needs, then submit one review from the Verification Center. The
   restricted scopes bring the annual security assessment, which Solus
   accepted. The GitHub secrets `SOLUS_GOOGLE_CLIENT_ID` and
   `SOLUS_GOOGLE_CLIENT_SECRET` (`release.yml`, `release-server.yml`) only
   choose which client a build embeds; confirm they name this project's
   client.
3. **Atlassian.** Check how Atlassian's MCP server accepts clients before
   adding it.

Then new registrations, in order of demand: Microsoft, Zoom, HubSpot, Slack.

The client ID metadata document (`registration: 'metadata-document'`) is in
the contract but not implemented. It needs a public HTTPS document whose
redirect addresses cover every host. It is not part of this step.

### 13.2 A connect card the agent starts

Today a call to an installed integration without a connection returns
`CONNECTION_REQUIRED` and raises the connect card (`gateway.ts`
`connectionRequired`), and `connection_status` takes `integration`. An agent
cannot connect a service that is not installed yet.

Status: implemented on 2026-10-22 (`integrations/connect-integration-tool.ts`,
`integrations/integration-create.ts`; tests in
`tests/unit/integrations/connect-integration-tool.test.ts`).

Add the agent tool `connect_integration({ service })`:

1. Find an installed integration by slug or name. If one is found and the
   person is connected, return its status. If the person is not connected,
   raise the connect card (`askToConnect`) and return
   `waiting for the person to connect`.
2. Else search the catalog (`IntegrationCatalog.list`) and return at most five
   matches when the name is not exact. The agent asks the person which one,
   in text.
3. For one chosen entry: if the person already has an integration with the
   same URL, use it. Else probe the entry and create it as the acting person's
   own integration, through the same `createIntegration` as Settings, then
   raise the connect card. Integrations are personal (D3), so any person may
   add one; a turn that acts for no person adds nothing.
4. `client-required`: the card shows the integration's OAuth client form
   above the connect form. Only the owner's list holds the integration, so
   only the owner sees the form. Connect stays disabled until the client is
   saved.

Rules: the tool never takes a secret, never returns a token, and never
completes a sign-in itself; the person finishes in the browser or in the card.
The turn does not wait on the card. After `host.integrationAuthFinished`,
the next run lists the new tools (§5.1). The card is the existing connect card
chassis on desktop, web, and mobile. After it closes, focus returns to the
input. The tool is a Solus agent tool, so Claude and Codex get the same one.
`requiresApproval` is set, because it can create a host record.

### 13.3 Several accounts for one integration

Status: implemented 2026-10-23 on the host; an added account stays on its host,
and Rename is not built (`connect-with-less-setup.md`, step 5).

One person may connect more than one account to one integration, such as
`Work` and `Personal` Gmail.

- **Records.** `integration_connection` gains `account_id`, and its key becomes
  `(integration_id, user_id, account_id)`. Existing rows get `default`. The
  label defaults to the identity the server reported (an email) and can be
  renamed. The token key gains the account:
  `integration-token-<id>-<base64url(person key)>-<account id>`.
- **Gateway.** The session key becomes `(integrationId, personKey, accountId)`.
- **Tools.** The tool list stays one set per integration, listed with the
  first connected account. When the person has more than one account, each
  tool gains an optional `solus_account` input (the label). A tool the server
  marks `readOnlyHint: true` runs for every account when `solus_account` is
  omitted, and the result names the account of each part. Any other tool
  needs `solus_account`, and a call without it fails with the list of labels. This
  is the rule Executor's Gmail app uses: reads span accounts, writes name one.
- **Surfaces.** The integration row lists the person's accounts with Rename,
  Reconnect, and Disconnect each, and "Add another account". The connect card
  connects a new account only from "Add another account", never by accident.
  Desktop, web, and mobile.
- **Contracts.** `integrationConnectStart` and `integrationDisconnect` take
  `accountId`; `integrationConnectionRename` is new;
  `IntegrationConnection` gains `accountId`. `integration.connectionChanged`
  carries it.

### 13.4 The probe hands setup to the agent

Status: implemented 2026-10-22 (`connect-with-less-setup.md`, step 1).

When the probe cannot connect a custom URL by itself, the person often does
not know what to do next. Executor returns `agent_setup_required` with steps
an agent can follow (`packages/catalog/README.md`).

Add a hand-off for these probe results:

| Probe result | Hand-off |
|---|---|
| `credentials-required` (`bearer`) | Find where the service issues an API key, and how. |
| `oauth` with `client-required` | Find the service's OAuth app settings, the callback URL to register (shown in the dialog), and the scopes. |
| `undetermined`, reason `refused`, `oauth_unusable`, or `not_mcp` | Read the service's documentation for its MCP endpoint and how it signs in. |

`undetermined` with `unavailable`, `timeout`, or `redirected` gets Retry only.

The hand-off is a button in the connect dialog, **Set up with an agent**. It
opens a new conversation tab with a prompt filled in: the service name, the
URL, the probe signals (§3.2), and the steps above. The prompt tells the agent
to never ask for a secret in chat, and to send the person back to Settings →
MCP, or to call `connect_integration`, when the key or client is ready.
`connect_integration` returns the same steps when its probe gives one of these
results. Desktop, web, and mobile.

**Guided setup.** Part of it exists: the connect card shows the OAuth client
form (§13.2), and manual setup shows the callback URL to copy. This step adds
the agent hand-off. A Solus catalog entry's `authHelp` (§13.5) adds a link to
the vendor's own page for creating the client or the key, shown in the
dialog and in the card.

### 13.5 The Solus catalog

Status: implemented 2026-10-23 (`connect-with-less-setup.md`, step 2).

A list of MCP servers that the integrations.sh feed does not list, published
by Solus. Example: Cloudflare's whole-API server, `https://mcp.cloudflare.com/mcp`.
The feed lists only `bindings.mcp.cloudflare.com`, and the pull request that
adds it (`UsefulSoftwareCo/integrations#91`) has been open since 2026-10-08.

- **Where it lives.** `packages/contracts/src/integration-catalog.json`, with
  its schema in `integration-catalog.ts`. The file on `main` is the published
  list: an entry ships by merging it, not by a build. A host reads it on
  request, as it reads the feed, and keeps the last good copy for four hours;
  when it cannot read it, it uses the copy its build shipped with. Implemented
  2026-10-23 in `integrations/catalog.ts`; no disk cache and no timer, because
  the catalog is only read when a person opens it.
- **An entry** has the fields of `CatalogEntry` and the pages that prove it.
  The first two entries:

  ```json
  [
    {
      "id": "cloudflare-api",
      "kind": "mcp",
      "name": "Cloudflare API",
      "description": "The whole Cloudflare API (DNS, Workers, R2, Zero Trust) through search and execute tools. Sign in with OAuth.",
      "domain": "cloudflare.com",
      "categories": ["code"],
      "url": "https://mcp.cloudflare.com/mcp",
      "authHelp": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
      "sources": [
        "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
        "https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp"
      ]
    },
    {
      "id": "salesforce-records",
      "kind": "mcp",
      "name": "Salesforce",
      "description": "Read, create, and update Salesforce records as the signed-in user. Your org's admin creates an External Client App first.",
      "domain": "salesforce.com",
      "categories": ["productivity"],
      "url": "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
      "authHelp": "https://help.salesforce.com/s/articleView?id=xcloud.external_client_apps.htm",
      "sources": ["https://api.salesforce.com/platform/mcp/v1/platform/sobject-all"]
    }
  ]
  ```

  Salesforce runs four hosted servers on one host: `sobject-all` (records),
  `invocable-actions`, `flows`, and `api-catalog`, all under
  `https://api.salesforce.com/platform/mcp/v1/platform/`. The feed knows that
  Salesforce has hosted MCP servers but gives no URL, so it does not list them
  (checked 2026-10-23). Start with records; add the other three as entries of
  their own when people ask. Sign-in asks for `mcp_api` and `refresh_token`.
  Salesforce's OpenID metadata publishes a registration endpoint, so the probe
  decides `dynamic` (checked 2026-10-23); an org that does not allow it refuses
  the registration, and the person's own client (the org's External Client
  App) takes over through manual setup.
  The entry's sources and `authHelp` are confirmed by the probe and the
  vendor's documentation before it merges.

  `categories` are Solus category ids (`CATALOG_CATEGORIES`), not feed names.
  An entry has no auth fields: the probe reads the server's challenge and
  metadata when a person adds it (§3.2). `authHelp` is optional.
- **Listing.** `integrationCatalogList` merges the two sources. A Solus entry
  is listed first, with a Solus mark, and `CatalogEntry` gains
  `source: 'feed' | 'solus'`. When a feed entry has the same URL, the Solus
  entry replaces it. Adding one is the same probe and `createIntegration` as a
  feed entry. `connect_integration` finds Solus entries, because it reads the
  catalog. The Settings catalog shows them on desktop, web, and mobile with no
  other change.
- **Many entries.** One file, sorted by id, until it grows to hundreds; then
  one file per entry with a generated index. A validator test
  (`tests/unit/integration-catalog.test.ts`) checks the schema, sorted and
  unique ids, unique URLs, an HTTPS URL, and at least one source, and flags
  an entry whose URL the feed now lists, so the copy is deleted when upstream
  merges it.
- **Who adds entries.** Agents, as the Cloudflare pull request was written:
  fetch the vendor's documentation, probe the server (`initialize`, then the
  metadata its challenge names), and put that evidence in the pull request.
  A scheduled check probes every entry and reports the ones that stop
  answering.
- **`codemode=false` and this server.** `MCP_QUERY_DEFAULTS` in
  `integrations/catalog.ts` adds `codemode=false` to every
  `mcp.cloudflare.com` URL, a rule copied from Executor, which runs code
  itself. Checked 2026-10-22: only the whole-API server reads the parameter
  (`cloudflare/mcp` README, "Disable Code Mode"); the product servers
  (`bindings.`, `docs.`, and the others in `cloudflare/mcp-server-cloudflare`)
  do not. With it, the whole-API server registers one tool per endpoint,
  about 2,500 tools; without it, `search`, `execute`, `docs`, and `whoami`,
  about 1,000 tokens. Solus registers one Solus tool per upstream tool, so the
  rule must go. The PostHog rule (`mode=tools`) stays: without it PostHog
  wraps every tool in one `exec` tool, which hides the per-tool switches and
  approval (§6.1).

### 13.6 Solus MCP servers for services with none

Status: the framework and Google Calendar implemented 2026-10-23
(`connect-with-less-setup.md`, step 3). The rest of the Google suite
implemented 2026-10-23: Gmail, Drive, Docs, Sheets, Slides, Forms, Tasks,
Contacts, Meet, and Search Console. Decision of 2026-10-23: one server per
product, not one Google Workspace server, so each sign-in asks only for its
product's scopes; all ship at once, with Google's verification handled
outside the code. Each is a `GoogleSolusServer` (`solus-servers/google.ts`),
which adds Google's sign-in and labels the account by its userinfo email.

Decision of 2026-10-22: for a service with no usable MCP server, Solus writes
its own MCP server. Google Workspace first, then Microsoft 365. Google's Gmail
MCP server is a gated preview that cannot send mail, and the feed has no
Microsoft 365 server.

- **It is an MCP server.** It runs in the host process, and the gateway opens
  a session to it over the SDK's `InMemoryTransport` instead of streamable
  HTTP (`gateway.ts`, `open`). Everything after `open` stays as it is: one
  session per (integration, person), `CONNECTION_REQUIRED`, elicitation,
  `disabledTools`, `requiresApproval` from `destructiveHint`, and the tools
  Claude and Codex see (§5.2).
- **Its network access.** A server reaches only its vendor's API hosts, with
  the person's token, through one fetch that refuses other hosts and
  redirects. It reads the token through `IntegrationCredentials` on each
  request, so a refreshed token needs no new session.
- **Its auth.** Declared in its code: endpoints and scopes. Google publishes no
  dynamic registration, so a person enters their own Google client (step 2
  of §13.1) until the Solus Google client exists (first-party, §13.1). The
  hand-written Google connection stays for Drive features in Works.
- **Records.** An integration of kind `solus` with the server's id, in place
  of a URL. The agent profile entry carries the id (plan 020). A host whose
  build lacks the server keeps the entry and reports it as skipped.
- **Order.** Google Calendar first, then the rest of the suite at once
  (above). Decision of
  2026-10-22: Solus accepts Google's restricted-scope review and the annual
  security assessment for Gmail. Microsoft Outlook and Calendar follow
  Microsoft publisher verification.
- **Retire it** when the vendor ships a usable MCP server: move the records
  to a Solus catalog entry (§13.5) for that server.
- Tests run against recorded responses, with no live credential.
