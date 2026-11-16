# Tailscale editor links

Status: Phase 3 design, 2026-11-16.

## 1. Terms and decision

An **SSH target** is the host's MagicDNS name and operating-system user name. The
host advertises it only when SSH can accept a connection at its tailnet address.
The client uses it to ask a local editor to open a path on that host. This does
not grant SSH access: the person's SSH keys and Tailscale policy still apply.

The host reads `Self.DNSName` from `tailscale status --json` and removes its final
dot. It checks port 22 on each `Self.TailscaleIPs` address. This covers `sshd`
bound to all interfaces or to a tailnet address. It also accepts Tailscale SSH
when `tailscale debug prefs` says `RunSSH && WantRunning`. The check has a short
network timeout. A 60-second cache gives a stale answer while one background
refresh runs. The first read runs the status and prefs commands in parallel and
must take no longer than the existing status read timeout plus the port probe.

## 2. Contract and clients

`ConnectionsServerInfo.sshTarget?: { host: string; user: string }` is the only
contract change. No RPC or persistent record is added. The host facts store owns
the client copy of server info. A new connection gets a new copy.

For a remote host, the project panel offers VS Code, Cursor, and Zed only when
the SSH target exists. The diff's configured editor action uses the same link.
The link builder accepts an absolute path and returns a URL. The local-machine
`openInEditor` RPC and installed-editor list stay as they are. Desktop opens
the URL through `localApi.openExternal`; web uses the browser's link behavior.
Zed documents its link form at https://zed.dev/docs/remote-development.
The action does not appear in the native mobile client: it has no local desktop
editor. This is the Phase 3 platform exception.

## 3. Proof

Unit tests cover MagicDNS normalization, SSH listening and prefs decisions,
URL encoding for each editor, and unsupported editors.
Run the nearby editor and server-info tests, the three package checks,
`lint:types`, and `lint:hosts`. Do not start a server or editor.
