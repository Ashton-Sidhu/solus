# Add an MCP server

How a person adds an MCP server that is not in the catalog. It applies to the
Settings → MCP add dialog and to the connect card in a conversation. The
design is on the Paper page "MCP · Add server flow" (screens T1–T4).

## One timeline

The add dialog is one timeline (`StepRail`, the onboarding timeline style):

1. **Server.** One field. It takes an address, a command, or the JSON from a
   server's setup page.
2. **Sign in.** For a command, this step is **Start and test**.
3. **Choose tools.**

A done step folds to one line that says what the person chose. While the step
is not finished, **Change** on the done Server step goes back to the field and
removes the server that this dialog added. `lib/connect-timeline.ts` gives the
state of each step.

## The one field

`@solus/contracts/integrations/server-source` reads the field:

- Text that starts with `scheme://` is an address. The add form refuses an
  address that is not http or https.
- Text that starts with `{`, or a `"name": { … }` fragment, is JSON. Solus
  reads `mcpServers` (Claude Code, Cursor, Claude Desktop), `servers` (VS
  Code), a table of servers by name, or one entry. It reads one server only.
  JSON that names more servers is refused, and the refusal says why.
- Text that is still the start of `http://` or `https://`, such as `https:`,
  is an address that the person is typing. It is neither an address nor a
  command yet.
- All other text is a command line.

A label at the end of the field shows what Solus reads: **Server URL** or
**Command**. A command also shows in a mono font, with its own fields below.
A half-typed address shows no label and no command fields.

When the person pastes JSON, the field shows the address or the command line
that the JSON names. The JSON also fills the rest of the form: the name, the
folder, the environment variable names and values, the header names and
values, and a static OAuth client ID (`oauth.clientId`, which
`claude mcp add --client-id` writes). A value that holds `${…}` is a reference
that Solus does not expand, so Solus keeps the name and drops the value. A
note callout tells the person that the form was filled from the config.

## Check first, then ask

An address goes to the host's check when the person selects Continue, with
the sign-in method set to Automatic. A static client ID goes with Automatic,
so it applies only when the host finds OAuth. Header names from the JSON make
it a `headers` server. The person sees the full address form, with its sign-in
method, only when the host refuses the address
("Change the address or sign-in method").

When a server does not register Solus by itself, the sign-in step shows a
warning callout and the OAuth client fields. The redirect URL is
`INTEGRATION_OAUTH_LOOPBACK_URL` (`docs/plans/mcp-oauth-callback.md`).

## The connect card

The card's "Add the server" step has the same field. The card adds an address
in place, with the client ID or headers from the JSON (`urlSourceAdd`). A
command runs as code on the host, and only an administrator can add one. So
for a command, the card shows a note and **Open in Settings**. That opens the
add dialog on the same host, with the field already filled
(`mcpPageRequest.askAddServer(source)`).

## Style

- Notes and warnings use the callout band (`MarkdownAlert`, `.prose-callout`),
  not grey cards inside the dialog or the card.
- Monospace is only for the command line and the environment variable names.

## Mobile

Mobile has no MCP add dialog and no card for an unlisted server. Its agent
profile field "Add an MCP server" uses the same reader. It takes an address or
pasted JSON. For a command, it tells the person to add it on the MCP page of
the desktop or web app.
