# Use Solus in other apps

Apps outside Solus, such as Claude Desktop, Cursor, or Claude Code and Codex in a terminal, can use the tools of a Solus host over MCP. The host serves them at `/mcp`. Agents inside Solus use the same address.

## Connect an app

1. Open the host's **Access** tab (on mobile, the host page) and find **Use Solus in other apps**. The command palette command **Use Solus in other apps** opens it too. Copy the MCP address.
   - An app on the same computer as the host uses `http://localhost:<port>/mcp`.
   - An app on another computer, or a cloud app such as claude.ai, uses the public address. Only a host with a public tunnel has one.
2. Add the address to the app. For Claude Code:

   ```sh
   claude mcp add --transport http solus <address>
   claude mcp login solus
   ```

3. The app opens a sign-in page. Choose the access, then approve the app in one of two ways:
   - **Approve in the Solus app.** The host owner sees the request on desktop, web, and mobile. Check that its code is the same as the code on the sign-in page.
   - **Use a pairing code.** Make one with **Make pairing code**. A code works once and lasts ten minutes.

The section lists known apps (Claude, ChatGPT, Grok Bot, Poke, Cursor, Claude Code, Codex) with how to add Solus to each.

Through the public address, and on a cloud machine, only a pairing code approves an app.

## Who the app acts as

The app acts as the person who approved it. The host owner approves in the Solus app or with a pairing code. A member of an organization that uses the host makes a pairing code in their own Solus client; their app then acts as them, with their access. A member's app stops within five minutes after the member loses access to the host.

## Access

| Access | The app can |
|---|---|
| Read | Read works, projects, codebases, tasks, automations, sessions, the links of a session, pull requests and their checks, and the results of messages the app sent. |
| Read and write | Also create and change records, start, message, and stop sessions, and rerun checks. |
| Full | Also use tools that ask for approval inside Solus, such as changing a work, running an automation, linking items to a session, and changing, reviewing, or merging a pull request. |

The app works as you, and only where you can work yourself. It does not get your integration tokens. To use an integration (for example Google), the app starts a Solus session, and the agent in that session uses your integrations.

## Sessions and pull requests

The app is not inside a Solus session, so it names what a tool acts on:

- **A session.** `link`, `unlink`, and `list_links` take `session_id`. Get ids from `search_sessions` or `start_sessions`.
- **A project.** The pull request tools take `project`, a project from `list_projects`, and use that project's code host. `repository` must be the project's repository.
- **The results of its messages.** A session that the app starts or messages sends no report to the app. The app waits for the result in the same call with `wait_seconds`, or reads it later with `read_session_exchange` and the exchange id. Only the app that sent a message reads its exchange.

Tools that act as the calling session (for example the browser, devices, checkouts, secrets, and opening a pull request from a checkout) are only for agents inside Solus.

## Revoke an app

Connected apps are listed with their access: on desktop and web with the paired devices on the host's **Access** tab, on mobile under **Connected apps**. **Revoke** ends the app's access at once. An app that is not used for thirty days must sign in again.

## Limits

- An organization can choose which apps its members may connect: in its policy, **Outside apps** under the session limits. With no choice, every app may connect. An app the policy does not allow cannot sign in, and an app approved before stops working.
- Solus knows an app by where its sign-in returns. An app on your own computer, such as Claude Code or Codex, is one of **Apps on your computer**. An app Solus does not know is one of **Other apps**.
