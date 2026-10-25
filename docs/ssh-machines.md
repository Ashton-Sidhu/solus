# Machines added over SSH

You can add any machine that you reach with `ssh user@host` as a Solus host. You do
not need to install Solus there first, and you do not need to open a port.

## Add a machine

1. Open **Settings → Hosts** and select **Add machine over SSH**. You can also use the
   command palette, the **Run on** picker, or **Add machine over SSH** on a host's
   **Access** tab. On mobile, use the add-host sheet or a host's settings.
2. Type the SSH target: an alias from `~/.ssh/config` or `user@host`.
3. Choose whether to link the machine to your Solus account.

The host that runs the SSH command does these steps, and shows each step:

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
- The forward needs an SSH key. A password cannot keep a forward open.
- When the forward stops (sleep, a network change, a restart), Solus opens it again.
  After a minute of failures, the host shows **Failed** and keeps trying once a
  minute.
- When the machine is also linked, the forward stays as its fastest route. If the
  forward fails while the tunnel works, the host shows **SSH route paused** and no
  error.

To remove the machine, select **Remove** on its row. When Solus started the server
there, you can also stop that service.

## How a device trusts a host

Each host has its own identity key. A device learns it from the pairing, from the SSH
connection that added the host, or from the first connection through the host's
tunnel. Before a device sends a credential on a plain `http:` address, the host must
sign a new random value with that key. A device at an old address that now belongs
to another machine never gets the credential.

This check does not encrypt the connection. Traffic on a plain `http:` address can
still be read on that network. An SSH forward and the tunnel are encrypted.

## Known limits

- The latest release must have the Windows installer before Solus can install itself
  on a Windows machine. Until then, install Solus there by hand and add the machine
  again.
- A link code goes to the installer as a command argument, as in the onboarding
  command. Other users on that machine can see the arguments of running programs for
  a short time.
