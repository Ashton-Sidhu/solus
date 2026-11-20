# MCP servers (integrations)

An integration is a remote MCP server a host knows. Settings → MCP lists the
servers installed on the host and the catalog to add more from. The design
and its decisions are in [`plans/mcp-integrations.md`](plans/mcp-integrations.md).

## What a person sees

- **One search.** The search at the top of the page filters the installed
  servers and searches the catalog. Paste an `https://` address to connect a
  server that is not in the catalog; Enter opens the connect dialog for it.
  A server that runs on the host itself can use plain HTTP on loopback, for
  example `http://localhost:8000/mcp`. `localhost` is the host's, not the
  client's.
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
- **Instructions for the agent.** A server can give text that helps an agent
  use its tools. Open the server row to read it in a closed section. A run gets
  this text only when that server adds a tool to the run. Solus marks it as
  server text and limits its length.
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

## MCP Apps

A tool can declare an interactive app with its result. Solus shows the app as a
card in the conversation on desktop, web, and mobile. This works for an
integration, on Claude and Codex, and for an MCP server that Claude Code itself
is set up with (Claude Code 2.1.301 or later). An app can call tools on its own
server. Solus asks first unless the server marks the tool as read-only. In a
Claude session, Claude's permission rules also apply: a deny rule refuses the
call, and an ask rule makes Solus ask first.

**Display modes.** An app shows in its card, full screen, or in
picture-in-picture. Picture-in-picture keeps the app in view while you scroll
and type. Ask for it with **Keep in view** beside the full-screen control, or
the app asks for it itself (only an app that declares the mode gets it). On
desktop and web the same frame floats in a lower corner of its conversation,
above the input bar, so the app keeps its state. Its title bar moves it to the
other corner, returns it to its card (or press Escape there), opens it full
screen, or closes it. Its card shows a line with **Return to card**. One app
floats in a conversation; a second one sends the first back to its card. A
conversation narrower than 480 pixels does not offer the mode, and a frame in
it goes back to its card. On mobile a saved app docks above the composer, at
the full width, in a new frame; while the keyboard is open it shows only its
title bar. A live app card on mobile offers the mode once its call has ended
(`plans/mcp-first-class.md` §14.2).

## MCP prompts

A server can publish prompts: prepared instructions with a name and
arguments. Solus shows them as slash commands, `/<slug>:<prompt>`
(`docs/plans/mcp-first-class.md` §10).

- Desktop and web: type `/`. The menu lists the MCP prompts under **MCP**,
  after the Solus and agent commands, with each prompt's description and its
  arguments (`<required> [optional]`). A server you are not connected to shows
  one row, "Sign in to <server> to use its prompts"; in a conversation it opens
  the connect card, and from a draft it opens Settings → MCP.
- A prompt with no argument sends at once. A prompt with one argument takes
  the rest of the line: `/github:triage bug`. A prompt with more arguments, or
  one whose required argument is empty, opens the argument form in the input
  bar: Tab moves between fields, Enter sends, Escape closes. The focus goes
  back to the input bar after each.
- Mobile: the + menu has **MCP Prompt…**. It opens a sheet that lists and
  searches the prompts, then asks for the arguments.
- The host gets the prompt from the server with your connection and makes one
  text from its messages. That text is your message: both Claude and Codex get
  it, and the conversation shows it whole. A part from the assistant is marked
  "Assistant:". An image is attached to the message. The text is at most
  100,000 characters (`MAX_MCP_PROMPT_TEXT_CHARS`); a `[Left out: …]` line
  names the limit when text is cut. A prompt never runs a tool by itself.
- A Solus or agent command with the same name wins; the prompt is not listed.
  Two servers with the same command: the first wins.
- The list is read when you open `/` for the first time in a project, and
  again when a server says its list changed, an integration changes, a
  sign-in changes, or the host reconnects. Typing reads nothing. A command
  (stdio) server that is not running lists the prompts it saved when it last
  ran, and starts only when you send one of its prompts.
- A server that asks for input while it expands a prompt is declined: Solus
  can ask for input only during a turn.

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

**Progress and time limits.** A server can report the progress of a long call.
The tool row shows the server's message, and a bar with a percent when the
server gives a total, on desktop, web, and mobile. The agent does not see
progress. A call stops when the server sends nothing for 60 seconds; each
progress report starts those 60 seconds again. A call stops after 30 minutes
in all, also when it continues to report progress. Both limits stop while you
answer a question of the server. After a reconnect the row shows the call as
running, with no number, until the next report.

**Trace context.** A call that a turn makes is a span `integration_call` in
Insights, under the tool call of the turn. The request carries the W3C
`traceparent` of that span in `_meta`, so a server that reports to the same
collector joins the turn's trace. Solus never sends `tracestate` or `baggage`.
A request outside a turn, such as a Settings read, carries no trace context.

**Result content.** A tool's whole result reaches the agent, on Claude and Codex alike: its text,
its structured data as JSON, and up to eight images (PNG, JPEG, WebP, or GIF).
No provider model takes audio in a tool result, so Solus saves audio on the
host and gives the agent its path; you get a player in the tool call. A part
that a limit or a check leaves out is saved for the agent when it can be, and
the agent and the tool call both get a note that names the limit. Data that
does not match the tool's output schema fails the call with that reason
(`plans/mcp-first-class.md` §6).

**A server that a CLI also has.** You can have the same server in Settings →
MCP and in a provider CLI file (`.mcp.json`, `~/.claude.json`,
`~/.codex/config.toml`, or `.codex/config.toml` in the project). Then each run
that Solus starts tells the CLI to leave out its own copy: Claude Code gets the
setting `deniedMcpServers` for that run, and Codex gets
`mcp_servers.<name>.enabled = false` for that thread. The agent sees each tool
once, through Solus, and the CLI does not start the copy or read its
credential. Two servers are the same when their addresses are equal: the same
URL (the case of the host, the default port, and a slash at the end do not
count; the query does), or the same command with the same arguments in the
same order (the environment does not count). Only a server that gives the run
at least one tool is left out, and a project server only in runs of its
project. The skip is for one run: Solus never changes the CLI's files. Remove
the server in Settings, or turn off all of its tools, and the next run loads
the CLI's copy again. The open row of the server shows **CLI copy** after a
run left a copy out: Claude Code does not say which copy it had, so its line
names the address; Codex names the copy and its file. A run outside Solus
(the CLI in your terminal) is not changed.

**Resources.** A server can list resources: documents, files, or records it
can read. When one of your servers in a session lists resources, the agent
gets two more tools, `list_integration_resources` and
`read_integration_resource`. A read is yours, with your connection; it changes
nothing, so it needs no approval. The contents reach the agent as a tool
result does. A resource link in a tool result names the read tool and the
server, so the agent can follow it. A server lists at most 200 resources and
200 templates to Solus; a list-changed notification of the server makes
Solus read the list again (`plans/mcp-first-class.md` §11).

You can attach a resource to your message yourself. On desktop and web, type
`@`: after the files, the menu shows up to five resources whose name, title,
or address matches, under "MCP resources". `@<server>:` shows only that
server's resources. On mobile, the + menu has **MCP Resource…**: a sheet with
your servers, their resources, and a search field. The host reads the
resource as you and keeps the contents as attachments of the conversation, as
an upload. The chip shows the server's logo and the resource name while the
host reads it; if the read fails, the chip says why, with Retry and Remove.
The agent gets what the resource held when you attached it. A command server
(stdio) that is not running shows no resources in the menu until it runs.

When you ask the agent to use a service that has no tools in the session, it
can call `connect_integration` with the service's name. The tool uses your
server for that service if you have one. Otherwise it adds the one catalog
entry whose name matches exactly, as your own server, the same way Settings
adds it. If the name matches more than one entry, the agent asks you which one.
Then the connect card opens in the conversation. If the server needs an OAuth
client, the card shows the client form first. The agent never asks for a key
or a password in the conversation. The tool requires approval, because it can
add a server. The new server's tools are available from your next message.

For a server that is not in the catalog, such as one on `localhost`, the agent
calls the tool with `custom: true`. The connect card then asks for the server's
address. The agent can fill in the address if you gave it, but only you can add
the server. After you add it, the same row goes on to the sign-in.

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

## Commands on the host (stdio servers)

Most local MCP servers are a command, such as
`npx -y @modelcontextprotocol/server-filesystem /data`
(`docs/plans/mcp-first-class.md` §7). Solus can add one as an MCP server of
kind `stdio`. The host starts the command and talks to it on standard input
and output. The command runs on the host that holds the record, as the OS
user of the Solus server, with no sandbox. Thus:

- Only a person with `host.admin` adds a command, changes it, or starts it.
  On your own machine that is you. A run of a person who is not an
  administrator does not get the tools of a command.
- Solus starts the program with no shell. A line with `|`, `&`, `;`, `<`,
  `>`, a backquote, or a `$` expansion is refused with the reason. Quotes keep
  spaces. `~` is expanded only in the working directory.
- The record holds the names of environment variables, never their values.
  Each person gives the values as their connection. The host keeps them in
  its own secret store. They go into that command's process and into no
  record, log, answer to a client, or agent process.
- The process gets `HOME`, `LOGNAME`, `PATH` (the login shell's), `SHELL`,
  `TERM`, `USER`, and your values. No other variable of the Solus server
  reaches it.
- The first start checks the server's protocol revision, which starts the
  command twice. Solus saves the answer and the tool list, so the next start
  is one process, and the start of a run starts nothing: it reads the saved
  list. A run of a command that never started gets no tools of it.
- A process stops after 10 minutes with no use, at **Stop**, and when the host
  stops. A process that ends by itself fails the call in flight ("`<name>`
  stopped while it ran `<tool>`.") and starts again on the next use. Three
  ends soon after a start in 5 minutes, or a command that is not installed,
  set the state **failed**. Then only **Start again** starts it.
- At most 16 commands run on one host. A new one stops the idle one used least
  recently.
- A command is not part of your agent profile. It stays on the host you added
  it on.

### Commands in Settings

Settings → MCP shows a command on desktop, web, and mobile.

- **Add command** (beside Installed; on mobile, the Command section) opens
  the form: a name, the command line, the working directory, and the names
  of the environment variables, with a field for each value. Under the line
  the form shows the program and the arguments that the host will start, or
  the reason it refuses the line. The form says where the command runs and
  that it does not sync to other hosts. **Start and test** adds the record,
  saves the values, starts the process, and lists the tools; while it runs,
  **Cancel** stops the process. On desktop and web, a dialog that closes
  before the end removes the command it added. The command palette has
  "Add an MCP server command".
- The row shows the command line in place of an address, and the state of
  your process: **Not started**, **Running**, **Stopped** (after 10 minutes
  with no use, at Stop, or when the host stopped), **Stopped by itself**,
  **Failed**, **Not installed**, or **Cannot run**, with what the host said
  and the last standard error. The actions are **Start and test**, **Stop**,
  **Start again**, and **Test again** (it checks the protocol revision
  again). A start or stop on another client shows at once: the row reads the
  state again on each `integration.changed` event.
- **Values** in the row says how many values are saved, never a value.
  **Enter values** or **Change values** opens one masked field for each
  name; **Disconnect** removes them. The conversation's connect card takes
  the values the same way. A value goes to the host in the call that saves
  it, and the client keeps no copy. The values never go to Solus Cloud.
- **Edit** (and "Edit command" in the row menu) changes the line, the
  folder, and the names. The host stops the process and forgets the saved
  facts; new names remove every person's values.
- A person without `host.admin` sees the command and its state and can stop
  it, disconnect, and remove it. Add, Edit, and the starts are off, with
  "Only an administrator of this host can add or change a command."

## Found on this host

Settings → MCP has the view **Found on this host**, after Installed in the
rail (`docs/plans/mcp-first-class.md` §8). On mobile it is the section under
Installed. The command palette opens it with "Find MCP servers on this host".
It lists the MCP servers in the config files of other tools on the host:

| File | Read for |
|---|---|
| `<project>/.mcp.json`, `<project>/.cursor/mcp.json`, `<project>/.vscode/mcp.json` | a person who may use the project |
| `~/.claude.json` (`mcpServers`, and `projects["<path>"].mcpServers`) | a person with `host.admin` |
| `~/.cursor/mcp.json`, the VS Code user `mcp.json`, Claude Desktop's `claude_desktop_config.json` | a person with `host.admin` |
| `~/.codex/config.toml` and the project's `.codex/config.toml`, through Codex (`config/read`) | the same; Codex leaves out a project it does not trust |

On desktop and web, the project is the one of the open session when it is on
that host. Mobile reads the user files only.

- **Nothing is added by itself.** A command in a cloned repository is code
  that would run on the host. **Add** shows the full command or URL. The host
  reads the file again and refuses an entry that changed after you saw it.
- A command needs `host.admin` and does not start when you add it. Start it
  from Installed.
- The same command or URL in two files is one row that names both files.
- Only names leave the host. A plain value in `env`, or a fixed
  `Authorization` header, is copied into your connection on the host when you
  choose to use the file's values.
- A server that only a project file holds joins only that project's runs.
- **Review change** shows a server whose command or URL changed in its file
  since you added it. **Update** takes the new one.
- Not supported: the deprecated HTTP+SSE transport, and `${…}` in a command,
  its arguments, its folder, or a URL. Solus expands nothing.
- A file that is not JSON, larger than 1 MB (8 MB for `~/.claude.json`), or a
  link out of its folder is listed with the reason, and the others still read.
- The host keeps a list for 10 seconds. **Refresh** reads the files again.

The provider CLI still loads a server you added from its own file. Phase C2 of
the plan makes each run leave out that copy.

## Long tool calls (MCP tasks)

A server of revision 2026-07-28 can run a tool call as an MCP task (the
extension `io.modelcontextprotocol/tasks`). The server decides; Solus declares
the extension on each request.

- The call waits up to 30 seconds. An MCP task that ends in that time is the
  tool's result, and the agent sees nothing special.
- After 30 seconds the call answers that the work runs in the background, and
  the turn can end. The host asks the server for the status (`tasks/get`) as
  the person who made the call, at the server's interval within 1 to 60
  seconds. When the MCP task ends, the host sends its result to the session
  once, as a queued message: the transcript shows it as an **MCP task**
  notice, and the agent answers it in a new turn. A failure and an expiry
  send their reason. Both providers get the same text.
- The session's background work shows each MCP task: the server and the
  tool, its state, the time since the start, and **Cancel**. A question of
  the server shows **Answer**, which opens the question card. While an MCP
  task is live, the session's status is `background`.
- Cancel asks the server to stop. The row says "Cancelling…" until the
  server reports the end, at most 2 minutes. A cancelled MCP task sends no
  message. Stop of the turn in the first 30 seconds cancels the MCP task;
  later it does not touch it.
- A server that cannot be reached, or a sign-in that stopped working, shows
  on the row; the MCP task stays live until it expires. A new sign-in
  continues it.
- After a restart of the host, the host asks again for each MCP task of a
  server at a URL, and delivers an end that came while it was down. The MCP
  tasks of a command (stdio) fail, because the process is gone.
- Limits: 5 live MCP tasks for one session and 50 on a host (a call past
  either is cancelled and refused); 24 hours for one MCP task, or the
  server's `ttlMs` when shorter; 10 results that start one session in an
  hour (more stay on the row). A deleted session cancels its MCP tasks.
- An MCP App cannot wait for an MCP task: its call gets an error, and the
  host cancels the work.

The server's task id stays on the host. Plan:
`docs/plans/mcp-first-class.md` §12; handoff: `docs/plans/mcp-g-handoff.md`.

## Who may change what

Every person adds, renames, and removes their own servers, sets their OAuth
client, and turns their tools on and off. Nobody else sees or changes them,
the host owner and an organization owner included (docs/plans/access-model.md
§2.3). A guest has none.

## Not in this release

A per-tool ask rule (only on and off exist), OpenAPI documents, renaming an
account, and several API keys for one server are later phases of the plan. Watching a
resource for changes is a later phase too. The tools you turned off are part of your agent profile, so they
follow a personal server to every host.
