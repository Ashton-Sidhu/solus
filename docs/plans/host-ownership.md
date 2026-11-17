# Host record ownership

Status: implemented, 2026-11-17.

This decision replaces the separate persistence of forwarded and introduced hosts
in `host-routes.md` D7 and `host-reach.md` §4. The account directory still owns
account machine registration. Each client still owns its own pairing credential.

## One record on each host

`server/host/host-list.ts` owns the local database record for a remote host. The
`host_list` table has one row per installation id. The row's JSON contains:

- `listing`: identity, label, routes, operating system, and connection time;
- `forward`, when this host holds an SSH or WSL forward;
- `introduction`, when this host has introduced access to the remote host;
- `forgotten`: a refusal that prevents an old introduction from restoring access.

The listing id can be an account id. The database row key is always the
installation id, so these two names cannot create two records for one machine.
A listing update keeps the connection settings on the existing record.
`hostListRead` returns only active listings. It exposes no connection settings or
tokens. The signed-in account document is the person's shared list of metadata;
it does not own processes on another host.

Tokens are in the platform secret store under one `host-connection-<hash>` key
per installation. Forward and introduction tokens have separate fields because
they can be issued to different devices and expire at different times. A token
cannot be read for use without an active database record and its connection
settings. SSH passwords stay in process memory only.

`ForwardedHosts` owns captured process handles, retry timers, and SSH passwords.
`IntroducedHosts` owns introduction checks, token refresh, and device revocation.
Both read their settings from the host record. Neither maintains a host catalog
in its own secret file.

## Forget

`hostListRemove`, `hostsRemoveForwarded`, and `hostIntroductionForget` all forget
the same local record. Forget clears its credentials and connection settings and
keeps only a refusal and its listing. Removal listeners close its forward,
cancel retries, revoke its introduced device, and close cached host-to-host
connections. An opening forward that finishes late is closed. A token refresh
that finishes after removal cannot restore access.

Desktop, web, and mobile ask connected owner hosts to forget the target before
they drop their own pairing. When a saved route names an SSH holder, that holder
must answer. A failure leaves the client's pairing available for a retry.
Unconnected hosts are separate authorities; this operation does not promise to
revoke records on hosts that cannot be reached. The target's sessions and
installation stay in place. Removing the remote service remains the explicit
`stopRemote` choice in the SSH setup flow.

An explicit pairing or SSH add can restore a forgotten host. Allowing an
introduction removes the refusal but restores no credential or process.

## Old development data

There is no conversion of the old `forwarded-hosts` and `introduced-hosts` secret
lists, or the old bare listing rows. They are not connection authorities and are
not read. Add the required hosts again. This change does not delete those files
or modify a running application's data during development.

## Verification

Focused tests cover one row with both connection types, listing updates,
credential isolation, forget and restart, late SSH completion, obsolete secret
lists, SSH password handling, introduction refusal and refresh, and client
removal errors. The behavior is shared by Claude and Codex. It does not depend
on Electron and uses the same RPC methods over IPC and WebSockets.
