# Machines added over SSH

You can add any machine that you reach with `ssh user@host` as a Solus host. You do
not need to install Solus there first, and you do not need to open a port.

## Add a machine

1. Open **Settings → Hosts**, select **Add host**, then select the **SSH** tab. The
   **Run on** picker's **Add a host…** opens the same dialog. The command palette's
   **Add machine over SSH** and **Add machine over SSH** on a host's **Access** tab
   open it on the **SSH** tab. On mobile, use the add-host sheet or a host's settings.
2. Type the SSH target: an alias from `~/.ssh/config` or `user@host`.
3. Choose whether to link the machine to your Solus account.

The host that runs the SSH command does these steps. It shows each step, and a progress bar while Solus installs: the download fills most of the bar, then unpacking and the service start. When the add ends, the last row tells you how the machine is reached:

- It reads the machine. Linux, macOS, and Windows are supported.
- It installs Solus with the published installer when Solus is not there.
- It starts Solus as a service: a `systemd --user` service on Linux, a `launchd`
  agent on macOS, and a logon task on Windows. On Linux, the service stops at logout
  unless lingering is on (`loginctl enable-linger`).
- It uses a Solus server that already runs there, and does not take it over.

The SSH keys and `~/.ssh/config` of that host are used. On desktop, that host is this
computer. On web and mobile, it is the host you are connected to.

## With your account

The machine links to your account. Every device you sign in on reaches it through its
Cloudflare tunnel, and on a shared network also directly. A password or key
passphrase is accepted for this kind of add.

## Without an account

The host that ran the SSH command keeps an SSH forward open to the machine. The
machine listens only on its own loopback address, so no port opens on its network.

- Only the machine that holds the forward reaches it: the desktop app on that
  machine, and the agents of that host. Other devices show **Reachable only from
  <host>** and offer **Link to my account**.
- The forward signs in with an SSH key, or with a password or key passphrase. See
  [Password or key passphrase](#password-or-key-passphrase).
- When the forward stops (sleep, a network change, a restart), Solus opens it again.
  After a minute of failures, the host shows **Failed** and keeps trying once a
  minute.
- When the machine is also linked, the forward stays as its fastest route. If the
  forward fails while the tunnel works, the host shows **SSH route paused** and no
  error.

To remove the machine, select **Remove** on its row. When Solus started the server
there, you can also stop that service.

### Password or key passphrase

Type the password in the **Add host** dialog. If the machine refuses the SSH keys,
the dialog asks for it.

The host that runs the SSH command keeps the password in its memory until that host
restarts. A forward that stops opens again with no new prompt. Solus does not write
the password to a file or a log, and does not put it in command arguments. `ssh` reads
it from an environment variable through an askpass helper. That variable stays in the
`ssh` process while the forward is open, so another program that runs as the same user
on that host can read it. The same user can also read that host's SSH keys.

After the host restarts, or when the machine refuses the password, the forward stops
and shows **Password needed**. Solus does not try again, because repeated refusals
can lock the account on the machine. Enter the password on the row of the machine, on
the **Access** tab of the host that holds the forward. On mobile, use the settings of
that host. The desktop app also shows a notice that opens this tab. A machine that is
offline at the restart shows **Reconnecting** until it answers. A key that works
needs no password.

While a forward waits for its password, **Link to my account** is not available, because
the link also signs in over SSH. Removing the machine with **Also stop Solus there**
uses the password that the host holds. If it holds none, the service stays there.

A one-time code or a second factor is not supported: Solus can answer only one prompt.

## How a device trusts a host

Each host has its own identity key. A device learns it from the pairing, from the SSH
connection that added the host, or from the first connection through the host's
tunnel. Before a device sends a credential on a plain `http:` address, the host must
sign a new random value with that key. A device at an old address that now belongs
to another machine never gets the credential.

This check does not encrypt the connection. Traffic on a plain `http:` address can
still be read on that network. An SSH forward, a tailnet, and the tunnel are encrypted.

For this reason, a client does not send a password on a plain `http:` address on a
local network. Connect to the host through your account or a tailnet, or enter the
password on that computer. The desktop app's connection to its own host stays on the
computer, so it can always send one.

## Known limits

- The latest release must have the Windows installer before Solus can install itself
  on a Windows machine. Until then, install Solus there by hand and add the machine
  again.
- A link code goes to the installer as a command argument, as in the onboarding
  command. Other users on that machine can see the arguments of running programs for
  a short time.
