# Member isolation — one Linux user per member on a shared host

Status: decided 2026-10-14 (maintainers: §2 decisions 1–3, §9); member users
changed 2026-10-15 (§2 decisions 2 and 4, §4, §7, §8: one reconcile in the host
worker, usernames from the member's name, managed hosts only). Browser
profiles per person (§6) are built first, on every host.
Extends `docs/plans/access-model.md` (who a person is, the vault) and
`plans/019-acting-identity.md` (seats and acting identities). No migration:
existing hosts are not changed in place; a host gets isolation when it is
created or set up again.

## 0. Why

On a shared host every member's processes run as one operating-system user
(`solus`). Separation is only the environment: `HOME`, `CLAUDE_CONFIG_DIR`, and
`CODEX_HOME` point at the member's folders under the seats root. An agent runs
shell commands, often with `bypassPermissions`, so bob's agent can read
`/run/solus-seats/claude/<alice>/.credentials.json`, alice's
`home/<alice>/.config/solus/github.json`, or her browser cookies. plans/019 says
the model "prevents mistakes, not attacks". A prompt injection that reaches a
shell is an attack.

With one Linux user per member, the kernel enforces the boundary: a member's
folders are theirs, and other members cannot read them.

## 1. Vocabulary

- **shared host** — a Linux host that more than one person uses: a managed host
  (`hostCategory() === 'managed'`), or a self-hosted host attached to an
  organization (`isOrganizationAttached()`). Isolation is on for a managed
  host (decision 2) and off for a personal machine.
- **member user** — the Linux user that runs one member's processes on one
  host. Its username is the member's folder name (`ada-lovelace`), and its uid
  is fixed from the member range.
- **server user** — `solus`: the Solus server and the host's own work (no person).
- **launch point** — the one function that starts a process for a person. It
  gives the environment, the uid, and the gid.
- **user reconcile** — the step in the solus-cloud host worker (root, beside
  seat sync) that makes the host's member users match the people who may use
  the host. It is the only root code that this plan adds.
- **project group** — `solus-proj`: the group that owns shared project folders.

## 2. Decisions

1. **The server switches users with two Linux capabilities** (maintainers,
   2026-10-14). The server runs as `solus` with `CAP_SETUID` and `CAP_SETGID` as
   ambient capabilities, and nothing else. Node starts a member process with
   `spawn(cmd, { uid, gid })`, and the terminal with `node-pty`'s `uid`/`gid`.
   There is no `sudo` and no setuid binary.
2. **Managed hosts first** (maintainers, 2026-10-15; replaces "self-hosted
   shared hosts are isolated too"). A self-hosted host attached to an
   organization keeps today's separation by environment until a later plan:
   it has no host worker to run the user reconcile as root.
3. **A person's browser profiles are theirs.** Today a profile is keyed by the
   project and a profile id (`browserProfilePartition`), so alice's imported
   cookies sign bob's agent in as alice. A profile becomes a personal resource
   (access-model.md §2.3: only its owner reaches it), its partition includes the
   person key, and on a shared host its browser process runs as the member user.
4. **The server never creates users; one reconcile does** (maintainers,
   2026-10-15; replaces the `solus-userd` helper). Two capabilities let the
   server switch to a user; writing `/etc/passwd` needs root. The host worker
   already runs as root on a managed host and already reads every member for
   seat sync, so the user reconcile runs there. There is no extra daemon and no
   request protocol. The server names the user (username and uid) and is told
   when it is ready; it runs no root command.

## 3. The launch point

Every process that runs for a person starts in one place:
`ActingIdentity.launch(cmd, args, options)`. It gives `{ env, uid, gid, cwd }`.
These callers move to it:

- the Claude agent (`execution/agents/claude/claude-agent.ts`): the Agent SDK's
  `spawnClaudeCodeProcess` option lets the launch point start the CLI itself,
  with the member's uid and gid. No wrapper is needed. `HOME` and
  `CLAUDE_CONFIG_DIR` only tell the CLI where its files are; the uid is what
  stops it from reading another member's files;
- the Codex app server (`execution/agents/codex/codex-agent.ts`): one process
  per member already;
- the terminal pty;
- git and `gh` commands (`cli-env.ts`, `git/git-auth-env.ts`);
- seat sign-in relays (`execution/seats/seat-connect.ts`, `agent-auth.ts`);
- the member's browser process (§6).

On a personal machine `launch` gives the same answer as today and no uid. A lint
rule rejects `child_process.spawn` and `node-pty` outside the launch point in
`packages/server/src/execution/` and `git/`.

## 4. Member users

- **Username:** the member's folder name (`host/member-folders.ts`), so one
  name is used for the user, `HOME`, and the seat folders. On a shared host the
  name is at most 32 characters (the Linux limit), and a name that
  `/etc/passwd` already holds (`root`, `solus`, `git`, a user an agent added
  with `apt`) is not free: the id slug is added, as for two members with one
  name. It is fixed the first time it is named and kept through a rename.
- **uid:** allocated by the server from 20000–59999 and stored in
  `member_folder` (a `uid` column), so it never changes on that host. A removed
  member's row is kept as retired, so their uid is never given to another
  person: the files they left in shared projects keep their uid.
- **Created** by the user reconcile, with no login shell and no password, and
  home at the member's home folder (§5).
- **Removed** by the user reconcile when the member may no longer use the host
  (§8.3).

### 4.1 The user reconcile

One loop makes the host's member users match the people who may use the host:

```
desired = members of every organization this host is attached to
for each person in desired with no ready user  → name, useradd, create folders, tell the server
for each member user not in desired            → stop its processes, remove user and folders, retire the row
```

It runs at two times, and there is no poll (maintainers, 2026-10-15):

- **when the cloud notifies the host:** an invite is accepted, a member is
  removed, the host is attached to or detached from an organization. This is
  the notification that seat sync already receives
  (docs/plans/cloud-vault.md).
- **at boot**, before the server admits a member. This covers a new host (every
  member with access gets their user and home), and an R2 restore whose
  `/etc/passwd` came back without the member users.

The reconcile talks to the server over the local control socket that seat sync
already uses, with two requests:

| Request | Effect |
|---|---|
| `memberUser {userId, name}` | the server names the folder and allocates the uid if they are new; answers `{ username, uid, home }` |
| `memberReady {userId}` / `memberRemoved {userId}` | the server marks the member ready (and tells their connections, §8.1) or stops their sessions |

`useradd`, `chown`, and the process stop are the reconcile's (root). Every step
is idempotent: a user that exists with the right uid is left as it is.

## 5. Folders

The user reconcile creates every folder in this table for a member, with its
owner and mode, before it tells the server the member is ready. The server does
not create a member folder on a shared host (today `SeatManager.userHome`,
`ActingIdentity.envSync`, and `projectsRootFor` make them lazily).

| Path | Owner and mode | Why |
|---|---|---|
| `<seats>`, `<seats>/claude`, `<seats>/codex`, `<seats>/home` | `solus:solus 0711` | a member passes through to their own folder, but cannot list, delete, or rename a member folder |
| `<seats>/claude/<username>` (`CLAUDE_CONFIG_DIR`) | `<username>:solus 0750` | only the member writes; the server reads (profile files, seat status) |
| `<seats>/codex/<username>` (`CODEX_HOME`) | `<username>:solus 0750` | same |
| `<seats>/home/<username>` (`HOME`) | `<username>:solus 0750` | `github.json`, `gh/hosts.yml`, `.gitconfig`, the member's own files |
| `<seats>/home/<username>/tmp` (`TMPDIR`) | `<username> 0700` | `/tmp` is shared |
| `<projects>/<username>` (their projects root) | `<username>:solus-proj 2775` | they clone here; others in the project group can work in it |
| injected `.credentials.json`, `auth.json` | `<username> 0600` | seat sync writes the file, then gives it to the member user |
| project folders and worktrees | creator `:solus-proj 2775`, `core.sharedRepository=group` | members share repositories on a host |
| shared transcripts (`~/.claude/projects` link target) | `solus:solus-proj 2770` | "resume any thread" stays; the session index reads it |
| browser profiles (§6) | `<username> 0700` | cookies are credentials |

**The home cannot be deleted.** Its parent is not the member's, so the member
cannot delete or rename their home or their seat folders; what is inside them
is theirs. Solus's own files there (`.gitconfig`, `github.json`,
`gh/hosts.yml`, the agent profile files) are written by the member's process
through the launch point, not by the server, and are written again at each
launch, so a member who deletes one gets it back at their next process.

The member `.gitconfig` that Solus writes gets `safe.directory` for the projects
root, because git refuses a repository that another user owns.

The server is in group `solus`, and member users are not, so the server reads a
member's folders and members cannot read each other's.

`/proc` with `hidepid=2` (a member cannot see another member's command lines) is
deferred: it also hides member processes from the server unless it is mounted
with `gid=solus`, and command lines are not where credentials are.

## 6. Browser profiles

- A profile row gets `owner_key`; it is a personal resource (`roleOf`: only the
  owner). The built-in default profile is per project **and** person.
- The partition is `browserProfilePartition(projectRoot, profileId, personKey)`.
- Cookie import writes only into the importing person's profile.
- The browser tools in a run act as the run's person (`currentPersonKey()`).
- On a shared host each member's Playwright browser is its own process, started
  through the launch point as the member user, with its profile folder owned by
  that user.
- A shared page that two people look at (presence, a guest watching) shows the
  owner's page; another person cannot drive it with their own profile.

### 6.1 The person part (built 2026-10-14)

Built on every host. The browser process as the member user waits for step 2.

- **Rows.** `browser_profiles` and `browser_profile_defaults` have
  `owner_key NOT NULL` in their primary keys (host migration slot after the
  automation owners). The slot drops the old tables: a row with no owner is not
  kept, and the jars of the old project-wide partitions are not read again (no
  migration). The built-in default has no row; it is the person's own jar.
- **Partition.** `…-<project hash>-u-<person>` for the default profile and
  `…-u-<person>-p-<profile id>` for a named one. `<person>` is the hex of the
  person key's UTF-8 bytes: safe as a directory and a partition name, the same
  on a case-insensitive disk, and never shared by two keys (a hash could be).
- **The host's own work** (person null, `HOST_ACTOR` or a host-scope tool call)
  has no profiles. Its pages open in an unsaved jar,
  `solus-browser-unsaved[-<project hash>]`: no `persist:` prefix, so Electron
  keeps it in memory, and a Playwright host gives it a temporary directory
  (`launchPersistentContext('')`) that goes with the context. Both hosts refuse
  to import into it or clear it. Naming a profile for host work is refused.
- **Pages.** `BrowserPage.ownerKey` is the person whose jar the page uses: the
  caller of `browserOpen`, or the person of the run whose agent called
  `browser_open`. Only that person drives the page (`BrowserRegistry.assertDrivableBy`):
  close, navigate, viewport, appearance, snapshot, interact, attach, detach and
  report a surface, evidence, recording, DevTools, and annotation. Anyone who
  may use the browser lists the page and subscribes to its frames, so a page
  another person watches shows the page. The same rule holds for a session's
  editor: their turn acts as them, so their agent opens its own page rather than
  driving the page the owner's turn opened. A guest has no `host.use` and so no
  browser methods; a guest who watches a shared session's browser is not built.
- **RPC checks.** The profile methods name a project and a profile id, which is
  unique only per person, so the gate cannot find a profile from a call. They
  are not in `RESOURCE_VERB_OF_METHOD`; every handler reads the caller from the
  acting scope and reads and writes only the caller's rows. Another person's
  profile is answered as one that does not exist. `browserClearProfile` takes
  `(projectRoot, profileId)`, not a client's partition name. The host's own
  work calling a profile method is refused.
- **Events.** `browser.profilesChanged` carries `ownerKey` and reaches only the
  owner's connections, the host owner's included only for their own
  (`eventVisibleTo`). The desktop's own IPC connection is checked as the local
  owner.
- **Clients.** The profile list is the caller's own; nothing else changes
  visually. On the desktop a native `<webview>` hosts only the desktop person's
  pages (`shouldUseNativeBrowser`); another person's page, and the host's own,
  is streamed. Mobile shows no browser pages.
- **Link and unlink** do not move profile rows (`host-user-rows.ts`): the jar
  is named by the person key and cannot move. After a link or an unlink the
  host's user starts with no named profiles and an empty default jar; the old
  rows and jars come back if the key returns.
- **Agent tools.** `browser_status` lists only the pages and profiles of the
  run's person; every page verb, `browser_close`, and `browser_dialog` refuse a
  page in another person's jar.

## 7. Host setup

- **Managed host (solus-cloud `host-worker/image`):** the image has the
  `solus-proj` group. The boot script starts the server with
  `setpriv --reuid solus --regid solus --init-groups --inh-caps +setuid,+setgid --ambient-caps +setuid,+setgid`
  (`packaging/managed-host/sprite-boot.sh` today has no capabilities). The host
  worker runs the user reconcile (§4.1) beside seat sync, and seat sync gives
  each written credential file to the member user.
- **Self-hosted Linux host attached to an organization:** unchanged for now
  (decision 2). Its members are separated by environment only, as plans/019
  says.
- **Personal machine and desktop:** unchanged.

## 8. Flows

### 8.1 A new person joins the organization

1. The organization owner invites them in Solus Cloud; they accept. The cloud
   adds the `member` row and notifies every running managed host of the
   organization.
2. On each host the user reconcile runs (§4.1): the server names the user, the
   reconcile creates it and its folders, and tells the server it is ready.
3. They connect Claude or Codex in their account (seat vault). Seat sync writes
   the credential file into `<seats>/claude/<username>` and gives it to the
   member user. If they connected a seat before step 2 ended, seat sync writes
   it once the user is ready.
4. The person opens the host from a client. The ticket door admits them as an
   organization member, and the server makes their delegation, as today.
5. Their first run goes through the launch point: the agent starts as
   `<username>` with their own `HOME`, seat, GitHub runtime login, and browser.

**Before the user is ready.** The ticket door still admits the connection, so
the client can be told when the user is ready. The connection's server info
says `memberWorkspace: 'preparing'`, and a turn is refused with
`WORKSPACE_PREPARING`. When the reconcile sends `memberReady`, the server sends
the change to that person's connections; the client needs no poll.

**What the client shows.** The existing no-host state is extended, not given a
new screen: when the person has no host they can use, and at least one of their
hosts says `preparing`, it says **"Setting up your workspace for the first
time"** with a progress indicator, and names no host. When one host is ready,
the client goes on as usual; hosts still preparing are not shown as a separate
state.

- **Desktop and web:** the draft's connect-host page
  (`session-draft/ConnectHostPage.svelte`, docs/plans/draft-connect-host.md).
  `draftHostGate` (`session-draft/lib/host-gate.ts`) counts a host as usable
  only when it is online **and** not `preparing`, so a connected host that is
  still setting the person up shows the page, not the composer.
  `connectHostHeadline` gives the setup line in that case. The draft's text is
  kept, as for an offline host.
- **Mobile:** `deriveHomeEmptyState`
  (`apps/mobile/src/features/home/home-empty-state.ts`), the "No hosts
  connected" state, with the same rule.

If they open the host before they connect a seat, the run is refused with
`SEAT_REQUIRED` as today.

### 8.2 A new managed host

At boot the user reconcile creates a user and folders for every member of every
organization the host is attached to, before the server admits a member. A
member who opens the host meanwhile sees §8.1's preparing state.

### 8.3 A person leaves the organization or is removed from the host

1. The cloud ends their delegation and notifies the host (the host's next
   refresh is also refused: `onRevoked` in `boot-server.ts`).
2. The user reconcile tells the server (`memberRemoved`), which stops their
   sessions as today. Then it stops every process of that uid (the uid is the
   member's alone), removes the user, their seat folders, their home, and their
   browser profiles, and retires the row.
3. Their projects and transcripts stay; their files there keep their numeric uid
   and the `solus-proj` group, so the others can still use them. Their projects
   root stays with its files.

### 8.4 Restart and restore

At boot the user reconcile runs before the server admits a member (§4.1), so a
restored `/etc/passwd` without the member users is corrected. Seat sync writes
the seats again (they are in memory). A member whose user cannot be made is
refused with a reason; the others work.

A notification the host misses is caught at the next notification or the next
boot. There is no poll.

## 9. Decisions and limits

- **The Agent SDK** starts the CLI through `spawnClaudeCodeProcess` (§3).
- **A member's runs continue after they disconnect** (maintainers, 2026-10-14),
  as the member user.
- **Disk quotas per member:** not in this plan.
- **Network isolation between members** (one member's dev server reachable by
  another on localhost): not in this plan; the host already admits only
  organization members.

## 10. Steps

Each step ships with its tests and leaves the tree green.

1. **Launch point** — `ActingIdentity.launch`; every caller in §3 moves to it;
   the lint rule. No uid yet. Tests: every process start goes through it.
2. **Member users on the server** — username and uid in `member_folder` (§4),
   retired rows; the `memberUser`, `memberReady`, and `memberRemoved` control
   requests; `launch` gives uid/gid on a managed host; no lazy member folders
   there; Solus's home files written through the launch point at each launch;
   `safe.directory`.
3. **Browser profiles per person** (§6). The person part (owner, partition,
   cookie import, tools, clients) is built (§6.1, 2026-10-14) on every host;
   the browser process as the member user comes with step 2.
4. **Preparing state** — `memberWorkspace` on server info, `WORKSPACE_PREPARING`,
   the ready event, and the "Setting up your workspace for the first time"
   state: `draftHostGate`, `connectHostHeadline`, and `ConnectHostPage` on
   desktop and web; `deriveHomeEmptyState` on mobile (§8.1). Tests: the gate
   shows the page for a host that is online and preparing, and the composer
   once it is ready.
5. **Host worker and image** — listed for solus-cloud `host-worker/image`: the
   user reconcile (§4.1) on notification and at boot, seat sync `chown`,
   `setpriv` with the two capabilities, the `solus-proj` group.
6. **Proof** — the host worker's Linux container proof (`bun run proof` in
   solus-cloud `host-worker`) gains: bob's agent cannot read alice's seat folder,
   home, or browser profile; bob cannot delete his own home folder; both commit
   to one shared repository; an accepted invite makes the member's user on a
   running host, and a new host makes every member's user at boot; a removed
   member's processes stop, their folders go, and their uid is not given again;
   a restart restores every member user. macOS cannot run this; the Lab's local
   hosts stay as they are.
