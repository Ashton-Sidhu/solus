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
  OAuth client when the server needs one, then Sign in opens the server's
  page in your browser, or the dialog asks for the API key. While it waits,
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
  let Solus register an OAuth client for itself. Such a row asks the host
  owner or an organization admin for a client ID and secret from an OAuth
  app created at the service, and shows the redirect URL that app must list:
  the host's `/oauth/integration/callback`. The client is per host; each
  person still signs in with their own account.
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

## Your own servers

A server can be yours alone (plans/020-agent-profile.md §2.1). On a host you do
not administer, Add makes a personal record: only you see it and its tools,
and its tool prefix is yours, so it may equal a shared server's. Your personal
servers are part of your [agent profile](agent-profile.md), so they follow you
to every host you have a seat on. On a host you own, every server is the
host's, as before.

## Connections through Solus Cloud

When you are signed in to Solus, a sign-in to any server a host shows you,
shared or your own, runs at app.solus.sh, once, and the connection lives in
your account. Profile sync does not need to be on. A host reads an access
token from your account for each call and keeps nothing else; its row reads
"Connected through Solus Cloud". A connection you made on a host before moves
into your account the next time that host pulls your profile. When Solus
Cloud does not answer, the host uses the token it cached until it expires,
then shows "Solus Cloud unreachable", which no sign-in fixes. When the host
has no Solus sign-in to read your account with (you signed out of Solus on that
host), the row shows "Sign in to Solus" instead.

Two sign-ins stay on the host: any sign-in while you are signed out, and a
server whose OAuth client only the host's administrator holds
(`client-required`). The cloud signs in only to a public HTTPS server. A
host's sign-in returns to the address the client reached the host on, so it
also works through a host's tunnel URL.

## Who may change what

The host owner and an organization owner add, rename, probe, and remove shared
integrations. Any member sees them and uses their tools, and adds, renames,
and removes their own personal ones. A guest sees none.

## Not in this release

A per-tool ask rule (only on and off exist), OpenAPI documents, several
accounts per person, and stdio servers are later phases of the plan. The
tools that are off are not part of the agent profile, so they do not follow a
personal server to another host.
