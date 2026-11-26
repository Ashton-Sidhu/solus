# Use Solus in other apps

Apps outside Solus, such as Claude Desktop, Cursor, or Claude Code and Codex in a terminal, can use the tools of a Solus host over MCP. The host serves them at `/mcp`. Agents inside Solus use the same address.

## Connect an app

1. Open **Settings → Connections → Use Solus in other apps** and copy the MCP address.
   - An app on the same computer as the host uses `http://localhost:<port>/mcp`.
   - An app on another computer, or a cloud app such as claude.ai, uses the public address. Only a host with a public tunnel has one.
2. Add the address to the app. For Claude Code:

   ```sh
   claude mcp add --transport http solus <address>
   claude mcp login solus
   ```

3. The app opens a sign-in page. Choose the access, then approve the app in one of two ways:
   - **Approve in the Solus app.** Solus shows the request on desktop, web, and mobile. Check that its code is the same as the code on the sign-in page.
   - **Use a pairing code.** Make one with **Make pairing code**. A code works once and lasts ten minutes.

Through the public address, only a pairing code approves an app.

## Access

| Access | The app can |
|---|---|
| Read | Read works, projects, codebases, tasks, automations, and sessions. |
| Read and write | Also create and change records, and start and stop sessions. |
| Full | Also use tools that ask for approval inside Solus, such as changing a work or running an automation. |

The app works as you, and only where you can work yourself. It does not get your integration tokens. To use an integration (for example GitHub or Google), the app starts a Solus session, and the agent in that session uses your integrations.

Tools that act as the calling session (for example the browser, devices, checkouts, and secrets) are only for agents inside Solus.

## Revoke an app

Connected apps are listed with your paired devices in **Settings → Connections**. **Revoke** ends the app's access at once. An app that is not used for thirty days must sign in again.

## Limits

- A cloud machine does not take outside apps. It has no pairing, so nothing can approve one.
- Only the host owner approves an app. Approval with a Solus account, for organization members, is not available yet.
