# Cloud machines

A cloud machine is a Solus server that works for one organization. Members of
the organization run their agents on it. Nobody owns it as a person owns their
own computer. In the apps it shows as a **Cloud host**.

There are two ways to get one:

- **Solus makes it.** A member creates it in the console. The control plane
  starts, stops, and updates it through its compute provider.
- **You run it.** An operator starts a Solus server in the organization's own
  environment and joins it with a link code. This page is about that case.

Both join in the same way: the server enrolls with a link code. The code
decides what the machine is. An organization code makes a cloud machine. A
personal code makes a personal host.

The design and its rules are in `plans/034-one-cloud-machine-kind.md`.

## Before you start

- Use a machine with new data. A Solus server that is registered already, or
  that holds sessions, cannot become a cloud machine. Use a new data directory
  (`--data-dir`) and a user account with no agent history.
- The organization's host rules must allow cloud hosts.
- Decide how members reach the machine (see the next section).

## The address of the machine

`--address URL` is optional. It says how the internet reaches the machine.

- **With an address**, members reach the machine at that HTTPS address, for
  example `https://machine.example.com`. The machine has no tunnel and does
  not need `cloudflared`. Run the HTTPS front on the machine itself (a reverse
  proxy such as Caddy or nginx). It must forward each request, WebSocket
  upgrades included, to the Solus server's proxied listener at
  `127.0.0.1:34118`. Set `SOLUS_TUNNEL_PORT` to change the port.
- **Without an address**, the machine gets a Cloudflare tunnel, as a personal
  host does. Setup installs `cloudflared`. The machine needs no open port.

The address is necessary when your Solus Cloud has no tunnels. This is the
usual case when your organization hosts its own Solus Cloud with no Cloudflare
account. The command then stops with "This Solus cloud has no tunnels", and the
code is not used.

The address is an `https://` origin with no path, no query, and no user name
or password.

## Join the machine

1. In the console, open **Organization settings → Add your own machine**, and
   copy the command. The code in it works once and lasts ten minutes.
2. Run the command on the machine. Add `--address` when the machine has its
   own HTTPS address:

   ```sh
   curl -fsSL <install script> | sh -s -- --link CODE [--address https://machine.example.com]
   ```

   With Solus installed already:

   ```sh
   solus setup --link CODE [--address https://machine.example.com]
   ```

3. The command prints that the server is now a cloud host of the organization,
   and its address or the host name of its tunnel.

Without a code, `solus connect` signs you in with a device code and lets you
choose the organization. `--address` works there too.

### A machine that a script starts

A machine with no person at it can join at boot. Put the link code in the
environment of the Solus server:

- `SOLUS_LINK_CODE`: the link code, with the Solus Cloud that issued it
  (`<ticket>@<host>`).
- `SOLUS_MACHINE_ADDRESS`: the HTTPS address of the machine. Omit it for a
  tunnel.

The server enrolls before it accepts a connection, and removes both variables
from its environment. While Solus Cloud does not answer, the server waits and
tries again. A code that Solus Cloud refuses ends the start. A machine that is
registered already ignores the code.

## What changes on the machine

- It has no pairing code. `solus pair` says so.
- It trusts no connection by network position, the loopback connection
  included. Members reach it through Solus with their account.
- Each session on it is the organization's work, and its records are saved in
  the organization's Solus API.
- It keeps this kind always. After an organization owner removes it, its data
  directory is still a cloud machine's: it takes no personal code and no code
  of another organization.
- You cannot change its address from the command line. To change the address,
  remove the machine and join it again with a new data directory.

## Status, updates, and removal

- `solus connect status` prints the organization, the control plane, the Solus
  API, and the address or the tunnel host name from the records in the data
  directory. Live status is in the Solus apps and the console.
- `solus update`, `solus policy show`, and `solus host` do not work on a
  running cloud machine, because they use the loopback connection. An
  organization owner updates the machine from Solus.
- To remove the machine, an organization owner selects **Remove this machine**
  on its page in Solus or in the console. The Solus server keeps running until
  you stop it. To use the computer again, start with a new data directory.

## Agents can manage your hosts

An agent can do these tasks for you in a conversation
(`plans/035-cloud-machine-tools.md`, `plans/036-host-tools.md`). Each tool
applies only where its action is real. `list_hosts` shows, for each host, the
actions that apply to it.

| Tool | Applies to |
| --- | --- |
| `list_hosts` | Every host: your computers and the cloud machines of your organizations |
| `add_host` | Pair a computer. With `organization`, join a machine that you run as a cloud machine of that organization |
| `create_host` | A new cloud machine that Solus makes |
| `start_host`, `stop_host`, `restart_host` | A cloud machine that Solus makes |
| `update_host` | `release`: install the newest Solus release, on every host. `packages` and `setup_script`: only a cloud machine that Solus makes |
| `check_host` | Every host: its self test, and its CPU and memory |
| `share_host`, `unshare_host` | Your personal host, with one of your organizations |
| `remove_host` | Forget a host here. The machine and its sessions stay |
| `delete_host` | A cloud machine. Solus destroys a machine that it makes, with its disk |

The organization tools read the people and teams of an organization, and read
or change its name and host rules (`list_organization_members`,
`read_organization_policy`, `update_organization_policy`).

The join (`add_host` with `organization`): only the owner of the host, at that
host, can do this, because the host connects with its own SSH keys. The host
makes a link code and runs `solus setup --address URL` on the machine over SSH.
The code goes on the standard input of the command, so it is not in the
conversation, in a log, or in the command line of either machine. The
conditions of [Before you start](#before-you-start) apply, and the address must
be `https://`.

The rules:

- **Signed in for Solus Cloud.** The host sends each request to Solus Cloud as
  you, with the token it holds for you. A conversation of a person who is not
  signed in to Solus on that host does not get the tools that need it
  (`create_host`, `start_host`, `stop_host`, `restart_host`, `delete_host`,
  `share_host`, `unshare_host`, and the organization tools). `list_hosts`,
  `add_host`, `update_host` with `release`, `check_host`, and `remove_host`
  work signed out too.
- **Not this host.** An agent never stops, restarts, updates, or deletes the
  host that runs its conversation, because that ends the conversation. Do that
  from another host, or in **Settings → Machines**. It can check and share this
  host.
- **Only a machine that Solus makes has a stored setup.** On any other host,
  `update_host` refuses `packages` and `setup_script`: install packages there
  yourself, or start a session there.
- **Approval.** `delete_host`, `remove_host`, `share_host`, and a change of the
  host rules ask for your approval first.
- **The machine card.** When you did not say a choice, the agent shows a card
  in the conversation: the organization of a new machine or of a join, when
  you are in more than one, or the packages and setup script of a machine to
  change. The card only collects your choice. Decline closes it, and nothing
  changes.
- Your role still applies: a member creates a machine, and an organization
  owner changes, deletes, and sets the host rules. Only the owner of a personal
  host shares it.

## If the command fails

| Message | Cause |
| --- | --- |
| This Solus cloud has no tunnels | Give the HTTPS address of the machine with `--address`. The code is still good. |
| The address of this machine is not valid | Give an `https://` address with no path, for example `https://machine.example.com`. |
| This server is registered already | Use a new data directory. |
| This data directory belongs to a cloud machine | A personal code needs a new data directory. |
| This server holds sessions already | Use a new data directory and a user account with no agent history. |
| That organization does not allow cloud machines | An organization owner must allow cloud hosts in the organization's host rules. |
| The account that made the code is no longer a member | Get a new code from a member. |
