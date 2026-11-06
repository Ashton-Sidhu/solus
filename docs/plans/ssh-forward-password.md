# SSH forward with a password

Status: implemented. Extends `docs/plans/host-routes.md` D6 and D7. Where that plan
says a forward needs a key, this plan wins.

## Why

A machine added without an account is reached through an `ssh -L` forward that the
host holds. Today the forward needs an SSH key, so a machine that takes only a
password can be added only with a link to an account. The account-linked add already
accepts a password or key passphrase, and uses it once through askpass. A forward
must sign in again each time it opens, so "used once" is not sufficient.

## Vocabulary

- **auth secret** (`authSecret`): a password or key passphrase, as in the existing
  contract.
- **`needs-auth`**: a new `ForwardedHostState`. SSH refused this host's keys or the
  secret it held. The forward waits for the person and does not retry.
- **unlock** (`hostsUnlockForwarded`): the person gives the secret for a forward in
  `needs-auth`.

## Assumptions

1. The host that runs `ssh` keeps the secret. A client never keeps it after it sends it.
2. A JS string cannot be cleared from memory. "In memory only" means that no file, log,
   record, or process argument holds it, and that the process's end removes it.
3. `ssh` reads the secret from `SOLUS_SSH_AUTH_SECRET` through the existing askpass
   helper. The variable stays in the environment of the `ssh` process for the life of
   the forward. Only the same OS user (and root) can read it. The same user can
   already read that user's SSH keys and the Solus data folder. We accept this.
   OpenSSH closes inherited descriptors, so a pipe to askpass needs a named pipe and
   has no Windows form. That is more machinery than the risk earns.
4. One prompt for one secret. A second factor (a one-time code) cannot be answered.

## Decisions

### D1. Nothing durable says that a secret exists

`forwarded-hosts.bin` does not change. At boot, a forward opens as it does today, with
keys only. The check that reads the remote port runs first and reports an SSH refusal.
`AuthNeeded` from that check moves the forward to `needs-auth`.

- A machine that is offline at boot stays `reconnecting` or `failed`, which is true. It
  moves to `needs-auth` when it answers.
- A machine that later gets a key opens with no prompt.
- A key that stops working, or a locked agent, gets the same prompt.

A durable "uses a password" flag gives a prompt while the machine is offline, but it
adds a field that goes stale. We do not add it.

### D2. A refusal stops the retries

A refused password counts against the account on the machine, and retries can lock
the account. `needs-auth` sets no timer. A refused secret leaves memory at once, and
`error` says that it was refused. The first ask after a boot has no `error`.

### D3. The secret reaches every path that uses SSH for the machine

The reopen after a drop, the remote port check, `hostsLinkForwarded`, and
`hostsRemoveForwarded` with `stopRemote`. `ForwardedHosts.record()` gives the secret to
the handlers in process. `ForwardedHost` on the wire never holds it.

### D4. Askpass answers only secret prompts

A forward with a secret sets `BatchMode=no`, `NumberOfPasswordPrompts=1`, and
`StrictHostKeyChecking=accept-new`, as `SshClient.run` does. With `accept-new`, ssh never
asks a yes/no host key question that askpass would answer. A changed key still fails.
The helper file holds no secret. It goes when `ssh` ends.

### D5. Transit

| Connection to the host that runs SSH | Protection |
| --- | --- |
| Desktop to its own host | Loopback. It does not leave the computer. |
| `https:` tunnel | TLS. The tunnel provider terminates TLS. |
| `forwarded` route | Loopback, then SSH. |
| `tailnet` route | Encrypted by WireGuard. |
| Plain `http:` on a LAN | **None.** Anyone on that network can read it. |

The host proof (host-routes D3) stops a credential going to the wrong machine. It does
not encrypt. A client does not send a secret on the last row. `isEncryptedRouteUrl` in
`contracts/host-routes.ts` is the one rule, and `unencryptedPasswordMessage` in
`client-core/ssh-password.ts` is the one message. The rule is in the client,
because a refusal from the server comes after the secret has crossed the network.

This also closes the linked add on plain `http:`, which sent the secret in the clear.
The developer can loosen this rule. See "Open decision".

### D6. Logs

`SolusServer.handle` logs the arguments of most methods in dev builds, and
`hostsAddOverSsh` was one of them, so `dev.log` got the secret. `hostsAddOverSsh` and
`hostsUnlockForwarded` join the list of methods whose arguments are not logged.

### D7. The prompt is on the holder's page

The row of the forward on the host's **Access** tab (desktop and web) and on the host's
settings (mobile) shows the state and a password field. On desktop, the first move to
`needs-auth` of an unlinked forward on this computer shows a toast that opens that page.

A linked host in `needs-auth` still has its tunnel, so it shows the paused line with the
field, and no toast.

## Surfaces

- **Entry points.** Add over SSH, the Access tab row, Link, Remove with stop.
- **Clients.** Desktop and web share the Svelte surfaces. Mobile has its own.
- **Providers.** Not applicable.
- **Contracts.** `ForwardedHostState`, `hostsUnlockForwarded`, permissions, planes.
- **Reverse states.** `needs-auth` leaves by unlock, by a new key at the next open, or by
  Remove.
- **Connection modes.** D5.
- **Persistence.** None for the secret. `host.forwardedHostsChanged` carries the state
  to every client. A second client's unlock is a no-op when the forward no longer
  waits.
- **WSL.** A distro has no SSH sign-in, so it never reaches `needs-auth`.

## Open decision

Plain `http:` on a LAN refuses a secret (D5). A person with no account and no tailnet
can then give the password only from the computer that holds the forward. The other
choices are a "send anyway" confirmation, or a seal to a host key. A seal needs a new
key and a crypto library, because `crypto.subtle` is not available on a plain `http:`
page, and a page served over plain `http:` can be changed in transit anyway.
