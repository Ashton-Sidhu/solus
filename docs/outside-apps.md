# Use Solus in other apps

Apps outside Solus, such as Claude Desktop, Cursor, or Claude Code and Codex in a terminal, can use the tools of a Solus host over MCP. The host serves them at `/mcp`. Agents inside Solus use the same address.

## Connect an app

Every person who uses the host can connect an app: the owner, and each member of an organization the host works for.

1. Open **Use Solus in other apps**:
   - from the command palette (search for "mcp", "connector", or an app name);
   - with **Connect an app** on the host's **Access** tab;
   - from the host's menu on the fleet map;
   - on mobile, from the host page.
2. **Which app?** Choose Claude, ChatGPT, Grok Bot, Poke, Muse, Instinct, Cursor, Claude Code, Codex, OpenClaw, or Hermes Agent. For another app, choose **Something else…**. An app that your organization does not allow is marked and cannot be chosen. Mobile shows only the apps that run in the cloud, because a phone cannot run commands or open Cursor.
3. **What can the app do?** Choose Read, Read and write (the default), or Full. See [Access](#access).
4. **Connect.**
   - The main button opens the app with the address filled in, or copies the address or a message and then opens the app. For an app that runs on a computer, Solus shows the commands to run.
   - For an app that opens a link, a QR code opens the same link on your phone.
   - **Get code** makes a pairing code for the access you chose. It shows "Expires m:ss · one use" and counts down. When it expires, get a new code. Solus does not copy the code for you.
   - **Set up another way** shows the address, the message, the steps for that app, a note about the app, and a link to the app's help.
5. The app opens a sign-in page on the host. The page names the app, and the place where its access goes. When the app is on the computer that opened the page, the page says so. Approve the app in one of two ways:
   - **Pairing code.** Type the code from step 4. The code gives the access that was chosen when it was made.
   - **Approve in the Solus app.** The host owner sees the request on desktop, web, and mobile. Check that its code is the same as the code on the sign-in page. The access is the one chosen on the sign-in page.

   - **Approve as {name}.** When this browser is signed in to the host's web client at the same address, the page offers to approve as you, with the access chosen on the page. No code is needed.

   **Deny** sends the app away with no access. Approve only a sign-in that you just started.

Through the public address, and on a cloud machine, only a pairing code approves an app.

### Before the steps

Apps that run in the cloud need the host's public address. Before the steps, Solus checks that the host has one and that the host answers on it:

- **Not registered.** The host is not linked to a Solus account. Link it first.
- **Public address off.** The owner turns it on with **Turn on**, on the host's own computer. Solus waits up to 90 seconds for the address. Other people see where to turn it on.
- **Offline.** The host's connection test failed. Solus shows the reason and **Check again**.

An app on the host's own computer, such as Claude Code or Codex next to the desktop app, uses `http://localhost:<port>/mcp` and needs no public address.

### Copy the address

**Copy MCP address** in the host's menu copies the address. To add it by hand, for example to Claude Code:

```sh
claude mcp add --transport http solus <address>
claude mcp login solus
```

When the clipboard is not available, Solus shows the value in a dialog, with a QR code for an address that another device can open.

### On a host with no screen

On the host, `solus mcp` prints the MCP addresses and the commands that add Solus to Claude Code and Codex. `solus mcp code --access read|write|full` prints a one-time pairing code for the owner (the default access is write). On a machine with no browser, add `--no-browser` to `claude mcp login`. It prints the sign-in address: open it in a browser on another computer, then paste back the address that browser goes to.

## Who the app acts as

The app acts as the person who approved it. The host owner approves in the Solus app or with a pairing code. A member of an organization that uses the host makes a pairing code in their own Solus client; their app then acts as them, with their access. A member's app stops within five minutes after the member loses access to the host.

An organization can choose the apps its members may connect: in Settings → Policy, **Outside apps** in the policy editor writes `sessions.limits.apps.allowed`. The picker marks the other apps as not allowed, and the host refuses them.

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

Connected apps are listed with their access and when each one last connected: on desktop and web with the paired devices on the host's **Access** tab, on mobile under **Connected apps**. **Revoke** ends one app's access at once. **Revoke all apps** ends the access of every app, after you confirm. An app that is not used for thirty days must sign in again.

## Limits

- An organization can choose which apps its members may connect: in its policy, **Outside apps** under the session limits. With no choice, every app may connect. An app the policy does not allow cannot sign in, and an app approved before stops working.
- Solus knows an app by where its sign-in returns. An app on your own computer, such as Claude Code, Codex, OpenClaw, or Hermes Agent, is one of **Apps on your computer**. An app Solus does not know is one of **Other apps**. Solus does not know yet where Muse and Instinct sign-ins return, so a policy counts them as **Other apps**.
- An app can register only a sign-in return address that uses `https`, `localhost`, or the app's own scheme (such as `cursor:`).
