# MCP servers (integrations)

An integration is a remote MCP server a host knows. Settings → MCP lists the
servers installed on the host and the catalog to add more from. The design
and its decisions are in [`plans/mcp-integrations.md`](plans/mcp-integrations.md).

## What a person sees

- **One search.** The search at the top of the page filters the installed
  servers and searches the catalog. Paste an `https://` address to connect a
  server that is not in the catalog; Enter opens the connect dialog for it.
- **Views.** A rail beside the list shows All, Installed, and the catalog's
  categories (Productivity, Code and CI, Data and analytics, and others). In a
  narrow page the rail becomes a row of chips. Mobile filters the catalog with
  one category menu above it. A Solus category gathers several of the
  registry's own category names; most registry entries have none and show
  under All only.
- **Installed.** Each server shows its name, the host of its URL, and its
  state in a few words: Ready (no sign-in), Connected as you, Not connected,
  Needs sign-in, Connection error, or Needs an OAuth client. A server you can
  sign in to shows Connect or Reconnect on its row. Open a row for its
  OAuth client, your account, and its tools. Rename and Remove are in the
  row's menu. Tools show only for a server that needs no sign-in or that you
  are connected to; any other says "Connect to see its tools."
- **Tools on and off.** Each tool shows Read, Write, or Destructive from the
  server's own hints (a tool with no read-only hint may write) and a switch.
  A tool that is off is not given to agents, and the host refuses a call to
  it, also in a run that started before the change. The list is on the
  server's record, so it applies to every person on the host; who may change
  it is the same as who may rename the server. A tool the server adds later
  is on.
- **Catalog.** The catalog shows the most popular servers first in two
  columns, with the number of matches. More load below as you scroll near
  the end, so the servers you read never move; Show more does the same from
  the keyboard. A server you can use now reads Connected.
- **The connect dialog.** Connect on a catalog entry or an installed row opens
  one dialog with two steps. *Sign in*: the dialog first adds a new server
  (the host checks it without credentials; when it cannot decide how the
  server works, nothing is added and the dialog says why), then asks for the
  OAuth client when the initial server check says one is required. Use
  a client ID supplied by the service, or one from your own OAuth app; the
  secret is optional. **Use your own OAuth app** is also available for servers
  with automatic setup, including while a sign-in is waiting or has failed.
  The form shows the full callback URL to register. Saving a custom client
  selects sign-in through that host; removing it restores automatic setup
  when the server supports it. Then Sign
  in opens the server's page in your browser, or the dialog asks for the API key. While it waits,
  Reopen it opens the page again; when the browser cannot reach the host,
  you paste the address of the page you landed on. A server with no sign-in
  skips this step. *Tools*: switch off the tools agents should not use, then
  Connect saves the choice and the dialog says how many tools are ready.
  Cancel, Escape, or the close button before the end ends the sign-in and
  removes a server the dialog added. Mobile keeps its inline flow: Add, then
  the sign-in and the tool switches in the opened row.
- **Disconnect** is in the open row. A server that needs an API key checks
  the key against the server before saving.
- **A server without self-registration.** Some services, Zoom for one, do not
  let Solus register an OAuth client for itself. Such a row asks its owner
  for a client ID and secret from an OAuth app created at the service, and
  shows the redirect URL that app must list: the host's
  `/oauth/integration/callback`. The client is on the server's record, per
  host (docs/plans/access-model.md, D3).
- **Your account is yours.** Each person signs in with their own account on
  each host, as with a provider seat. The token stays on the host in your own
  encrypted store, and only the integration's own server ever receives it.
- **Same page on desktop, web, and mobile.** Choices belong to the selected
  host. Connected clients receive changes through `integration.changed`.

The catalog is the public `integrations.sh` registry, read by the host on
request. Entries listed there under an agent's name, such as "Zoom for
Claude", are shown by the service's name. Cloudflare's servers get
`codemode=false` on their address, so they list their real tools instead of
a two-tool code mode. When the registry is unavailable the host serves its last good copy,
and the URL path does not depend on it.

## What the agent sees

Every tool of every integration is a Solus tool named `<slug>__<tool>`, with
the server's description and input schema. Both providers defer these tools
behind their own tool search, so a large server adds nothing to the prompt.
The provider's own loop runs them: parallel calls, retries, and one card per
call. A tool the server marks destructive requires approval, which the
session's permission mode decides (`plans/permission-modes.md`).

Solus is the MCP client. The host opens one session per integration and
person with that person's token, and the agent process never holds a server
credential. A call on an integration you have not connected fails with
`CONNECTION_REQUIRED` and shows a connect card in the conversation; the agent
can ask `connection_status` for an integration to check first. A request for
input from the server during a call shows as a question card.

When you ask the agent to use a service that has no tools in the session, it
can call `connect_integration` with the service's name. The tool uses your
server for that service if you have one. Otherwise it adds the one catalog
entry whose name matches exactly, as your own server, the same way Settings
adds it. If the name matches more than one entry, the agent asks you which one.
Then the connect card opens in the conversation. If the server needs an OAuth
client, the card shows the client form first. The agent never asks for a key
or a password in the conversation. The tool requires approval, because it can
add a server. The new server's tools are available from your next message.

## Set up with an agent

Some servers need something from you before Solus can connect: an API key, an
OAuth client you create at the vendor, or the right address. Then the connect
dialog, the connect card, and the server's row offer **Set up with an agent**.
It opens a new chat on the same host with a prompt ready to send: the server,
its address, the callback URL to register for an OAuth client, and what to
find. The agent looks it up in the vendor's documentation. It never asks you
for a key, a token, or a password; you enter them in Settings → MCP or in the
card. A server you were adding stays in Settings, waiting for the key or the
client. A server can say it registers apps and then refuse Solus at sign-in;
Solus then records that it needs your OAuth client, so the dialog shows the
client form and this button. A server that is down or slow offers Retry instead. On mobile, the
prompt goes into the new-chat draft, after any text you already wrote.

## Servers Solus adds to the catalog

The catalog lists the integrations.sh feed and Solus's own list, first, with a
**Solus** mark:

- **Servers the feed misses**, such as Cloudflare's whole-API server and
  Salesforce. Solus publishes the list from `main`
  (`packages/contracts/src/integration-catalog.json`), and each host reads it
  when the catalog opens, keeping the copy its build shipped with for when it
  cannot. An entry may link to the vendor's **setup guide** for the OAuth
  client or the key; the connect dialog and the mobile row show it.
- **Servers Solus writes itself**, for services with no usable MCP server:
  the Google suite, one server per product (Gmail, Calendar, Drive, Docs,
  Sheets, Slides, Forms, Tasks, Contacts, Meet, and Search Console), so each
  sign-in asks only for that product's access. They run inside the host and
  show as "Built by Solus". Every Google account is labelled by its email. They sign in with the vendor's OAuth, through Solus's own app when
  the build has it, or the client you enter.

## Several accounts

Beside a connected OAuth server, **Add another account** signs in one more
account, such as a personal and a work one. Each account is listed with its
own Disconnect. Tools that only read run for every account and name the
account in their answer; a tool that may write asks the agent to name one.
If the sign-in returns an account that is already connected, Solus refuses
it and asks you to choose another account. Google always shows its account
chooser for this reason.
An added account stays on the host it was connected on: it does not follow
you through your Solus account, and a server that takes an API key keeps one
key per person.

## Signing in with Solus's app

Some vendors do not let an unknown app register. For those Solus registered
its own app, and you enter no client:

- **GitHub's MCP server** uses your Solus GitHub connection (Settings →
  Source Control), so it needs no second sign-in. Without a GitHub connection,
  Connect says to make one first.
- **Google** servers, such as Google Calendar, sign in with Solus's Google
  app. The app may hold the Google scopes of Executor v2's Google app (Gmail,
  Calendar, Meet, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts, Photos,
  and Search Console); a server asks only for the scopes it uses. Disconnect
  removes the token from Solus but does not revoke it at Google: Google ends
  every grant you gave the app at once, which would also end your other Google
  servers and Solus's Google connection. To end the grant itself, remove Solus
  at myaccount.google.com/connections.

You can still enter your own OAuth app; it wins. A development build that
has none of Solus's apps asks for your client, as before.

## Your own servers

A server you add is yours (plans/020-agent-profile.md; docs/plans/access-model.md,
D3): only you see it, use its tools, and change it, and its tool prefix is
yours, so it may equal another person's. This is the same on a host you own and
on one you do not; a host administrator does not reach it. There are no shared
servers. Your
servers are part of your [agent profile](agent-profile.md), so they follow you
to every host you have a seat on. When a run starts, the host lists the tools of
your servers with your own sign-in, so a server that
refuses an anonymous list, such as PlanetScale, still gives your agent its
tools. A server that does not answer in 10 seconds adds no tools to that run.

## Connections through Solus Cloud

Signed in means your account (`docs/plans/cloud-vault.md` §2.5). When you are
signed in to Solus, a sign-in to any of your servers on a host runs at Solus
Cloud, which keeps the connection in your account vault. Profile sync does not
need to be on. A host reads an access token from your account for each call and
keeps nothing else; its row reads "Connected in your Solus account". A connection
you made on a host before you signed in moves into your account when you sign in
on that host (a connection your account holds already wins), and the host keeps
no copy. When Solus Cloud does not answer, the host uses the token it cached
until it expires, then shows "Solus Cloud unreachable", which no sign-in fixes.
When the host has no Solus sign-in to read your account with, the row shows
"Sign in to Solus" instead. When the host stops being linked to you, it keeps no
connection of yours: you connect again on that machine.

Two sign-ins stay on the host: any sign-in while you are signed out, and a
server whose OAuth client its owner saved on the host (`client-required`). The cloud signs in only to a public HTTPS server. A
host's sign-in returns to the address the client reached the host on, so it
also works through a host's tunnel URL.

## Who may change what

Every person adds, renames, and removes their own servers, sets their OAuth
client, and turns their tools on and off. Nobody else sees or changes them,
the host owner and an organization owner included (docs/plans/access-model.md
§2.3). A guest has none.

## Not in this release

A per-tool ask rule (only on and off exist), OpenAPI documents, renaming an
account, several API keys for one server, and stdio servers are later phases
of the plan. The tools you turned off are part of your agent profile, so they
follow a personal server to every host.
