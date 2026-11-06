# Host connection troubleshooting

When Solus cannot reach a host, it shows the connection in stages and marks the
first stage that failed. Use this guide to find the fix for that stage.

## The stages

A host that has a tunnel has four stages, in this order:

1. **This device.** Your phone, laptop, or browser reaches the internet.
2. **Solus Cloud.** This device reaches your account service. Solus Cloud gives
   this device the host's address and a sign-in token.
3. **The host's tunnel.** `cloudflared` on the host holds a connection to
   Cloudflare, and Cloudflare carries your request to the host.
4. **Solus on the host.** The Solus server answers.

A host that has only direct addresses (a local network, Tailscale, or an SSH
forward) has two stages: **This device** and **Solus on the host**.

Each stage shows one of these results:

| Result | Meaning |
|---|---|
| OK | The check has evidence that this stage works. |
| Failed | The check ran, and this stage did not pass from where the check ran. |
| Unknown | The check has no evidence. Do not read this as a pass or a failure. |

A check on this device cannot see the host, and a check on the host cannot see
this device. Run both when a stage is Unknown.

## Check from this device

In the conversation, select **Details** on the host card. Solus reads each address
of the host and Solus Cloud one time. Select **Check again** to read them again.
**Copy details** copies the stages, for a support message.

On the desktop app and on the web, a browser cannot read the error page of a
tunnel. When the tunnel answers with an error, the tunnel and host stages stay
Unknown. The Solus mobile app can read the error, so it can name the stage.

## Check from the host

Run this command on the host:

```sh
solus connect status
```

You can also open **Settings > Hosts**, select the host, open **Access**, and select
**Run test** under **Connection test**. On the desktop app, the test for this
computer is in **Settings > Account & sync**. On a phone, open the host's settings,
open **Access**, and select **Run connection test**. A client must be connected to
the host to run this test. When no client can connect, use the command.

The test checks Solus Cloud, `cloudflared`, TCP port 7844, the host's public
address, and the tunnel listener. It cannot test the network of another device.
The other devices stage is always Unknown.

Add `--json` to get the result for a script.

## This device is offline

The device says that it has no network.

1. Connect this device to the internet. Solus reconnects by itself.

## This device cannot reach Solus Cloud

This device did not get an answer from Solus Cloud. The problem is usually on this
device or its network, not on the host.

1. Check the internet connection of this device. A captive Wi-Fi network can look
   connected and reach nothing.
2. Stop the VPN, firewall, ad blocker, or DNS filter on this device for a short
   time, then check again.
3. Try another network.

If Solus Cloud returned an error, wait a few minutes. Solus keeps trying.

A host can still work when Solus Cloud is down: a sign-in token stays valid for
some hours, and direct addresses do not use Solus Cloud.

## This device cannot reach the host's tunnel

Solus Cloud answered, but the tunnel address did not.

1. Stop the VPN, firewall, or DNS filter on this device for a short time.
2. Try another network.
3. Use a direct address, such as a Tailscale address.
4. On the host, run `solus connect status`. If the host was unlinked, its tunnel
   address does not exist. Run `solus connect` on the host.

## The host's tunnel is offline

Cloudflare answered with HTTP 530: no connection from the host is live. The test on
the host names one of these causes.

| Test result | Fix |
|---|---|
| The host does not answer the command | Make sure that the host is on and awake, and that it has a network. |
| The Solus server is not running | Run `solus service start`. |
| `cloudflared` is not installed | Run `solus connect`. It installs `cloudflared`. |
| The tunnel client is not running | Restart Solus. If it stays down, read the log with `solus logs`. |
| `cloudflared` has not connected yet | Wait a minute. If it stays, check the network. |
| Port 7844 does not answer | See [Port 7844 is blocked](#port-7844-is-blocked). |
| Cloudflare has no live connection | Restart Solus. If it stays, run `solus connect` again. |

### Port 7844 is blocked

`cloudflared` connects out to Cloudflare on port 7844, with TCP and UDP. When a
network blocks this port, the tunnel cannot start, but normal web traffic still
works. The host looks online, so this problem is easy to miss.

The test opens a TCP connection to Cloudflare on this port. It does not test UDP.
A failed TCP test counts only when `cloudflared` has no connection.

Common causes:

- **A Tailscale exit node on the host.** The host sends its internet traffic through
  the exit node, and that network blocks the port. The test names the exit node.
  Run `tailscale set --exit-node=` on the host, or allow outbound port 7844 on the
  network of the exit node.
- **A VPN on the host.** Work VPNs often block unknown ports. Ask for port 7844 to be
  allowed, or use a direct address.
- **A firewall.** Allow outbound TCP and UDP port 7844.

If you cannot open the port, connect without the tunnel. When the host and this
device are on the same Tailscale network, Solus uses the Tailscale address.

## The tunnel works, but Solus on the host did not answer

Cloudflare answered with HTTP 502. The tunnel is up, but it cannot reach Solus on
the host.

| Test result | Fix |
|---|---|
| A port is in use | Free the port and restart Solus, or turn the link off and on again. |
| The tunnel listener does not answer | Restart Solus. |
| The tunnel cannot reach Solus | Restart Solus. If it stays, run `solus connect` again. |

## The address does not resolve or answer from the host

The test on the host could not read the host's public address.

1. Check the DNS settings, VPN, and proxy on the host.
2. If the test names a Tailscale exit node, turn it off and test again.

## The host's address answered with an HTTP status

Something other than Solus answered at the address. A proxy or firewall on this
device can answer in place of the host. Stop it, or try another network. On the host,
run `solus connect status`.

## The tunnel or Solus did not answer, and both stages are Unknown

The desktop app and the web client could not read the answer. Make sure that the
host is awake and that Solus runs on it. Then run `solus connect status` on the host,
or open **Details** in the Solus mobile app.

## The host answers, but the connection did not open

The host answered a health read, but the WebSocket connection did not open.

1. Select **Retry now**.
2. A proxy or VPN on this device can block WebSockets. Stop it for a short time.
3. If the two versions in **Details** differ, update Solus on the host.

## A server did not prove that it is the host

A server answered at the address, but it did not prove that it is the host you saved.

1. If this is the machine you mean, pair it again.
2. A captive Wi-Fi page can also answer at an address. Sign in to the Wi-Fi network.

## The host did not answer at its address

The host has only direct addresses, and none of them answered this device.

1. Make sure that the host is on and awake, and that Solus runs on it.
2. For a local address, make sure that this device is on the same network.
3. For a Tailscale address, make sure that Tailscale is on, on both machines.
4. For an SSH forward, add the host again. The forward may have stopped.

## The host needs pairing again

The host answered and refused this device. Select **Pair again**.

## The test says that the machine is not linked

This is not a failure. Clients connect to this host directly. To reach the host from
anywhere, run `solus connect`. A policy can turn the tunnel off. The test says so.

## The host cannot reach Solus Cloud

The test on the host did not get an answer from Solus Cloud. Check the internet
connection, VPN, and DNS on the host. If the tunnel still works, other devices can
reach the host, but a new sign-in and new links can fail until Solus Cloud answers.

## Report a problem

Include these items:

- The text from **Copy details**.
- The output of `solus connect status` on the host.
