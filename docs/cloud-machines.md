# Cloud machines

A cloud machine is a Solus server that works for one organization. Members of
the organization run their agents on it. Nobody owns it as a person owns their
own computer. In the apps it shows as a **Cloud host**.

There are two ways to get one:

- **Solus makes it.** A member creates it in the console. The control plane
  starts, stops, and updates it through its compute provider.
- **You run it.** An operator starts a Solus server in the organization's own
  environment and joins it with a link code. This page is about that case.

The design and its rules are in `plans/034-one-cloud-machine-kind.md`.

## Before you start

- Use a machine with new data. A Solus server that is registered already, or
  that holds sessions, cannot become a cloud machine. Use a new data directory
  (`--data-dir`) and a user account with no agent history.
- Give the machine an HTTPS address, for example
  `https://machine.example.com`. A cloud machine has no tunnel.
- Run the HTTPS front on the machine itself (a reverse proxy such as Caddy or
  nginx). It must forward each request, WebSocket upgrades included, to the
  Solus server's proxied listener at `127.0.0.1:34118`. Set `SOLUS_TUNNEL_PORT`
  to change the port.
- The organization's host rules must allow cloud hosts.

## Join the machine

1. In the console, open **Organization settings → Add your own machine**, and
   copy the command. The code in it works once and lasts ten minutes.
2. Run the command on the machine, with its address:

   ```sh
   curl -fsSL <install script> | sh -s -- --link CODE --address https://machine.example.com
   ```

   With Solus installed already:

   ```sh
   solus setup --link CODE --address https://machine.example.com
   ```

3. The command prints that the server is now a cloud host of the organization.

Without a code, `solus connect --address URL` signs you in with a device code
and lets you choose the organization.

## What changes on the machine

- It has no pairing code. `solus pair` says so.
- It trusts no connection by network position, the loopback connection
  included. Members reach it through Solus with their account.
- Each session on it is the organization's work, and its records are saved in
  the organization's Solus API.
- It keeps this kind until an organization owner removes it.

## Status, updates, and removal

- `solus connect status` prints the organization, the control plane, the Solus
  API, and the address from the records in the data directory. Live status is
  in the Solus apps and the console.
- `solus update`, `solus policy show`, and `solus host` do not work on a
  running cloud machine, because they use the loopback connection. An
  organization owner updates the machine from Solus.
- To remove the machine, an organization owner selects **Remove this machine**
  on its page in Solus or in the console. The Solus server keeps running until
  you stop it. To use the computer again, start with a new data directory.

## If the command fails

| Message | Cause |
| --- | --- |
| An organization code needs the HTTPS address of this machine | The code is an organization code and `--address` is missing, or the code is a personal code and `--address` is present. |
| This server is registered already | Use a new data directory. |
| This server holds sessions already | Use a new data directory and a user account with no agent history. |
| That organization does not allow cloud machines | An organization owner must allow cloud hosts in the organization's host rules. |
| The account that made the code is no longer a member | Get a new code from a member. |
