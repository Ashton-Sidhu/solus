# 032 One request client

Status: PARTLY BUILT (2026-11-03), not committed. Built: D1; D3 for the four web
copies in `client-core`; D5 except `probeServer`; D7. Waiting: D3 for desktop and mobile
(§4 step 2). Dropped after reading the code: D4 and D6 (see each).

There are no users, so no step keeps an old shape working. Each step deletes the
copies it replaces in the same change.

## 1. Problem

Solus makes HTTP requests to two kinds of server outside the typed RPC layer:

- **The Solus cloud** (`solus-cloud`: the account plane and the Solus API).
- **Another Solus host**, for the few calls that come before or beside a socket.

Each caller writes its own request: it gets a token, sets `authorization`, sets
`accept` and `content-type`, encodes the body, sets a timeout, catches the network
error, and reads a 401. The copies already differ:

| Copy | Timeout | `credentials: 'omit'` | `cache: 'no-store'` | 401 |
|---|---|---|---|---|
| `client-core/src/settings-requests.ts` `webSettingsRequests` | 15 s | yes | yes | caller |
| `client-core/src/agent-profile-requests.ts` `webAgentProfileRequests` | 15 s | yes | no | caller |
| `client-core/src/account-documents.ts` `webAccountDocumentSend` | 15 s | yes | no | decoded as signed-out |
| `client-core/src/cloud-account.ts` `webCloudAccount` `call` | 15 s | yes | no | caller |
| `client-core/src/uplink-session.ts` `webUplinkAccountSource` `call` | 8 s | yes | no | caller |
| `apps/desktop/src/main/account/account-session.ts` cloud request | none | no | no | caller |
| `apps/mobile/src/features/account/account-client.ts` `accountRequest` | 15 s | no | no | `onUnauthorized()` |

On the server, five owners call the Solus API with the host's control token, each
with its own `directoryUrl` join, timeout, and 401/404 reading:
`host/organizations.ts`, `host/host-registration.ts`, `host/managed-host-activity.ts`,
`host/live-activity-relay.ts`, `transport/uplink/link.ts`.

To another host:

- `/auth/refresh` twice: `client-core/src/ws-transport.ts` `refreshSessionToken` and
  `server/src/execution/orchestration/introduced-hosts.ts` `exchange`.
- `/health` three times: `client-core/src/host-link.ts` `readHostHealth`,
  `apps/client/src/lib/connect.ts` `probeServer` (its own schema), and
  `introduced-hosts.ts` `probe`.

## 2. What is not a problem

Found while writing this plan; these stay as they are.

- **Host RPC.** `HostApi` over Electron IPC or `WsTransport` is already the one
  typed client for a host (`packages/contracts/src/rpc.ts`). This plan does not
  route it through HTTP.
- **Google token refresh** already uses `google-auth-library` `OAuth2Client`
  (`server/src/google/oauth.ts`).
- **MCP OAuth** is one class, `McpOAuth` (`contracts/src/integrations/oauth-protocol.ts`),
  that a host and `solus-cloud` both run. It covers discovery, registration, PKCE,
  `resource`, the code and refresh grants, and revocation, with HTTPS checks and
  messages a person can act on.
- **GitHub** uses Octokit through `providers/github/octokit.ts`.
- **Delegations and the host credential** (`sync/delegations.ts`,
  `host/host-credential.ts`) send RFC 8693 token exchange and client credentials
  with one shared `private_key_jwt` assertion (`HostCredential.assertion`). Each
  is one request with its own refusal rules.
- **The cloudflared readiness poll** (`transport/uplink/connector.ts`) and local
  blob reads in the UI (`ArtifactView.svelte`, `attachment-download.ts`) are not
  API calls.

## 3. Decisions

### D1 One request core in `client-core`

`packages/client-core/src/http-request.ts`, with no Node or DOM import beyond
`fetch`, so the server can import it too:

```ts
export type HttpResult =
  | { kind: 'response'; response: Response }   // any status, including 401 after one retry
  | { kind: 'signed-out' }                       // the token source had no token
  | { kind: 'unreachable' }                      // network error or timeout

export interface HttpClientOptions {
  baseUrl: string
  token?: (options: { refused?: string }) => Promise<string | null>  // absent: no credential
  timeoutMs?: number                             // default 15_000
  fetch?: typeof fetch
}

export function httpClient(options: HttpClientOptions): {
  request(path: string, init?: { method?: string; body?: unknown; headers?: HeadersInit; signal?: AbortSignal }): Promise<HttpResult>
}
```

Rules, in one place:

- `accept: application/json`; `content-type: application/json` and
  `JSON.stringify` when `body` is not `undefined`.
- `credentials: 'omit'`, `cache: 'no-store'`.
- A 401 asks the token source again with `refused` set to the token just sent,
  which is the option `OAuthSession.accessToken` and `WebTokenSession.accessToken`
  already take, and retries once with a different token. A second 401, or no
  different token, is returned as a response; the caller's decoder reads it.
- The caller's `signal` and the timeout both abort the request.

The core does not decode bodies. Decoding stays with the route table that owns
the schema (D2).

### D2 Routes and schemas stay in their contracts

`contracts/src/account-documents.ts` (`ACCOUNT_DOCUMENTS`) is already a table of
cloud routes with their schemas. The other account routes join that pattern
rather than a new `cloud-api.ts`: settings, agent profile, account, and the host
directory each keep their decoder, and each takes an `httpClient` in place of its
own `send`.

### D3 Clients build one cloud client each

| Client | Token source |
|---|---|
| Web | `WebTokenSession.accessToken({ kind: 'account' })` |
| Desktop main | `OAuthSession.accessToken({ kind: 'account' })` in `account-session.ts` |
| Mobile | the access token callback in `account-client.ts`; `onUnauthorized` moves into the token source |

The seven copies in §1 are deleted.

Built: the four web copies in `client-core` (`webSettingsRequests`,
`webAgentProfileRequests`, `webCloudAccount`, `webUplinkAccountSource`). `sentOf`
maps a result to the `Response | null | 'signed-out'` that the route tables' send
ports take. Waiting: `webAccountDocumentSend`, desktop `AccountSession.cloudRequest`
with its three callers (`settings-client.ts`, `agent-profile-client.ts`, `ipc.ts`),
and mobile `accountRequest`. These files carry uncommitted plans/031 work.

### D4 The server builds one control-plane client — DROPPED

Each owner reads a 401 or 404 from the directory as "this registration is gone",
and `controlToken()` throws a typed `HostCredentialError` in place of answering
null. D1's retry after a 401 is wrong there, and what is left to share is one
`fetch` line per owner. The section below was the proposal.

`host/control-plane-client.ts`: `httpClient` with `baseUrl` from the registration's
`directoryUrl` and `token` from `controlToken()`. The five owners in §1 use it. A
401 or 404 from the directory keeps its present meaning in each owner (the
registration is gone); only the request moves.

`runner-delivery.ts` and `vault/account-reads.ts` send a delegated token per
person. They build an `httpClient` per request with that token and no refresh.

### D5 One host HTTP module

`client-core/src/host-http.ts` owns the two calls to another host outside RPC:

- `readHostHealth(fetch, url, signal, nonce?)`: moved from `host-link.ts`; now
  also used by `introduced-hosts.ts`, whose own schema is deleted.
- `refreshHostSession(fetch, url, sessionToken, timeoutMs)`: `'refreshed' |
  'unauthorized' | 'unavailable'`, through D1, used by `ws-transport.ts` and
  `introduced-hosts.ts`.

`apps/client/src/lib/connect.ts` `probeServer` stays: it probes an address before
anything is paired, accepts a server with no `installationId`, and reads
`requireAuth`, which a paired host's health does not need.

`/voice/transcribe` stays where it is; desktop streaming voice landed in
`11c357dda` and is still moving.

### D6 OAuth: no change; do not add `oauth4webapi` — DROPPED

The proposal was that `atlassian/oauth.ts` use `McpOAuth.exchange` and
`McpOAuth.refresh`. Read closely, Atlassian's token request differs: it sends a
JSON body where `McpOAuth` sends a form, and it keeps Atlassian's
`error_description` in the error because an expired refresh token and a wrong
client secret are otherwise the same 400. A change there needs a real Atlassian
grant to prove, for about 50 deleted lines.

`oauth4webapi` would replace the protocol lines of `McpOAuth`, but not its HTTPS
checks or its messages, and `solus-cloud` would take the dependency too. Not now.

### D7 Google REST through `@googleapis/drive` and `@googleapis/docs` — BUILT

`google/google-api.ts` makes one Drive client and one Docs client per access
token, and `googleAnswer` turns a call into `answered`, `refused` (status and the
start of the body), or `unanswered`. Two options differ from the SDK defaults:

- `retry: false`. The SDK retries GET, PUT, and DELETE by default. A Docs write is
  positional and a comment post is not idempotent, so no request repeats on its own.
- `fetchImplementation` is the runtime's `fetch`, read at call time. The SDK would
  otherwise load `node-fetch` in Node.

`drive.ts`, `comments.ts`, and `docs-api.ts` call the SDK and keep their own
error messages, the 404-is-done rule of a delete, and the comment rule that an
unanswered write is uncertain. `uploadPng` keeps its own two requests: the SDK
uploads only multipart, Drive limits multipart to 5 MB, and a diagram for a
reader zoomed to 200% is larger. The hand-written `DocsRequest` types stay;
they fit the SDK's `Schema$Request`. `google-auth-library` was already a
dependency, so the new runtime code is the two clients and `googleapis-common`.

## 4. Order

1. D1 with tests (`tests/unit/http-request.test.ts`). Built.
2. D2 and D3: the web copies are built. Desktop, mobile, and
   `webAccountDocumentSend` follow after the plans/031 account documents work is
   committed.
3. D5. Built.
4. D7. Built.

## 5. Surfaces

- **Clients:** web, desktop main, and mobile each build their cloud client (D3).
  No UI changes.
- **Providers:** not applicable.
- **Contracts:** no RPC change. The account route tables keep their schemas.
- **Connection modes:** desktop-local, desktop-hosted, and remote all reach the
  cloud through the same core. Host calls in D5 run before a socket exists.
- **solus-cloud:** imports `@solus/contracts` only; no change there.
