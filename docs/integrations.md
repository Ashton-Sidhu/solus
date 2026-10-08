# MCP servers (integrations)

An integration is a remote MCP server a host knows. Settings → MCP lists the
servers installed on the host and the catalog to add more from. The design
and its decisions are in [`plans/mcp-integrations.md`](plans/mcp-integrations.md).

## What a person sees

- **One search.** The search at the top of the page filters the installed
  servers and searches the catalog. Paste an `https://` address to add a
  server that is not in the catalog; Enter adds it.
- **Installed.** Each server shows its name, the host of its URL, and its
  state in a few words: Ready (no sign-in), Connected as you, Not connected,
  Needs sign-in, Connection error, or Needs an OAuth client. A server you can
  sign in to shows Connect or Reconnect on its row. Open a row for its
  OAuth client, your account, and its tools (marked Destructive or Read-only
  when the server says so). Rename and Remove are in the row's menu. Tools
  show only for a server that needs no sign-in or that you are connected to;
  any other says "Connect to see its tools."
- **Catalog.** The catalog shows the most popular servers first, with the
  number of matches. More load below as you scroll near the end, so the
  servers you read never move; Show more does the same from the keyboard. A
  server already installed reads Added.
- **Add is one step.** Add checks the server from the host without
  credentials, adds it, and starts your sign-in at once when it needs one:
  the browser opens for OAuth, or the row asks for the API key. The new row
  opens so you see where the sign-in stands. When the host cannot decide how
  the server works, nothing is added; the entry says why and offers Retry.
- **Sign in.** Connect opens the server's sign-in in your browser. When the
  browser cannot reach the host, you paste the address of the page you
  landed on. A server that needs an API key checks the key against the server
  before saving. Disconnect is in the open row.
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

## Who may change what

The host owner and an organization owner add, rename, probe, and remove
integrations. Any member sees them and uses their tools. A guest sees none.

## Not in this release

A per-tool allow/ask/block policy, OpenAPI documents, several accounts per
person, and stdio servers are later phases of the plan.
