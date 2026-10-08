# Integrations

An integration is a remote MCP server a host knows. Settings → Integrations
lists them, adds one from the catalog or from a URL, and shows the tools each
one exposes. The design and its decisions are in
[`plans/mcp-integrations.md`](plans/mcp-integrations.md).

## What a person sees

- **The list.** Each integration shows its name, its slug, the host of its URL,
  and how it authenticates: Open (no sign-in), Sign-in (OAuth), or API key.
  Expand a row to see its tools, with a `destructive` or `read-only` badge when
  the server marks a tool that way. Rename and Remove are on the row.
- **Add.** Search the catalog, or enter an HTTPS URL. Solus probes the server
  without credentials and shows the outcome before Add is enabled: works
  without sign-in and how many tools, needs sign-in, needs an API key, or why
  it could not decide (with Retry). Sign-in and API keys arrive in a later
  release; such an integration can be added now and its tools work once the
  person has connected.
- **Same page on desktop, web, and mobile.** Choices belong to the selected
  host. Connected clients receive changes through `integration.changed`.

The catalog is the public `integrations.sh` registry, read by the host on
request. When the registry is unavailable the host serves its last good copy,
and the URL path does not depend on it.

## What the agent sees

Every tool of every integration is a Solus tool named `<slug>__<tool>`, with
the server's description and input schema. Both providers defer these tools
behind their own tool search, so a large server adds nothing to the prompt.
The provider's own loop runs them: parallel calls, retries, and one card per
call. A tool the server marks destructive requires approval, which the
session's permission mode decides (`plans/permission-modes.md`).

Solus is the MCP client. The host opens one session per integration and
person, and the agent process never holds a server credential. A request for
input from the server during a call shows as a question card.

## Who may change what

The host owner and an organization owner add, rename, probe, and remove
integrations. Any member sees them and uses their tools. A guest sees none.

## Not in this release

Per-person sign-in with OAuth, API keys, a per-tool allow/ask/block policy,
OpenAPI documents, and stdio servers are later phases of the plan.
