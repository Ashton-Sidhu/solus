# Agent sign-in commands

Status: implemented (2026-10-04).

## Problem

The Claude and Codex CLIs keep some sign-in commands for their interactive
terminal. Through the SDK or the app-server, `/login` and `/design-login` fail, and
`/mcp` cannot authenticate a server. A user had to leave Solus and open a terminal
on the host to update their auth.

## Commands

Solus runs these commands itself. They never go to the agent.

| Command | Agents | What it does |
|---|---|---|
| `/login` | Claude, Codex | Opens the seat sign-in card in the conversation. |
| `/design-login` | Claude | Signs in to Claude Design. |
| `/mcp login <server>` | Claude, Codex | Signs in to one MCP server with OAuth. |
| `/mcp logout <server>` | Claude, Codex | Clears the stored OAuth credential of one MCP server. |

Plain `/mcp` and all other `/mcp` arguments still go to the agent.
`parseAgentAuthCommand` in `packages/contracts/src/agent-auth.ts` is the one rule
for what is a sign-in command. All clients use it.

## Ownership

Every sign-in runs on the host in the **caller's own seat** (see
`provider-seats.md`). The credential goes where the turns of that person read it.
No credential passes through Solus.

- `/login` uses the seat connect (`seatConnectStart` and the related calls) without
  change. The card can also start a new sign-in over a seat that is connected.
- The other commands use `AgentAuthFlows` (`packages/server/src/execution/seats/agent-auth.ts`)
  and the RPC methods `agentAuthStart`, `agentAuthSubmit`, `agentAuthCancel`, and
  `agentAuthSignOut`. The end of a flow arrives as `host.agentAuthFinished`, which
  goes only to the clients of that seat. A flow belongs to the seat that started it.
  One person has a maximum of one flow at a time.

## How each sign-in runs

- **Claude Design**: `claude design-login --json`, the relay of the VS Code
  extension. The client shows the manual page, and the person pastes the code.
  `CLAUDE_CODE_CHILD_SESSION` is removed, because the CLI refuses a nested session.
- **Claude MCP**: an SDK query with no turn, in the session's directory, sends the
  control requests `mcp_authenticate`, `mcp_oauth_callback_url`, and
  `mcp_clear_auth`. The SDK does not declare these requests, so
  `claude-mcp-auth.ts` checks for them at runtime. The SDK sends no end event, so
  the flow reads the server status until it is `connected`. For this reason, a
  server that is already connected is not authorized again. The user must run
  `/mcp logout` first.
- **Codex MCP**: `codex mcp login --no-browser <server>` and `codex mcp logout <server>`.

The OAuth redirect goes to `localhost` on the host. On the host itself, the browser
finishes the sign-in. On another device, the page does not load, and the person
pastes the address of that page into Solus. A claude.ai connector finishes on
claude.ai, and nothing comes back (`external`).

## Clients

- Desktop and web: `AgentAuthCard` and `agentAuthStore`, beside the seat card in
  the conversation. The commands are Solus slash commands with a provider filter.
- Mobile: `AgentAuthFlow` and `AgentAuthSheet` in `apps/mobile/src/features/conversation/`.

## Limits

- A command needs a conversation. A draft shows a note.
- After a reconnect, the mobile client closes a waiting MCP or Design flow as
  failed, because the host does not keep the end event.
- The Codex `--no-browser` stdin relay and the Design JSON protocol are CLI
  behavior. A CLI update can change them.
