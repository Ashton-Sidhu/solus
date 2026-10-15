# Member isolation — one Linux user per member on a shared host

Status: decided 2026-10-14 (maintainers: §2 decisions 1–3, §9). Browser
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
  organization (`isOrganizationAttached()`). Isolation is on for every shared
  host and off for a personal machine.
- **member user** — the Linux user that runs one member's processes on one
  host: name `m-<short id>`, a fixed uid from the member range.
- **server user** — `solus`: the Solus server and the host's own work (no person).
- **launch point** — the one function that starts a process for a person. It
  gives the environment, the uid, and the gid.
- **user helper** — `solus-userd`, a small root program on the host that creates,
  updates, and removes member users. It is the only root code that Solus adds.
- **project group** — `solus-proj`: the group that owns shared project folders.

## 2. Decisions

1. **The server switches users with two Linux capabilities** (maintainers,
   2026-10-14). The server runs as `solus` with `CAP_SETUID` and `CAP_SETGID` as
   ambient capabilities, and nothing else. Node starts a member process with
   `spawn(cmd, { uid, gid })`, and the terminal with `node-pty`'s `uid`/`gid`.
   There is no `sudo` and no setuid binary.
2. **Self-hosted Linux hosts that are shared with an organization are isolated
   too** (maintainers, 2026-10-14). Their operator runs the host setup (§7).
3. **A person's browser profiles are theirs.** Today a profile is keyed by the
   project and a profile id (`browserProfilePartition`), so alice's imported
   cookies sign bob's agent in as alice. A profile becomes a personal resource
   (access-model.md §2.3: only its owner reaches it), its partition includes the
   person key, and on a shared host its browser process runs as the member user.
4. **The server never creates users.** Two capabilities let it switch to a user;
   writing `/etc/passwd` needs root. The user helper does it, and the server asks
   it over a local socket. The helper takes a person key and answers a uid; it
   runs no command for the server.

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

- **uid:** allocated by the server, stored with the member's folder
  (`member_folder` gets a `uid` column), so it never changes on that host. The
  range is 20000–59999. The name is `m-` and the first 12 characters of a hash
  of the person key.
- **Created** by the user helper, with no login shell and no password, and home
  at the member's home folder (§5).
- **Created again at every boot** from `member_folder`, because a container's
  `/etc/passwd` can come back from an R2 restore without them. The helper's
  `ensure` is idempotent.
- **Removed** when the member leaves the organization or the host (§8).

The user helper answers three requests on `/run/solus-userd.sock` (mode 0600,
owner `solus`):

| Request | Effect |
|---|---|
| `ensure {personKey, uid, folder}` | create or correct the user, the group memberships, and the folders' owners; idempotent |
| `remove {personKey}` | stop the user's processes, remove the user and their seat folders |
| `list` | the member users it knows, for the boot check |

## 5. Folders

| Path | Owner and mode | Why |
|---|---|---|
| `<seats>/claude/<folder>` (`CLAUDE_CONFIG_DIR`) | `m-<id>:solus 0750` | only the member writes; the server reads (profile files, seat status) |
| `<seats>/codex/<folder>` (`CODEX_HOME`) | `m-<id>:solus 0750` | same |
| `<seats>/home/<folder>` (`HOME`) | `m-<id>:solus 0750` | `github.json`, `gh/hosts.yml`, `.gitconfig`, the member's own files |
| `<seats>/home/<folder>/tmp` (`TMPDIR`) | `m-<id> 0700` | `/tmp` is shared |
| injected `.credentials.json`, `auth.json` | `m-<id> 0600` | seat sync writes the file, then gives it to the member user |
| project folders and worktrees | creator `:solus-proj 2775`, `core.sharedRepository=group` | members share repositories on a host |
| shared transcripts (`~/.claude/projects` link target) | `solus:solus-proj 2770` | "resume any thread" stays; the session index reads it |
| browser profiles (§6) | `m-<id> 0700` | cookies are credentials |
| `/proc` | mounted with `hidepid=2` | a member cannot see another member's processes or command lines |

The member `.gitconfig` that Solus writes gets `safe.directory` for the projects
root, because git refuses a repository that another user owns.

The server is in group `solus`, and member users are not, so the server reads a
member's folders and members cannot read each other's.

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

- **Managed host (solus-cloud `host-worker/image`):** the supervisor (root)
  starts `solus-userd`, creates the `solus-proj` group, mounts `/proc` with
  `hidepid=2`, and starts the server with
  `setpriv --reuid solus --regid solus --init-groups --inh-caps +setuid,+setgid --ambient-caps +setuid,+setgid`.
  Seat sync gives each written credential file to the member user.
- **Self-hosted Linux host:** `solus host setup --shared` (run once as root)
  installs `solus-userd` and the server as systemd units with the same user,
  capabilities, group, and `/proc` mount. A server that finds itself attached to
  an organization without the user helper refuses member work and says why
  (`HOST_NOT_ISOLATED`).
- **Personal machine and desktop:** unchanged.

## 8. Flows

### 8.1 A new person joins the organization

1. The organization owner invites them in Solus Cloud; they accept. The cloud
   adds the `member` row.
2. They connect Claude or Codex in their account (seat vault). The cloud tells
   every running managed host of their organizations to sync seats
   (the cloud vault's seat write; docs/plans/cloud-vault.md); a host that misses it syncs within a minute.
3. Seat sync on the host asks the server (local control socket) for the
   member's folder and uid. The server allocates the uid, records it in
   `member_folder`, and asks the user helper to `ensure` the user. Seat sync
   writes the credential file into `<seats>/claude/<folder>` and gives it to the
   member user.
4. The person opens the host from a client. The ticket door admits them as an
   organization member, and the server makes their delegation, as today.
5. Their first run goes through the launch point: `ensure` again (a no-op), then
   the agent starts as `m-<id>` with their own `HOME`, seat, GitHub runtime
   login, and browser.

If step 4 happens before step 2 (no seat yet), the server still `ensure`s the
user at admission, and the run is refused with `SEAT_REQUIRED` as today.

### 8.2 A self-hosted shared host

Steps 1, 4, and 5 are the same. There is no seat sync: the member connects a seat
on the host (the relayed sign-in or a pasted token), which runs through the launch
point as their user, so the CLI writes its file as them.

### 8.3 A person leaves the organization or is removed from the host

1. The cloud ends their delegation; the host's next refresh is refused
   (`onRevoked` in `boot-server.ts`), or seat sync finds no seat for them.
2. The server stops their sessions (as today), and asks the user helper to
   `remove` them: it stops every process of that uid (the uid is the member's
   alone), and removes the user and their seat folders and browser profiles.
3. Their projects and transcripts stay; their files there keep their numeric uid
   and the `solus-proj` group, so the others can still use them.

### 8.4 Restart and restore

At boot the server reads `member_folder` and asks the user helper to `ensure`
every member, before it admits anyone. Seat sync writes the seats again (they are
in memory). A member whose `ensure` fails is refused with a reason; the others
work.

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
2. **Member users on the server** — uid allocation in `member_folder`; the user
   helper client; `launch` gives uid/gid on a shared host; folder owners and
   modes (§5); `safe.directory`; `HOST_NOT_ISOLATED`. The `solus-userd` program
   in `packages/server/bin/` (or its own small package).
3. **Browser profiles per person** (§6). The person part (owner, partition,
   cookie import, tools, clients) is built (§6.1, 2026-10-14) on every host;
   the browser process as the member user comes with step 2.
4. **Lifecycle** — ensure at seat sync, admission, first run, and boot; remove at
   revocation (§8).
5. **Host setup** — the self-hosted `solus host setup --shared`; the managed
   image changes, listed for solus-cloud `host-worker/image` (supervisor, seat
   sync `chown`, `setpriv`, `hidepid`, group).
6. **Proof** — the host worker's Linux container proof (`bun run proof` in
   solus-cloud `host-worker`) gains: bob's agent cannot read alice's seat folder,
   home, or browser profile; `ps` shows bob only his own processes; both commit
   to one shared repository; a new member's seat arrives and their first run is
   their uid; a removed member's processes stop and their folders go; a restart
   restores every member user. macOS cannot run this; the Lab's local hosts stay
   as they are.
