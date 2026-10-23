# Connect with less setup: the build plan

Status on 2026-10-23: steps 0 to 6 are implemented on the host and on desktop,
web, and mobile, and not committed. Two parts wait for solus-cloud, which is
not in this repository: the synced owner's OAuth client (step 4) and
first-party clients on the signed-in path (step 6). See "State" under each
step and "End-to-end check" below.

This plan orders and details the work of `mcp-integrations.md` §13
("Connecting with less setup"). §13 holds the design; this plan holds the
order, the files, the tests, and the state. Vocabulary is that plan's (§2).

## Goal

A person who asks for a service, in the conversation or in Settings, gets a
working connection in as few steps as the service allows, with Claude and
with Codex.

## Rules

1. **Every connector goes through the Solus gateway.** The host holds the
   token, and Claude and Codex get the same integration tools. Solus does not
   use a provider's own connectors, such as the claude.ai connectors a Claude
   session sees, because Codex does not have them (decision of 2026-10-22).
2. **Tool calls never pass through the cloud.** They go from the host to the
   vendor. The cloud takes part only in sign-in and refresh, on the signed-in
   path (plan 020 §5).
3. **Every user-facing change ships on desktop, web, and mobile.** Desktop and
   web share the Svelte settings and card; mobile has its own screens.
4. **No secret in the conversation.** An agent never asks for a key, a token,
   or a password; the person enters them in a card, a dialog, or the vendor's
   page.

## Decisions of 2026-10-22

- First-party clients follow the rule every credential follows today
  (`plans/020-agent-profile.md` §5.1): the host when not signed in or sync is
  off, the account vault and the cloud when signed in with sync on. A vendor
  with only a confidential web app (Zoom, HubSpot, Slack) has a first-party
  client only on the signed-in path (`mcp-integrations.md` §13.1).
- Solus accepts Google's restricted-scope review and the annual security
  assessment, for Gmail and `drive.readonly`.
- The owner's OAuth client is synced through the account vault, and
  `disabledTools` is part of the agent profile entry (`plans/020-agent-profile.md`).
- Integrations stay personal (access-model D3).

## Done

### Step 0: the agent connects a service (§13.2)

`connect_integration({ service })` uses the person's own integration for that
service, or adds the one catalog entry whose name matches exactly, as the
person's own integration, through the same `createIntegration` as Settings.
It ends at the connect card. A server that needs an OAuth client shows the
client form in the card first.

- Files: `integrations/connect-integration-tool.ts`,
  `integrations/integration-create.ts`, `connections/connection-tools.ts`
  (`reportIntegrationConnection`), `ConnectCard.svelte`,
  `IntegrationConnectSheet.tsx`, `integrations.store.svelte.ts`
  (`integrationNeedingClient`).
- Tests: `tests/unit/integrations/connect-integration-tool.test.ts`.
- State: implemented, not committed.

## The order of work

### Step 1: "Set up with an agent" (§13.4)

When the probe cannot connect a server by itself, the connect dialog offers
**Set up with an agent**. It opens a new conversation tab with a prompt: the
service name, the URL, the probe signals, and the steps for that result.

| Probe result | Steps in the prompt |
|---|---|
| `credentials-required` (`bearer`) | Find where the service issues an API key. |
| `oauth`, `client-required` | Find the vendor's OAuth app settings, register the callback URL shown in the dialog, and pick the scopes. |
| `undetermined`, `refused`, `oauth_unusable`, or `not_mcp` | Read the vendor's documentation for its MCP endpoint and sign-in. |

`unavailable`, `timeout`, and `redirected` get Retry only. The prompt says to
send the person back to Settings → MCP, or to call `connect_integration`, when
the key or client is ready. `connect_integration` returns the same steps for
the same results. With the client form in the card (step 0), this completes
the guided setup.

- Files: one pure module for the steps and the prompt
  (`packages/contracts/src/integrations/setup-handoff.ts`, shared by the
  server tool and both clients); `McpConnectDialog.svelte`; the add flow in
  `IntegrationsScreen.tsx`; `connect-integration-tool.ts`.
- Tests: the prompt for each probe result names the URL and the right steps
  and never asks for a secret; `connect_integration` returns the steps.
- State: implemented 2026-10-22, not committed. `setup-handoff.ts` in
  `@solus/contracts/integrations`; the button in `McpConnectDialog.svelte`,
  `ConnectCard.svelte`, the mobile MCP rows (`SetupHandoffRow.tsx`), and
  `IntegrationConnectSheet.tsx`; `openChatDraft` takes a host and a prompt;
  mobile writes the new-chat draft (`use-setup-handoff.ts`). The connect card
  and `connection_status` include the steps for a server that needs a key or a
  client. Tests: `tests/unit/integrations/setup-handoff.test.ts`, and cases in
  `connect-integration-tool.test.ts` and `native-mobile-integrations.test.ts`.

### Step 2: the Solus catalog (§13.5)

A JSON list on `main` of MCP servers that integrations.sh does not list.

- **The file.** `packages/contracts/src/integration-catalog.json`, with its
  schema in `integration-catalog.ts`. A host reads it on request, as it reads
  the feed, keeps the last good copy four hours, and falls back to the
  bundled copy. (The plan first said a daily download shared with the model
  list; reading on request is simpler and matches the feed.)
- **First entries.** Cloudflare's whole-API server
  (`https://mcp.cloudflare.com/mcp`) and Salesforce records
  (`https://api.salesforce.com/platform/mcp/v1/platform/sobject-all`), with
  their sources and `authHelp` links (§13.5 shows both). Probe both before
  they merge.
- **Listing.** `IntegrationCatalog.list` merges the two sources. Solus entries
  come first, with a Solus mark (`CatalogEntry.source: 'feed' | 'solus'`). A
  Solus entry replaces a feed entry with the same URL. `connect_integration`
  finds Solus entries with no change.
- **`authHelp`.** The connect dialog and the card show the vendor's link for
  creating the client or the key.
- **Checks.** `tests/unit/integration-catalog.test.ts`: the schema, sorted and
  unique ids, unique HTTPS URLs, at least one source, and a flag when the feed
  now lists an entry's URL. A scheduled probe reports entries that stop
  answering.
- State: implemented 2026-10-23. `integration-catalog.json` and
  `integration-catalog.ts`; `IntegrationCatalog` merges it, read on request
  with a four-hour copy and the bundled fallback; the Solus mark and
  `authHelp` on desktop, web, and mobile; `tests/unit/integration-catalog.test.ts`
  and cases in `catalog.test.ts`; `scripts/check-integration-catalog.ts` probes
  every entry and flags one the feed now lists. Not added: a scheduled CI job
  for that script.
- **The `codemode` rule.** Delete the `mcp.cloudflare.com` entry from
  `MCP_QUERY_DEFAULTS` in `integrations/catalog.ts`, and correct its comment.
  Only the whole-API server reads `codemode`, and with `false` it registers
  about 2,500 tools. Keep the PostHog `mode=tools` rule. Update the catalog
  test that expects the parameter.
- Clients: the Solus mark and `authHelp` in `SettingsTabMcp.svelte`,
  `McpConnectDialog.svelte`, `ConnectCard.svelte`, and the mobile catalog and
  sheet.

### Step 3: Solus MCP servers, Google Calendar first (§13.6)

For a service with no usable MCP server, Solus writes its own.

- **How they run.** Inside the host. The gateway opens a session over the
  SDK's `InMemoryTransport` instead of streamable HTTP (`gateway.ts`, `open`),
  so everything after `open` is unchanged. A server reaches only its vendor's
  hosts, through one fetch that sets the person's token per request and
  refuses other hosts and redirects.
- **Records.** An integration of kind `solus`, named by the server's id.
  The agent profile entry carries the id.
- **Sign-in.** Solus's Google client (step 6) when it exists; until then the
  person's own Google client.
- **Order.** Calendar, then Docs and Drive, then Gmail. Microsoft Outlook and
  Calendar after Microsoft publisher verification.
- **Retirement.** When the vendor ships a usable MCP server, replace the Solus
  server with a catalog entry for it and move the records.
- Tests against recorded responses, with no live credential.
- State: implemented 2026-10-23. `integrations/solus-servers/` (the shared
  `solusMcpServer`, the bound fetch, and `google-calendar.ts` with six tools);
  kind `solus` with the address `solus:<id>`; the gateway's in-memory
  transport; the probe and create paths read the server's code; the OAuth
  flow takes the server's scopes and parameters and leaves out `resource` for
  Google. Tests: `tests/unit/integrations/solus-servers.test.ts`. Docs and
  Drive, Gmail, and Microsoft are not written yet.
- **Outside the code.** In the Google Cloud console, declare
  `drive.readonly` and the Calendar and Gmail scopes under Data Access, and
  submit one review (`mcp-integrations.md` §13.1, item 2). Homepage and
  privacy pages on solus.sh for the review.

### Step 4: the agent profile decisions (plan 020)

- **The owner's OAuth client is synced.** Signed in with sync on, a client
  entered for a `client-required` server goes to the account vault, and the
  cloud runs the sign-in with it. The reconcile uploads a client a host
  already saved, with or without a token.
- **`disabledTools` is in the profile entry,** so a person's tool switches
  follow them to every host.
- Files: `contracts/agent-profile.ts`, `integrations/profile-integrations.ts`,
  the reconcile in `integrations/connections.ts`, the vault.
- State: `disabledTools` is implemented 2026-10-23 (the profile entry, the
  save, and the pull; a case in `tests/unit/agent-profile.test.ts`). The synced
  owner's client is not: the cloud must store the client and run the sign-in
  with it, and that code is in solus-cloud. The host keeps the client in its
  secret store until then.

### Step 5: several accounts per integration (§13.3)

One person connects more than one account to one integration, such as Work
and Personal Gmail.

- `integration_connection` gains `account_id`; the key becomes
  `(integration_id, user_id, account_id)`; existing rows get `default`.
- The gateway session key gains the account.
- When a person has more than one account, each tool gains an optional
  `solus_account` input. A tool with `readOnlyHint` runs for every account when it
  is omitted; any other tool needs it.
- The integration row lists accounts with Rename, Reconnect, and Disconnect,
  and "Add another account". Desktop, web, and mobile.
- State: implemented 2026-10-23, with three limits. An added account lives on
  the host only, because the account vault keeps one credential per server
  URL. Rename is not built; an account's label is the identity the server
  reported. "Add another account" is for OAuth servers; an API-key server keeps
  one key per person. Files: the `integration_connection` migration, the
  store, `mcpCredentialRef(integration, accountId)`, the OAuth flow, the
  gateway's per-account sessions and `call`, the tool adapter's `solus_account`
  input, `IntegrationExtraAccounts.svelte` with `lib/integration-accounts.svelte.ts`,
  and mobile's `IntegrationExtraAccounts.tsx`. Tests in
  `solus-servers.test.ts`, `connection-store.test.ts`, and
  `native-mobile-integrations.test.ts`.

### Step 6: first-party clients (§13.1)

A registry of OAuth apps Solus registers with vendors, in
`first-party-clients.ts` in `@solus/contracts`. An entry has the endpoints,
`allowedScopes`, sign-in parameters, and the hosts its token may go to. It is matched automatically when an integration's
discovered endpoints equal it and every requested scope is allowed. The
dialog and the card then show "Sign in with Solus for X" and no client form.

The client chain becomes: a saved client for the callback, the person's own
client, the first-party client, dynamic registration, refusal.

Order:

1. **GitHub** (device flow). GitHub's MCP server
   (`https://api.githubcopilot.com/mcp/`) accepts every scope our GitHub client
   asks for, and today asks people for their own client.
2. **Google** (desktop client), after the console review of step 3.
3. **Atlassian**, after checking how its MCP server accepts clients.
4. **Microsoft**, then **Zoom**, **HubSpot**, and **Slack** (signed-in path
   only), each after the vendor's review: Microsoft publisher
   verification, the Zoom App Marketplace, the HubSpot listing, and the Slack
   Marketplace.

A service with no Solus client, such as Salesforce, where each org supplies
its own External Client App, keeps the generic path: the client form, the
callback URL, the `authHelp` link, and the agent hand-off.

State: implemented 2026-10-23 for GitHub and Google on the host path.
`contracts/first-party-clients.ts` is the registry; the probe marks
`auth.firstParty` when a server's endpoints equal an entry's and the build has
that app (`integrations/first-party.ts`). GitHub's MCP server uses the
person's Solus GitHub connection as its credential (`connectFirstParty`,
`authorizationFor`). Google's OAuth flow runs with Solus's Google desktop app
after the owner's client. The client form says "Signs in with Solus for X" on
desktop, web, and mobile. Tests: `tests/unit/integrations/first-party-clients.test.ts`.
Not done: Atlassian, the new vendors, and first-party sign-in through the
cloud for signed-in people, which needs solus-cloud.

## End-to-end check (2026-10-23)

An isolated host (the standalone server bundled with esbuild into
`.solus-local/e2e/`, a throwaway `SOLUS_DATA_DIR`) driven over its real RPC by
`.solus-local/e2e/run.ts`, against live servers. All 17 checks passed:

- The catalog listed the Solus entries first (Cloudflare API, Google
  Calendar, Salesforce), then the live feed (1,337 entries); Salesforce
  carried its setup guide; Cloudflare's URL had no `codemode=false`.
- DeepWiki probed as anonymous, connected without a sign-in, and listed its
  three real tools; a live call of `deepwiki__read_wiki_structure` through the
  gateway and the agent tool adapter returned the wiki's pages.
- Cloudflare API probed as OAuth with dynamic registration; starting the
  sign-in registered a real client and returned Cloudflare's authorization URL
  with `resource` and the scopes. "Add another account" started a separate
  sign-in.
- GitHub's MCP server probed as OAuth needing a client (the e2e build had no
  Solus GitHub app ID).
- Google Calendar (a Solus server) probed from its code, listed its six tools
  from the in-process server, and asked for the owner's client (no Solus
  Google app in the e2e build).

Not exercised: finishing an OAuth sign-in in a browser, a full agent turn in
Claude or Codex, and the clients' UI, which needs a client build the
developer runs.

## Open

1. **One OAuth client for a whole organization.** An admin enters a vendor
   client once in organization settings; every member signs in as themselves
   through it. It needs an organization client record and one more step in
   the client chain, between the person's own client and the first-party
   client. Not decided.
2. **The Claude Code setting** that turns off the claude.ai connectors in the
   Claude sessions Solus starts. Find it before that change.
3. **Refresh of synced credentials a host could refresh itself.** Plan 020
   makes the cloud the only refresher for synced credentials. Letting a host
   refresh a public client's token (GitHub, Google, Microsoft) would change
   that plan's "one refresher" rule. Not proposed now.

## Not in this plan

Integration packages, a Solus framework for wrapping OpenAPI documents, the
four meta-tools, and agent-written programs were discussed on 2026-10-22 and
parked. OpenAPI integrations remain phase 4 of `mcp-integrations.md`.
