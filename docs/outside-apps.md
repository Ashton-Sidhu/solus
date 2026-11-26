# Use Solus in other apps

Apps outside Solus, such as Claude Desktop, Cursor, or Claude Code and Codex in a terminal, can use the tools of a Solus host over MCP. The host serves them at `/mcp`. Agents inside Solus use the same address.

## Connect an app

Every person who uses the host can connect an app: the owner, and each member of an organization the host works for.

1. Open **Settings → Sharing & access**, choose the host in the host picker, and select **Connect an app** under **Use Solus in other apps**. The picker starts on the host of the current session, else on the host of this device. A link names its host: `settings/sharing/<host id>`.

   Other entry points open the same dialog or page:
   - the command palette: **Use Solus in other apps** (search for "mcp", "connector", or an app name) and **Approve an app sign-in** open the dialog for this device's host; **Sharing & access** opens the page;
   - the host's menu on Settings → Hosts (right-click a host on the map or in the list, or press the menu key): **Use Solus in other apps…**, **Copy MCP address**, and **Sharing & access**;
   - on mobile, the host page.
2. **Which app?** Choose Claude, ChatGPT, Grok Bot, Poke, Muse, Instinct, Cursor, Claude Code, Codex, OpenClaw, or Hermes Agent. For another app, choose **Something else…**. An app that your organization does not allow is marked and cannot be chosen. Mobile shows only the apps that run in the cloud, because a phone cannot run commands or open Cursor.
3. **What can the app do?** Choose Read, Read and write (the default), or Full. See [Access](#access).
4. **Connect.**
   - The main button opens the app with the address filled in, or copies the address or a message and then opens the app. Cursor installs Solus from one link. For an app that runs on a command line, Solus shows the commands to run.
   - For a cloud app that opens a link, a QR code opens the same link on your phone. For ChatGPT, which takes a pasted address, the QR code gives the address to your phone.
   - **Get code** makes a pairing code for the access you chose. It shows "Expires m:ss · one use" and counts down. When it expires, get a new code. Solus does not copy the code for you.
   - **Set up another way** shows the address, the message, the steps for that app, a note about the app, and a link to the app's help.
5. The app opens a sign-in page on the host. The page names the app, and the place where its access goes. When the app is on the computer that opened the page, the page says so. Approve the app in one of these ways:
   - **Approve in Solus.** Choose the access, then approve as yourself in a Solus client where you are signed in. This works for the owner and for members, also through the public address. The page shows a code and a QR code, and waits ten minutes:
     - On your phone, scan the QR code with the camera. The Solus app opens the sign-in.
     - On desktop or web, open **Approve a sign-in** in **Use Solus in other apps** (or the command palette command **Approve an app sign-in**) and type the code.
     - When the host serves its web client at the page's address, **Open Solus on the web** opens the sign-in there.

     Solus shows the app, where its access goes, the access, and the time left. **Approve** or **Deny**. Then go back to the app.
   - **Approve as {name}.** When this browser is signed in to the host's web client at the same address, the page approves as you with one click, with the access chosen on the page.
   - **Pairing code.** Type a code from step 4. The code gives the access that was chosen when it was made.
   - **Ask the host owner.** On the host's own network, the owner sees the request on desktop, web, and mobile. Check that its code is the same as the code on the sign-in page.

   **Deny** sends the app away with no access. Approve only a sign-in that you just started.

Through an address that comes through a proxy (the Solus tunnel, Tailscale Serve or Funnel, or your own address), and on a cloud machine, the owner is not asked: approve in Solus, or use a pairing code. See [Security](#security).

### Before the steps

Apps that run in the cloud need an address that the internet reaches. Before the steps, Solus checks that the host has one, and tests it.

- **No address.** Solus shows one screen, **Give {host} an address apps can reach**, with three ways. See [Give the host an address](#give-the-host-an-address).
- **The test.** Solus tests the chosen address before the steps: the host asks its own address, as an app does. When the test fails, Solus shows the reason and **Check again**. When the host cannot reach its own address (see [the test](#test-an-address)), Solus also shows **Go on anyway**.

An app on the host's own computer, such as Claude Code or Codex next to the desktop app, uses `http://localhost:<port>/mcp` and needs no other address. An app on another computer of yours can also use the Tailscale Serve address.

On a phone, Solus offers only the apps that run in the cloud, so the host needs an address that the internet reaches. A phone cannot turn on Tailscale Funnel.

### Copy the address

**Copy MCP address** in the host's menu on Settings → Hosts copies the address, and a toast shows the command that adds it to Claude Code. To add it by hand, for example to Claude Code:

```sh
claude mcp add --transport http solus <address>
claude mcp login solus
```

When the clipboard is not available, Solus shows the value in a dialog, with a QR code for an address that another device can open.

### On a host with no screen

On the host, `solus mcp` prints the MCP addresses, each with its source, and the commands that add Solus to Claude Code and Codex. `solus mcp code --access read|write|full` prints a one-time pairing code for the owner (the default access is write). On a machine with no browser, add `--no-browser` to `claude mcp login`. It prints the sign-in address: open it in a browser on another computer, then paste back the address that browser goes to.

## Give the host an address

A host does not have to be linked to a Solus account for outside apps. The host serves `/mcp` and its own sign-in at every address that reaches it. There are three ways to give it an address: a Solus account, Tailscale (Serve, and Funnel on top of it), and your own address.

| Way | Who can reach it | Who sets it up |
|---|---|---|
| Link the host to a Solus account | The internet | The owner, on the host's own computer |
| Tailscale Funnel | The internet | A local owner, on desktop or web (not on a phone) |
| Tailscale Serve | Only the devices on your tailnet | A local owner, on desktop or web (not on a phone) |
| Your own https address | The internet, or what your proxy allows | A host administrator (`host.admin`), on desktop, web, or phone |

**Settings → Sharing & access** lists each address with its source, who can reach it, a copy button, and its last test. The own address setting is on the same page.

### The order of the addresses

`connectionsAppEndpoint` gives the addresses in this order:

1. the Solus account link (internet);
2. Tailscale Funnel (internet);
3. your own address (internet);
4. Tailscale Serve without Funnel (tailnet only).

A cloud app uses the first internet address. An app on a computer can also use the Tailscale Serve address. With Funnel on, the Serve address is the Funnel address, so Solus lists it once, as Funnel.

### Solus account

Link the host to a Solus account: **Turn on** on the host's own computer, or `solus connect` on a host with no screen. Solus waits up to 90 seconds for the address.

### Tailscale Serve and Funnel

Tailscale Serve gives the host an https address on your tailnet: `https://<machine>.<tailnet>.ts.net/mcp`. Only the devices on your tailnet reach it. It is good for Claude Code, Codex, or Cursor on another computer of yours. A cloud app, such as Claude or ChatGPT, cannot reach it.

Tailscale Funnel gives the same address to the whole internet. Then cloud apps can reach it too.

1. As a local owner, on desktop or web, open **Settings → Sharing & access** and turn on **Tailscale HTTPS** (Serve). Remote access must be on.
2. Turn on **Funnel**. Solus runs `tailscale funnel --bg` for the same HTTPS port and the same local target as Serve, so the address does not change.

Funnel has these rules:

- Funnel uses only the HTTPS ports 443, 8443, and 10000. With another Serve port, Solus refuses Funnel and tells you to change the port.
- Your tailnet policy must allow Funnel for the device: the `funnel` node attribute (see https://tailscale.com/s/no-funnel), and HTTPS certificates. When the policy does not allow it, Solus shows Tailscale's reason.
- Turning Funnel off removes only Funnel. Serve stays on at the same address.
- Solus changes only the Serve mapping to this host. It does not change a mapping that another service made on the port.
- Solus keeps your Funnel choice. When it makes the Serve mapping again (after a restart, or when the mapping is gone), the mapping has Funnel again. Turning Serve off also turns Funnel off.

### Your own address

Use your own reverse proxy (Caddy, nginx, and others) or a tunnel of your own (for example Cloudflare Tunnel or ngrok). Then set the https origin in **Settings → Sharing & access → Your own address**, for example `https://solus.example.com`. Solus keeps only the origin: the scheme, the name, and the port.

The rules:

- **https only.** OAuth sign-in needs https. Solus refuses an `http:` address.
- **Not a name of this machine.** Solus refuses `localhost`, an IP address, the machine's own name, and its Tailscale name. Solus reads every request that names your address as a request through a proxy, so one of these names would remove the trust of every local request.
- **The proxy must say where the request came from.** It must keep the `Host` header, or set `X-Forwarded-Host`, and it should set `X-Forwarded-Proto`. A proxy that rewrites `Host` to `127.0.0.1` and sends no forwarded header makes every request from the internet look like a request from this machine. The test of the address finds this and tells you to fix the proxy.
- **Streams.** `/mcp` answers as a stream (server-sent events), and a tool call can take long. Turn off response buffering and give the proxy a long read timeout.

The proxy can send all paths to the host, or only the paths an app needs: `/mcp`, `/.well-known/oauth-*`, `/oauth/mcp/`, and `/health`. With only these paths, the internet does not see the web client or the pairing page.

`<port>` is the port of the host: the port in the `On this computer` address that `solus mcp` prints. The examples use 3001.

Caddy (it gets the https certificate itself):

```caddy
solus.example.com {
	@app path /mcp /health /.well-known/oauth-* /oauth/mcp/*
	handle @app {
		reverse_proxy 127.0.0.1:3001 {
			header_up X-Forwarded-Host {host}
			header_up X-Forwarded-Proto {scheme}
			flush_interval -1
		}
	}
	respond 404
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name solus.example.com;
    ssl_certificate     /etc/letsencrypt/live/solus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/solus.example.com/privkey.pem;

    location ~ ^/(mcp$|health$|\.well-known/oauth-|oauth/mcp/) {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    location / {
        return 404;
    }
}
```

When the proxy runs on another computer, it sends to the host's network address instead of `127.0.0.1`, and remote access must be on.

### Test an address

`connectionsTestAppAddress` tests one address that the host lists, by its source. The host asks `<address>/.well-known/oauth-protected-resource/mcp` from its own network, with a timeout of 5 seconds, and follows no redirect. The answer must name that `/mcp` as its resource, and `/health` must name this host. A failure gives a reason:

- the name does not resolve (DNS);
- the https certificate is not valid (TLS);
- no answer in 5 seconds, or no connection;
- an answer that is not Solus: an error status, a redirect, or a page that is not Solus's metadata;
- an answer from another Solus host, or one that names another `/mcp` address (a proxy that does not send the headers above).

A host often cannot reach its own public address from inside: Tailscale does not always let a device reach its own Funnel, and many routers do not let a device reach its own public IP address. Then the reason says that the address can still work from outside, and Solus does not call it down. Test it from a device on another network.

The host asks only an address that it lists. A client sends only the source, never an address, so a client cannot make the host fetch another address.

### Security

- A request through any proxy never gets the trust of a request from this machine. The host reads a request as proxied when it comes through the Solus tunnel; when it comes from loopback with `X-Forwarded-*` headers, or to the host's Tailscale name (Tailscale Serve and Funnel); when it carries Tailscale's `Tailscale-Funnel-Request` header; or when its `Host` or `X-Forwarded-Host` names your own address, from any network address.
- A proxied request must sign in, as a request from the internet does. On the sign-in page, **Ask the host owner** does not show, and the host refuses it. Approve in Solus, approve as yourself, or use a pairing code.
- The sign-in metadata names the address that the app used, so the app signs in at the same address.

## Who the app acts as

The app acts as the person who approved it. The host owner approves in the Solus app or with a pairing code. A member of an organization that uses the host makes a pairing code in their own Solus client; their app then acts as them, with their access. A member's app stops within five minutes after the member loses access to the host.

An organization can choose the apps its members may connect: in Settings → Policy, **Outside apps** in the policy editor writes `sessions.limits.apps.allowed`. The picker marks the other apps as not allowed, and the host refuses them.

## Access

| Access | The app can |
|---|---|
| Read | Read works, projects, codebases, tasks, automations, sessions, the links of a session, pull requests and their checks, your other hosts, and the results of messages the app sent. |
| Read and write | Also create works, and start, message, organize, and stop sessions, on this host and your other hosts. |
| Full | Also use tools that ask for approval inside Solus: change a work, change a task's status or comment on it, change, run, or delete an automation, link items to a session, change, answer, review, or merge a pull request, and rerun checks. |

The app works as you, and only where you can work yourself. It does not get your integration tokens. To use an integration (for example Google), the app starts a Solus session, and the agent in that session uses your integrations.

## Sessions and pull requests

The app is not inside a Solus session, so it names what a tool acts on:

- **A session.** `link`, `unlink`, and `list_links` take `session_id`. Get ids from `search_sessions` or `start_sessions`.
- **A project.** The pull request tools take `project`, a project from `list_projects`, and use that project's code host. `repository` must be the project's repository.
- **The results of its messages.** A session that the app starts or messages sends no report to the app. The app waits for the result in the same call with `wait_seconds`, or reads it later with `read_session_exchange` and the exchange id. Only the app that sent a message reads its exchange.
- **Your other hosts.** `list_hosts` lists the hosts that you reach from this host. `list_agent_targets` with `host` shows the models and projects of one of them, and `start_sessions` with `host` starts work there. The app then uses `send_session`, `read_session`, `stop_session`, and `read_session_exchange` on that session, as on a session on this host. The app reaches the same hosts as an agent that works for you here: the host owner reaches their own hosts, and a member reaches only through their organization. Only the app that started a session on another host can message or stop it from here, and only that app reads its results. The other host shows that you started the session. The session starts in the permission mode that it gets on this host, and the other host also applies its own policy.

Tools that act as the calling session (for example the browser, devices, checkouts, secrets, and opening a pull request from a checkout) are only for agents inside Solus.

## Revoke an app

Connected apps are listed with their access and when each one last connected: on desktop and web with the paired devices in **Settings → Sharing & access**, on mobile under **Connected apps**. **Revoke** ends one app's access at once. **Revoke all apps** ends the access of every app, after you confirm. An app that is not used for thirty days must sign in again.

## Limits

- An organization can choose which apps its members may connect: in its policy, **Outside apps** under the session limits. With no choice, every app may connect. An app the policy does not allow cannot sign in, and an app approved before stops working.
- Solus knows an app by where its sign-in returns. An app on your own computer, such as Claude Code, Codex, OpenClaw, or Hermes Agent, is one of **Apps on your computer**. An app Solus does not know is one of **Other apps**. Muse is known by its sign-in at `agent.meta.ai` or `muse.ai`. Instinct publishes no sign-in address, so Solus takes any address at `instinct.com`.
- An app can register only a sign-in return address that uses `https`, `localhost`, or the app's own scheme (such as `cursor:`).
