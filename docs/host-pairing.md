# Add hosts from a chat session or terminal

An owner can add a remote Solus server without computer control. Start Solus on
that machine and make its address reachable first, or add it over SSH: then
Solus installs and starts the server there. Pairing with a code does not install a
server, configure its firewall, or register it with Solus Cloud.

In a chat session, ask the agent to add the machine. The agent calls `add_host`
with the person's words for it (`hint`) and its address (`url`) when it knows
them (docs/plans/add-machine-card.md). If this host already reaches an online host
that the address or the exact name matches, `add_host` returns it and shows no
card. Otherwise it shows the **Add a machine** card (question kind `host-link`).
The card offers each way to add the machine, the way that needs no typing first:

- **From this device**: the client makes a code on a host it already reaches as
  owner.
- **Over SSH**: the session host adds the machine with `hostsAddOverSsh`, with its
  own SSH config and keys. An address such as `10.10.1.10` matches the
  `~/.ssh/config` alias whose `HostName` it is.
- **Ask it to approve**: an approval request (see "Approval requests" below).
- **Needs a code**: the person types the 6-digit code or pastes the pair link
  from `solus pair` on that machine.

The client does the add with the session host's own RPCs (`hostsAddOverSsh`,
`hostsPair`), then answers the card with the installation id only. A code or an
SSH password goes only in those calls. It is never in the transcript, the tool
input, or the tool output. `add_host` returns the machine only when this host now
holds a credential for it. A failure shows on the card, and the card stays open.
**Decline** closes it and tells the agent; a stopped run closes it too. The card
asks for no name: the host keeps the name it reports, and the person can change it.

`hostsPair`, and so the CLI, checks the shape of a code before it sends anything.
A code is 6 digits (spaces or a dash between them are allowed) or a pair link
that names the same address. Any other value, such as a password, is refused,
and no request goes to the host.

`remove_host` forgets a machine by the installation id returned by `add_host` or
`list_hosts`. `list_hosts` lists the same machines a client of this host lists: the
account's hosts and every host on the person's host list. Each one says how this host
reaches it: the account, a pairing, an introduction, or an SSH forward. A host on the
list that this host holds no credential for is `listed`, with the status
`not-paired`, and `start_sessions` there answers with the way in: `add_host`. The
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

## Approval requests

A machine can ask a host to pair it without a code. The host's owner approves
or denies the request with one click (desktop, web, mobile) or with the CLI
(docs/plans/add-machine-card.md, "The approval request").

1. The requester makes a check code, such as `K7QX-M2PA`, and shows it. The
   alphabet has no `0`, `O`, `1`, or `I`.
2. The requester sends `POST /pair/request` with its device label and the check
   code. The host keeps the request in memory for 5 minutes and replies with a
   request id and a `waitToken`. Only the requester knows the `waitToken`.
3. The requester calls `POST /pair/request/wait` with the request id and the
   `waitToken`. Each call waits at most 25 seconds and replies `pending`,
   `denied`, `expired`, or `approved`.
4. Connections that hold `host.local.reach` get `host.pairApprovalsChanged`
   with the open requests. Each request shows the check code, the device label,
   and the address it came from. Compare the check code with the code on the
   requester's screen before you approve.
5. Approval issues a session token exactly as `POST /pair` does. The device is
   listed and revocable with the other paired devices. If the request names a
   token to replace, that token is revoked. If the requester does not collect
   the token within 50 seconds, the host revokes it.

Rules:

- The routes have the same exposure as `/pair`. They do not exist on a managed
  host or over the tunnel, and they are rate limited per address.
- A host holds at most 5 open requests. A sixth request gets 429.
- A wait with a wrong `waitToken` or an unknown request id gets `expired` at
  once and changes nothing.
- A restart forgets the open requests. The requester then gets `expired`.
- A host that does not have the routes answers 404. The requester reads that as
  "this host does not take approval requests" and uses a pairing code.
- Behind Tailscale Serve, the address shows the forwarded address with
  "(Tailscale Serve)".

From a terminal on the host:

```bash
solus host approvals [--json]
solus host approve K7QX-M2PA
solus host deny k7qxm2pa
```

A check code is accepted in any case, with or without the dash.

To ask another host from this host, give no code:

```bash
solus host pair http://10.10.1.10:3000 --label Windows
```

The command prints the check code and waits until the owner of that host
approves or denies the request, or until it expires.
