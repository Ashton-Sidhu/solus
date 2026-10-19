# Conversation cards across clients

Implemented 2026-10-16. Reference: T3 Code commit
`e74f477eed81012834e518ba172d0a83e33fe55e` (MIT; `apps/mobile/UPSTREAM.md`).
The requested cards follow T3 layout and interaction patterns with Solus colors.
Desktop and web share the Svelte implementation. Mobile uses native views.

## HTML saved from a file

A successful `render_artifact` or artifact `update_work` receipt names the work
and saved content version. A mobile card reads that version when it mounts. It
first checks the current version, then the saved revisions. A missing revision
shows an error and retry action. It never reads the agent's filesystem path or
uses a newer version in place of the one the call saved. Reads are deduplicated;
a reply from before reconnect cannot change the new transcript.

## Review comments

`review-comment.ts` owns the shared review block parser and serializer. A user
message can contain prose and several review cards. Each card keeps the file,
section, line range, comment, and selected source together. Mobile keeps T3's
native diff surface and its plain-text fallback. Desktop/web keep Solus syntax
colors and can open the file at the displayed line. Diff selection indexes are
not file line numbers. Existing native review feedback and desktop diff feedback
produce the same block format.

## Provider child conversations

A provider subagent row opens a read-only child view. Live child rows remain
under the parent call. Saved embedded rows restore there. When no embedded
history exists, `loadSessionSubagent` reads the parent's provider transcript,
checks the requested tool, and resolves a Codex `agent_thread_id` from that
recorded call. Clients cannot supply a child thread ID or provider file path.
The parent session's resource role authorizes the read. Cursor scope includes
the parent, tool, and resolved child. Pages contain twenty user turns and use the
normal tool-result projection and ordinary input summaries. Earlier pages,
refresh, and retry are available while the view is open. No polling runs.

Claude's embedded child history is supported. A legacy call without recorded
child rows or a separate Codex identity can only show its brief and report.
Solus child sessions continue to use their own normal conversation screen.
Provider files are read from the execution host; a cloud record alone cannot
supply a separate provider child transcript.

## Worktree setup

The host's existing `status_card` event is part of the normalized event contract.
It carries bounded output (up to 100 lines, 2,048 characters per line) and the
base branch needed for retry. The UI shows actual stages: branch and worktree
creation, workspace linking, and provider startup. A joining client can read the
latest setup state before a provider runtime exists. Native Details shows the
last four output lines in a fixed window. Failure offers retry and work locally;
active setup offers cancel. Completion ends the active stages.

These are setup operation messages. Solus has no setup-script runner in this
flow, so there are no script execution stages, percentages, or terminal buttons.
Setup state uses the existing in-memory turn replay and recovery ownership;
it is not a new durable setup-job model.

## MCP Apps

A card is triggered after a successful Solus-managed integration tool call
whose metadata declares `_meta.ui.resourceUri` (or legacy `ui/resourceUri`).
The host reads that `ui://` resource from the same integration. It must use
`text/html;profile=mcp-app`. Ordinary MCP tools and ordinary HTML do not trigger
an app card. Both Claude and Codex use this gateway path; provider-owned MCP
configuration outside the Solus integration gateway does not use this capture.

The host saves immutable HTML, CSP, initial arguments, and initial result in a
content-addressed asset. A session activity stores its reference. Existing
activity persistence restores the card. The body loads when the card is near
the viewport on desktop/web, or mounts in the native feed. Snapshot caches are
bounded and deduplicate reads. No filesystem path crosses to the client.

The app runs in an opaque iframe with scripts enabled and a restrictive CSP.
Native uses an outer WebView document with a secret-authenticated relay because
Android exposes its native message bridge to nested frames. Replies only reach
the expected frame. Navigation stops its bridge. Closing disposes it; reopening
or full-screen native presentation initializes a new frame.

Supported protocol operations are initialize, initial tool data, tool calls,
resource reads, text messages, external HTTP(S) links, display mode, size,
and close. The host sends light/dark context and Solus CSS variables. It does
not advertise file downloads or model-context updates. Unsupported requests
receive a protocol error. Snapshot HTML is limited to 5 MiB, and tool data and
interaction results to 1 MiB. Each frame can hold at most sixteen requests.

Writes need approval. A user message and external link also need approval.
Read-only tools can run directly. A host call rechecks current read-only hints,
visibility, disabled tools, integration ownership, and the caller's parent
session role. An app can only use its own integration. App-only tools are not
listed to the agent. Calls use the person's current integration connection;
no provider turn starts just to service an app. Approved messages enter the
conversation's normal queue.

The saved card can still display its captured document after the provider exits.
Interaction requires the integration and the person's connection to remain
available. Removal, disconnect, refused approval, and missing assets return an
error instead of starting an agent or silently switching accounts.

## Scope and validation

This change restores file-backed HTML cards, review cards, provider child views,
worktree setup details, and MCP Apps on mobile, desktop, and web. It does not
change ordinary tool output into a rich terminal/diff result view: the host's
projection still omits most result bodies. That requires its own on-demand
result contract.

Focused tests cover saved-version reads and reconnect guards, child ownership
and pagination, review serialization, live card restoration, real HTTP MCP tool
metadata/resources, app capture persistence, visibility, and approval refusal.
No build or new dev server is required for these tests. A device and desktop
visual pass is still required to establish pixel equality with the reference.


Review notes: the existing mobile conversation controller and transcript model
remain above 600 lines (below 1,000). This change adds focused child-history and
MCP modules instead of putting those loaders in the controller. Wider server,
client-core, and Svelte checks report errors outside the added modules. The
existing worktree Git tests fail the host's Git availability probe in this test
environment. The available web preview returned `401 Unauthorized`; no device
or interactive desktop run was started.
