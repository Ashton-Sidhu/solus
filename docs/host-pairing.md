# Pair hosts from a chat session or terminal

An owner can add a remote Solus server without computer control. Start Solus on
that machine and make its address reachable first. Pairing does not install a
server, configure its firewall, or register it with Solus Cloud.

In a chat session, ask the agent to pair the server at its HTTP or HTTPS address.
The agent uses `request_secret` to ask for a fresh pairing code or link in a
private card, then calls `pair_host` with the address and the returned
`secretRef`. Run `solus pair` on the remote machine to get the code. The ref is
one-use and belongs to that session. Codes and persistent tokens are not tool
results. `remove_host` forgets a pairing by the installation id returned by
`pair_host`. `list_hosts` lists the machines this session may reach, including
account hosts, explicit pairings, introductions, and SSH forwards. It reports
`online`, `unreachable`, `auth-required`, or `not-ready`, with the host's managed
state when applicable. A host with no current route stays visible as unreachable.
The status check verifies the machine and signs in without loading its model catalog.

Use `list_agent_targets` for providers, models, runtime availability, and reasoning
levels on one machine. Omit `host` for the current host; pass an id or name from
`list_hosts` for another. Its response does not include a machine list. An expired
pairing stays in `list_hosts` for repair, but its refused credential is deleted.

The terminal uses the same running server and its RPC contract:

```sh
solus host pair http://10.10.1.10:3000 --code 123456 --label Windows
solus host list --json
solus host remove <installation-id>
```

For agent commands, use `--code-file PATH` instead of `--code`, so the code does
not enter command arguments. The file can contain a code or a full pairing link;
a link must name the same server as the address. These commands accept
`--data-dir PATH` to select a running server. They work with a desktop server
or a standalone server. They never open the server's database themselves.

The host saves its own connection credential in the platform secret store.
Agents on this host can then use `start_sessions` with the paired host's name or
installation id. Only locally authorized owner sessions can create, read, or
remove these pairings. Account grants, members, guests, system turns, and managed
hosts cannot create this local reach.

Desktop, web, and native mobile clients connected as the local owner read changes
and obtain their own fresh, one-use pairing codes. Each client exchanges its code
and saves its own token through its existing host catalog. The persistent host
credential never goes to a client. A client must be able to reach the remote
address. An HTTPS web page cannot connect to a plain HTTP remote server. Use the
desktop or native mobile client for a plain HTTP LAN host.

A forgotten host loses all connection credentials on this host. Its forwards
and cached remote connections close through the existing host-record removal
listeners. Connected owner clients drop their own saved pairing. This does not
stop the remote server, remove its files, or revoke independent credentials on
other devices. Explicit pairing can restore access. Late pairing and refresh
replies cannot restore a forgotten connection.

Public addresses require HTTPS. HTTP on a local network remains supported. The
remote host must provide its identity key when paired over HTTP; update an older
server or use HTTPS. Later dials verify the saved identity before sending the
persistent token. Pairing requests have a time limit and do not follow redirects.
