# Solus Client ID Metadata Document: hand-off (2026-11-20)

Branch: `solus/publish-mcp-oauth-metadata-document` (from
`solus/merge-mcp-wave-branches`). Not pushed. No pull request. The site is not
deployed.

## The URL, and why

`https://solus.sh/oauth/client-metadata.json`

- **solus.sh** is the public Solus site (`apps/site`, Cloudflare Worker
  `solus`; `robots.txt`, `sitemap.xml`, and the Open Graph tags name
  `https://solus.sh`). The task puts the document in `apps/site`. app.solus.sh
  is Solus Cloud, another repository with another release. The published apps
  run on `*-app.solus.sh`, other hosts, so code an agent wrote cannot serve
  this path.
- An authorization server shows the host name of the client ID on its consent
  screen. `solus.sh` is the product name.
- **/oauth/client-metadata.json** has a path, as the draft requires (§3), no
  query, no fragment, and is in normal form. It is the name the MCP example
  uses. It does not collide with a site page. It has no version in it: the
  client ID is the identity of Solus at every authorization server, and a new
  URL is a new client everywhere. Change the document, not the URL.

## The document

One source: `packages/contracts/src/integrations/solus-client-metadata.json`.
`apps/site/src/routes/oauth/client-metadata.json/+server.ts` imports that file
and serves it (not prerendered, so it carries its own headers):
`Content-Type: application/json`, `Cache-Control: public, max-age=3600`.

```json
{
  "client_id": "https://solus.sh/oauth/client-metadata.json",
  "client_name": "Solus",
  "client_uri": "https://solus.sh",
  "policy_uri": "https://solus.sh/privacy",
  "tos_uri": "https://solus.sh/terms",
  "application_type": "native",
  "redirect_uris": [
    "http://127.0.0.1:3001/oauth/integration/callback",
    "http://localhost:3001/oauth/integration/callback",
    "http://127.0.0.1:3000/oauth/integration/callback",
    "http://localhost:3000/oauth/integration/callback"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

From the specification (draft-ietf-oauth-client-id-metadata-document-03 and
MCP 2026-07-28 client registration): `client_id` must equal the URL by plain
string comparison (§4); MCP requires `client_id`, `client_name`, and
`redirect_uris`; a public client must not name a shared-secret method or a
`client_secret` (§4.1); the server compares a redirect URI as a plain string,
with an exception for loopback ports (§4.2); every MCP redirect URI is
localhost or HTTPS; the document is served with 200, and the server follows
no redirect (§4, §6); a server advertises support with
`client_id_metadata_document_supported` in its metadata (§8).

Choices:

- `token_endpoint_auth_method: "none"` as the MCP example has it. Draft -03
  calls this field "not recommended" in favour of
  `token_endpoint_auth_methods_supported`, but MCP cites -00, where the
  singular field is the one a server reads. -03 also assumes `none` when the
  field is absent, so both readers get a public client.
- `application_type: "native"`: the callbacks are loopback, as the dynamic
  registration already says for loopback callbacks.
- No `logo_uri`: the site's only logo is `favicon.svg` under a hashed build
  path. Add a PNG at a stable path to add one.

## The result for each connection mode

| Mode | Callback Solus builds | Document |
| --- | --- | --- |
| Desktop app hosting the server locally | `http://127.0.0.1:3001/oauth/integration/callback` (the renderer's origin) | Served. A moved port or `SOLUS_PORT` is not; it registers dynamically. |
| Web client opened on the host machine | `http://127.0.0.1:<port>` or `http://localhost:<port>` | Served on 3001 and 3000. |
| Standalone host on another machine | its own origin: LAN, tailnet, public, or tunnel | Not served (a fixed document cannot name it). Dynamic registration. An SSH forward to `127.0.0.1:3000` is served. |
| Sign-in that starts at Solus Cloud | `https://app.solus.sh/oauth/vault/callback` (solus-cloud `callbackUrl`) | Not served. The cloud is a web client with an HTTPS callback; it can publish its own document on app.solus.sh. |

The host does not rely on the loopback port exception: a server that does not
apply it would refuse the sign-in in the browser, where Solus cannot fall
back. The exact callback must be in the document.

## How the host confirms the document

`packages/server/src/integrations/client-metadata.ts`, `PublishedClientMetadata`:

- Reads the URL on demand with the OAuth code's fetch, a 5-second timeout,
  `redirect: 'manual'`, and `accept: application/json`, as the catalog reads
  its published file.
- Confirms: status 200, the body passes `clientMetadataDocumentSchema`, the
  URL is a valid client identifier URL, and `client_id` equals it
  (`namesItsUrl`).
- Keeps a confirmed copy one hour. While reads fail, uses it for up to one
  day. After a failed read, waits five minutes before it reads again, so an
  offline host does not wait at each sign-in. Never throws.
- `SOLUS_OAUTH_CLIENT_METADATA_URL` names another document for a self-hosted
  deployment, as `SOLUS_INTEGRATION_CATALOG_URL` and
  `SOLUS_MODEL_PROFILES_URL` do. No client gets a development origin.

`IntegrationOAuth.clientFor` (`integrations/oauth.ts`) now resolves:

1. The owner's client ("Use your own OAuth app").
2. The first-party client.
3. The document: only when the authorization server advertises
   `client_id_metadata_document_supported`, the document is confirmed, and it
   names the exact callback. The client is `{ clientId: <URL>,
   tokenEndpointAuthMethod: 'none' }`. Nothing is saved.
4. A saved dynamic registration for this callback.
5. A new dynamic registration.
6. Refusal (`OAUTH_CLIENT_REQUIRED_MESSAGE`).

When the document is not confirmed, the chain continues at step 4. Stored
clients and tokens stay keyed by issuer. A token signed in with the document
carries the URL as its `clientId`, so refresh and revoke use it as a public
client (`clientForToken`).

Behaviour change: the owner's client is now checked before a saved dynamic
registration. Before, a saved registration for the callback came first. Saving
an owner's client replaces the saved registration, so this differs only when
the owner's client came from a synced profile without a local save; the
explicit choice now wins, as §13.1 says it should.

## The public surface of `McpOAuth`

No change. `McpOAuth`, `OAuthClient`, `OAuthMetadata`, and `OAuthToken` are
as they were. A document client is a plain `OAuthClient` with
`tokenEndpointAuthMethod: 'none'`, which `authorization`, `exchange`, `refresh`,
and `revoke` already handle.

New in `@solus/contracts/integrations/client-metadata-document` (the cloud may
use them; it does not have to): `clientMetadataDocumentSchema`,
`ClientMetadataDocument`, `SOLUS_CLIENT_METADATA`, `SOLUS_CLIENT_ID_URL`,
`isClientIdUrl`, `namesItsUrl`.

## The maintainer's step

Deploy `apps/site` as usual (`cd apps/site && bun run deploy` runs the build
and `wrangler deploy`). The wrangler file has no custom-domain route; the
solus.sh domain is bound to the `solus` Worker outside the file. Then confirm:

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type} %{redirect_url}\n' https://solus.sh/oauth/client-metadata.json
# expect: 200 application/json  (and no redirect URL)
curl -sS -D - https://solus.sh/oauth/client-metadata.json | grep -i cache-control
# expect: cache-control: public, max-age=3600
curl -sS https://solus.sh/oauth/client-metadata.json | jq -e '.client_id == "https://solus.sh/oauth/client-metadata.json"'
# expect: true
```

A Cloudflare rule that redirects or challenges this path (bot fight mode, a
trailing-slash rule) breaks it: the authorization server follows no redirect
and reads only a 200. A running host confirms the document within an hour of
the deploy (five minutes after its last failed read), and logs
`client_metadata_unconfirmed` while it cannot.

## Tests and checks

- `bun test tests/unit/integrations/client-metadata.test.ts
  tests/unit/integrations/oauth.test.ts
  tests/unit/integrations/first-party-clients.test.ts
  tests/unit/integrations/admin-client.test.ts
  tests/unit/mcp-oauth-registration.test.ts tests/unit/integrations/probe.test.ts
  tests/unit/integrations/connections.test.ts
  tests/unit/integrations/gateway.test.ts`: all pass.
- New tests: the served document is valid, JSON with a cache header, at the
  path of its own `client_id` (the test calls the site route, which reads the
  same JSON); `client_id` equals `SOLUS_CLIENT_ID_URL`; every loopback callback
  the hosts build on their default ports is in the document; client ID URL
  rules; the host falls back to dynamic registration when the document is
  missing, names another URL, redirects, or cannot be read, and when the
  callback is not listed; the host does not read the document when the server
  does not advertise support; the host signs in with it, with no registration
  and no secret, when it is confirmed and supported; the owner's client and
  Solus's Google app still win; the cache times.
- TypeScript (`tsc --noEmit` per package): contracts 0, server 129,
  workspace-ui 39, client-core 2, the same as the base. None in changed files.
- `apps/site` `bun run check`: 2 errors, both in `vite.config.ts` (two copies
  of Vite in the install), none in the new route. The new route is the only
  change in the site.
- `oxlint` on the changed files: no finding in changed code. `probe.ts` has
  two older findings (`complexity`, a conditional spread) outside the change.
- `server-module-boundaries` still fails at the base with three `host/` →
  `transport/` imports; the new file is not among them.

## Not done or not verified

- The site is not deployed, so no real authorization server has read the
  document. No sign-in ran in a browser.
- The site route did not run in a Worker: no build or dev server was started.
  The handler is tested directly, and `svelte-check` passes on it.
- Solus Cloud does not use a document. It needs its own document on
  app.solus.sh for its HTTPS callback; no change to `McpOAuth` is needed.
- A server that reads documents but has no registration endpoint: until the
  document is confirmed, sign-in refuses with the client-required message, and
  `integrationConnectStart` marks the record `client-required`. That mark
  stays after the deploy, so Settings shows the owner's client form for it,
  although a started sign-in would use the document. That handler is older
  than this change and was not changed.
- No UI text changed. Settings says "automatic setup" for both a dynamic
  registration and the document, which stays correct.
