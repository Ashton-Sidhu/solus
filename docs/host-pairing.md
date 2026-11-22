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
`pair_host`. `list_hosts` lists the same machines a client of this host lists: the
account's hosts and every host on the person's host list. Each one says how this host
reaches it: the account, a pairing, an introduction, or an SSH forward. A host on the
list that this host holds no credential for is `listed`, with the status
`not-paired`, and `start_sessions` there answers with the way in: `pair_host`. The
other statuses are `online`, `unreachable`, `auth-required`, and `not-ready`, with the
host's managed state when applicable. While the person is signed in, their list is an
account document that only a client reads with its own sign-in, so this host lists
the hosts it keeps in its own `host_list` and the account's hosts. A host with no current route stays visible as unreachable.
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

The server saves the host record before it emits `host.listChanged`. Connected
clients read the change into the host catalog, the one owner of this device's
credentials. Desktop and web follow that catalog through the Svelte host store;
native mobile follows it through its host registry. A connection does not keep a
copy of its token: each dial reads the token from the catalog, and a token
refresh saves into the catalog only if no new pairing replaced the old token
meanwhile. So a token that arrives after the host listing reaches the existing
connection, and a host that refused this device dials again once the device holds
a token the host has not refused. No reload is needed.

A host has one id on every client: its installation id. A listing with any other
id is refused.

A client pairs a host that its owner host paired in two cases only:

- It holds no token for the host.
- The host refuses its token, and the owner paired the host again after that
  token came. Each listing in `hostsListPaired` carries the owner's `pairedAt`, and
  the client saves the `pairedAt` it followed with its token.

So a client pairs at most once for each owner pairing, and a refusal cannot start
a loop. A token that works stays, even when the owner pairs the host again. A
refused host otherwise shows **Pair again**. On desktop and web that action asks a
connected owner host for a new code first, and opens the pairing dialog only when
no owner host has a pairing for that machine. The native mobile app follows the
same pairing rules; its current interface has no Pair again action yet. Each new pairing sends the token it
replaces, and the remote host revokes it, so one device keeps one live device
row. The owner host does the same with its own token when it pairs a host again.

An old entry that cannot be removed does not block a new pairing. Failed reads,
removals, and client pairings report diagnostics; a failed list write keeps the
client pairing and retries the list write on the next read.

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
