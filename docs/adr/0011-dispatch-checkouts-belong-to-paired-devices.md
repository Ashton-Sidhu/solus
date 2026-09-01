# Dispatch checkouts belong to paired devices

Status: accepted

A checkout prepared for a dispatched session is identified by the paired device
and normalized repository key. It lives at:

```text
<projectsRoot>/solus-remote/<deviceId>/<host>/<owner>/<repo>
```

Credential identity is not checkout identity. A GitHub login can change, and a
dispatch can fall back to credentials already present on the execution host.
Neither event should select a different working tree. The paired device ID is
already the authorization key for delegated credentials, so it is also the
smallest stable isolation boundary for unattended checkout state.

The server owns this path convention. Clients send repository keys through a
bounded, authenticated history-root RPC. The server derives exact paths only
inside the calling device's namespace and verifies each checkout's origin. It
does not enumerate other device namespaces or expose dispatch checkouts through
the general project manifest.

## Consequences

- Two paired devices dispatching the same repository to one host use separate
  working trees and cannot see one another's uncommitted changes or sessions.
- GitHub login and credential changes do not move a checkout.
- Repository host is part of the path, so equal owner/repository names on two
  Git hosts do not collide.
- Dispatch checkouts remain absent from project recents and project pickers.
- A pending dispatch can reuse only an isolated worktree under the calling
  device's dispatch checkout. The picker can also list origin branches from the
  source repository. Selecting one records a base for a new isolated worktree
  on the target host; it never switches the source checkout.
- The session picker merges verified dispatch roots with normal remote project
  identities, while keeping local rows available during remote discovery.
- Revoking a device removes its authorization and delegated credential. It does
  not delete its checkout because that directory can contain uncommitted work.
- Pairing again creates a new device namespace. This decision provides no legacy
  path discovery or migration.
