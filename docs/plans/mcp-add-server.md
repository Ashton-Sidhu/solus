# Add server: a command or a URL, with its authentication

Status: implemented, not committed (2026-11-22).

Settings → MCP has one **Add server** dialog (desktop, web) and one **Add server**
section (mobile). The person picks **Command** (a program the host starts,
`mcp-first-class.md` §7) or **URL** (a remote server). This plan adds what a
URL server needs before its first sign-in: the authentication, the OAuth
client, the scopes, and custom headers.

## Vocabulary

- **Add server** — the dialog and the section. Not "Add command", not "Add integration".
- **Kind** — Command or URL.
- **Authentication** — how a URL server takes the person's credential:
  **Automatic**, **OAuth**, **API key**, **Headers**, **None**.
- **Header** — one HTTP header a `headers` server takes from each person. Its
  **name** is on the record; its **value** is the person's secret.
- **Scopes** — the OAuth scopes the sign-in asks for, in place of the server's.

## Contract (`packages/contracts/src/integration-types.ts`)

- `integrationUrlCreateRequestSchema.auth: IntegrationAuthChoice`, left out = `automatic`.
  - `automatic { scopes?, client? }` — the probe decides, as before. `scopes`
    and `client` apply only when it finds OAuth.
  - `oauth { scopes?, client? }` — refused when the server offers no OAuth.
  - `bearer`, `none`, `headers { names }` — override the probe. The probe then
    only has to reach the server: `unreachable`, `timeout`, `redirected`, and
    `unavailable` still refuse the add.
- `oauthAuthSchema.scopes` — the person's scopes. The sign-in sends them in
  place of the metadata's.
- New auth kind `headers { names }`. Header names are HTTP tokens. Headers
  that HTTP or the MCP transport set are reserved (`Host`, `Content-Type`,
  `Mcp-Session-Id`, …). `Authorization` is allowed.
- `integrationUpdateRequestSchema.scopes` (`null` clears) and `.headerNames`.
- `integrationEnvValueSchema.name` takes a header name too: a `headers` server's
  values go through `integrationConnectSubmit { id, values }`, as a command's do.
- `IntegrationSignIn.valueNames` — the names a person gives values for, for
  `env` and `headers` alike. Clients read it instead of testing `kind === 'env'`.

## Decisions

1. **Header values stay on the host.** They are saved as a command's
   environment values are (`vault.saveEnvironment`, host only). So a `headers`
   server is not an agent profile entry, as a `stdio` one is not (§7.8). This
   also keeps older hosts, which do not know the kind, from refusing a profile.
2. **Headers replace the other authentication; they do not add to it.** A server
   that takes `Authorization: Bearer …` is **API key**. A server that takes
   `X-API-Key` is **Headers**. OAuth together with static headers is out of scope.
3. **The OAuth client up front is saved by the create**, as the row's OAuth
   client form saves one (`integrationUpdate.oauthClient`). It is one call, the
   same on every client.
4. **An explicit authentication skips the client-side probe refusal.** The host
   probes and refuses only when it cannot reach the server. A plain Automatic
   sends no `auth` (`requestAuthOf`), so a host from before this change still
   takes the add.
5. **Chosen scopes keep the sign-in on the host** (`IntegrationSignIn.signsInOnHost`),
   as an owner's OAuth client does: the Solus Cloud sign-in is not known to
   send the record's scopes. Header values never go through the account.

## Clients

- **Desktop and web:** the connect dialog keeps the Solus modal form
  (`IntegrationDialog`, `McpFoundDialog`): one surface, icon and title,
  compact fields, and the actions at the bottom right. A Command | URL switch
  sits under the title until the host has a record. The URL form has
  Authentication as a select, with the fields of each choice under it, and
  the callback URL for OAuth. A refused URL offers Change URL.
- **Mobile:** the same choices in the Add server section; the header values in
  the row use the command's values fields.
- **The row** shows the authentication. A `headers` server has Enter values and
  Change values, as a command does, and edits its header names. An `oauth`
  server shows and edits its scopes.
