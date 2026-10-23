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
`CODEX_HOME` point at the member's folders under the seats root. (Where each
member is their own user, §5: only `HOME` does, and the CLIs keep their defaults.) An agent runs
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
  organization (`isOrganizationAttached()`). Isolation is on for a managed host
  (decision 2) and off for a personal machine.
- **member user** — the Linux user that runs one member's processes on one
  host. Its username is the member's folder name (`ada-lovelace`), and its uid
  is fixed from the member range.
- **server user** — `solus`: the Solus server and the host's own work (no person).
- **launch point** — the one function that starts a process for a person. It
  gives the environment, the uid, and the gid.
- **host object** — the `CloudflareHost` Durable Object in the solus-cloud host
  worker (`host-worker/src/index.ts`): one per managed host. It owns the host's
  container, its durable storage, and seat sync, and runs one operation at a
  time.
- **member users table** — `userId → { username, uid }`, and the retired uids,
  in the host object's storage. The one record of who has a user on the host.
- **user reconcile** — the host object's step that makes the table and the
  container's users match the people who may use the host. Its root work in the
  container is one script, run with `exec` as seat sync runs its script. It is
  the only root code that this plan adds.
- **users file** — `/run/solus-managed/member-users.json`, written by the user
  reconcile: the table as the server reads it.
- **project group** — `solus-proj`: the group that owns shared project folders.

## 2. Decisions

1. **One small program switches users; the server holds no capability**
   (maintainers, 2026-10-15; replaces "the server holds `CAP_SETUID` and
   `CAP_SETGID` as ambient capabilities"). Ambient capabilities pass to every
   program the server starts, and a change between two non-zero uids does not
   clear them: a member's agent could become another member, or root (proved in a
   Linux container). So the server runs as `solus` with no capability, and starts
   a member's process through the **member switch**,
   `/usr/local/libexec/solus-switch <uid> -- <command> [args]`
   (solus-cloud `host-worker/image/solus-switch.c`, about 60 lines of C). It holds
   `cap_setuid,cap_setgid` as file capabilities and is `root:solus` 0750, so only
   the server runs it. It switches only to a member uid (20000–59999) and only to
   the `solus-proj` group, never to root; clears the supplementary groups and the
   ambient set; sets `no_new_privs`; sets umask 002, so members can change each
   other's files in shared projects; then runs the command, which starts with no
   capability. A script cannot do this: Linux gives file capabilities only to a
   compiled program, never to a script's interpreter.
2. **Managed hosts first** (maintainers, 2026-10-15; replaces "self-hosted
   shared hosts are isolated too"). A self-hosted host attached to an
   organization keeps today's separation by environment until a later plan:
   it has no host object to run the user reconcile as root.
3. **A person's browser profiles are theirs.** Today a profile is keyed by the
   project and a profile id (`browserProfilePartition`), so alice's imported
   cookies sign bob's agent in as alice. A profile becomes a personal resource
   (access-model.md §2.3: only its owner reaches it), its partition includes the
   person key. The browser keeps running as the server (2026-10-15): its
   profiles stay in the server's data folder, which no member's process reaches.
4. **The host object owns the member users** (maintainers, 2026-10-15;
   replaces the `solus-userd` helper and the server's control requests). Two
   capabilities let the server switch to a user; writing `/etc/passwd` needs
   root. The host object already owns the container, reaches it as root
   (`exec`, the `Files` API), and receives the cloud's notifications, so it
   names the users, keeps the table, and runs the root script. The server only
   reads the users file. There is no daemon on the host, no socket, and no
   request protocol; the server cannot reach root (`/run/solus-control` is
   root's, 0700).

## 3. The launch point

Every process that runs for a person takes its launch options from one place:
`ActingIdentity.launchOptions(extra)` (or `launchOptionsSync`, and the free
`launchOptions(extra)` in `cli-env.ts` for the current acting scope). It gives
`{ env, user? }`. It is data, never `spawn` options: Node would ignore `user`,
and the process would run as the server. `launchedProcess(launch, file, args)`
(or `launchProcess(file, args)` for the current scope) gives the command line
to run: `file` with `args` as it is, or, for a member who is their own user,
`solus-switch <uid> -- file args`. A seat carries the launch options
(`TurnSeat.launch`). These callers use it (built 2026-10-15, steps 1 and 2):

- the Claude agent (`execution/agents/claude/claude-agent.ts`): the Agent SDK's
  `spawnClaudeCodeProcess` option lets the launch point start the CLI itself,
  with the member's uid and gid. No wrapper is needed. `HOME` and
  `CLAUDE_CONFIG_DIR` only tell the CLI where its files are; the uid is what
  stops it from reading another member's files;
- the Codex app server (`execution/agents/codex/codex-agent.ts`): one process
  per member already;
- git and `gh` commands (`git/exec.ts`), the login probe (`seat-login.ts`),
  setup steps and probes (`setup-handlers.ts`), and the skills CLI
  (`skills/skills-cli.ts`);
- seat sign-in relays (`execution/seats/seat-connect.ts`, `agent-auth.ts`);
- not the browser: it runs as the server, and its pages act for one person
  through §6.1's partitions and page ownership (§6).

The server starts no terminal pty; the desktop's terminal is the local
owner's. On a personal machine the launch options give the same answer as
today and no uid; the Claude SDK keeps its own spawn unless the seat names a
user (`claudeLaunch`). The lint rule `solus/acting-identity` rejects spreading
launch options into `spawn` options, an `env:` taken from an identity's `env()`
or `envSync()` alone (both would drop the member's user), and an environment
built from `process.env`.

## 4. Member users

- **Username:** named by the host object from the member's name with the rule
  of `memberFolderName` (`host/member-folders.ts`): `ada-lovelace`, at most 32
  characters (the Linux limit). The same name is the member's folder, `HOME`,
  and seat folders: on a shared host the server takes the folder from the users
  file, not from `member_folder`. A name another member holds, or that
  `/etc/passwd` already holds (`root`, `solus`, `git`, a user an agent added
  with `apt`), is not free: the id slug is added. The script reports a clash
  with a user that is not a member; the host object then adds the slug. A name
  is fixed the first time it is given and kept through a rename.
- **uid:** allocated by the host object from 20000–59999 and kept in the table,
  so it never changes on that host. A removed member's uid is retired, never
  given to another person: the files they left in shared projects keep it.
- **Created** by the user reconcile, with no login shell and no password, and
  home at the member's home folder (§5).
- **Removed** by the user reconcile when the member may no longer use the host
  (§8.3).

### 4.1 The user reconcile

One pass in the host object, inside its one-at-a-time lock
(`controller.exclusive`, as `refreshSeats`):

```
members  = GET /v1/orgs/:organizationId/members   (host-worker auth: { userId, name })
table    = the member users table, in the host object's storage
for each member not in table        → name a username, allocate a uid, add to table
for each table row not in members   → retire its uid, remove the row
exec the users script with the table on stdin (root, in the container)
```

The users script is idempotent and does only root work:

- `useradd`/`usermod` each user with its uid, `solus-proj` as its primary group
  (Node's `spawn` with a `uid` drops supplementary groups, so a member's
  processes keep only their primary group), no login shell, and home at its home
  folder; creates the folders of §5 with their owners and modes;
- for a user no longer in the table: stops its processes (by uid, which is the
  member's alone), `userdel`, and removes its seat folders, home, and browser
  profiles;
- writes the users file (`solus`-readable, in the server's own 0700
  `/run/solus-managed`), last, so a user is in the file only once their folders
  exist;
- answers the usernames it could not use (a clash with a user that is not a
  member).

It runs at two times, and there is no poll (maintainers, 2026-10-15); the host
object's one-minute alarm does not run it:

- **when the cloud notifies the host object:** an invitation is accepted, a
  member is removed. Today the cloud notifies a host only on a seat write
  (`vault.ts` `notifyHosts`, `POST /v1/hosts/:name/seats`); the membership
  changes gain the same call to a new `POST /v1/hosts/:name/members`.
- **at start**, before the server starts (`HostController.start`, beside the
  seat pull). `/run` is not kept in a snapshot, and `/etc/passwd` can come back
  from an R2 restore without the member users, so a start writes both again.
  This covers a new host too: every member gets their user and home.

**The layout.** The users file also names every folder the script made, so the
server and the image cannot disagree about a path (built 2026-10-15):

```json
{ "layout": { "switch": "/usr/local/libexec/solus-switch", "shared": "/data/shared",
              "reviews": "/data/projects/.solus-review" },
  "users": [{ "userId": "…", "username": "ada-lovelace", "uid": 20000,
              "home": "/data/members/ada-lovelace",
              "secrets": "/run/solus-seats/github/ada-lovelace" }] }
```

The server reads the file at the top of `boot-core.ts`, before it places the
bundled plugin, and finds it with the one value the supervisor already sets
(`SOLUS_MANAGED_RUNTIME=cloudflare` → `/run/solus-managed/member-users.json`;
the Lab names its own with `SOLUS_MEMBER_USERS_FILE`). Every other path comes
from the file: the member switch (`useMemberSwitch`), a member's `HOME` and
GitHub files, the plugin folder, the shared files, and review checkouts. With no
users file, every path is today's.

The server reads the users file and watches it (`fs.watch` on its folder). A
member in the file is ready (§8.1); a member who leaves it is stopped (§8.3).
`launchOptions` takes the uid from it. A new or changed layout (the script ran
after the server started) installs its switch and places the plugin again.

## 5. Folders

The user reconcile creates every folder in this table for a member, with its
owner and mode, before it writes the member into the users file. The server does
not create a member folder on a shared host (today `SeatManager.userHome`,
`ActingIdentity.envSync`, and `projectsRootFor` make them lazily).

| Path | Owner and mode | Why |
|---|---|---|
| `<seats>`, `<seats>/claude`, `<seats>/codex`, `<seats>/github`, `/data/members` | `solus:solus 0711` | a member passes through to their own folder, but cannot list, delete, or rename a member folder |
| `<seats>/bin` (the sign-in shims) | `solus:solus 0755` | a member's relayed sign-in runs them (the server sets this) |
| `<seats>/claude/<username>`, `<seats>/codex/<username>` | `<username>:solus 2750` | the member's logins, in memory only: `.credentials.json`, `auth.json`, a pasted seat token. Only the member writes; setgid `solus`, so the server reads what Solus wrote there and no other member does |
| `/data/members/<username>` (`HOME`) | `<username>:solus 2750` | `.gitconfig`, the member's own files; kept, and in the R2 backup (maintainers, 2026-10-15); the member owns their home, as `ssh` and `git` require |
| `/data/members/<username>/tmp` (`TMPDIR`) | `<username> 0700` | `/tmp` is shared |
| `~/.claude`, `~/.codex`, `~/.config/gh`, `~/.config/solus` in the home | `<username>:solus 2750` | the CLIs keep their own defaults under `HOME`, as on any machine: the server sets no `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `GH_CONFIG_DIR` for a member |
| `~/.claude/projects`, `~/.codex/sessions` in the home | links to the host's transcript folder | sessions are the organization's (§5.1) |
| the server's `~/.claude/projects` and `~/.codex/sessions` | `solus:solus-proj 2770`, inside the server's `~/.claude` and `~/.codex` (`solus:solus 0711`) | the host's one transcript folder: members pass through to it and cannot list the server's config |
| `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.config/gh/hosts.yml`, `~/.config/solus/github.json` | links into `<seats>` | each CLI finds its login where it looks, and no backup holds one. A CLI that replaces a link with a file when it refreshes leaves the newest login in the home; the next users pass moves it to memory and links it again |
| `<seats>/github/<username>` (`secrets`) | `<username>:solus 2750` | `github.json` and `gh/hosts.yml`, found through the home's links: memory only, never in a backup; written again from the account at each use |
| `/data/shared` | `solus:solus 0755` | `plugins/`: the bundled Solus plugin, which the server writes and every member reads |
| `/data/shared/files` | `solus:solus-proj 2710` | files handed to an agent by path (attachments, large screenshots): each in a folder made `2710` (setgid, so its files keep `solus-proj`; a plain `0710` gave them the server's group), files `0640` |
| `/data/projects/.solus-review` | `solus:solus-proj 2775` | managed pull request review checkouts, one per member and pull request; members' git works there, and the server clears them |
| `<projects>/<username>` (their projects root) | `<username>:solus-proj 2775` | they clone here; others in the project group can work in it |
| `<projects>/<username>/solus-chats` | `<username>:solus-proj 2775` | each chat folder is also `2775`, so members can start sessions in each other's working directories; personal homes and logins stay private (maintainers, 2026-10-23) |
| injected `.credentials.json`, `auth.json` | `<username> 0600` | seat sync writes the file, then gives it to the member user |
| project folders and worktrees | creator `:solus-proj`, group-writable | members share repositories on a host, and the server writes in them too (turn snapshots in `.git/solus`, an index refresh): a guest's or another member's turn runs git there as a different user. So the server runs as members do, with `solus-proj` as its main group and umask `002` (the supervisor); `solus` stays its second group, to read members' homes. What it writes outside `0700` folders is readable by members |
| browser profiles (§6) | in `/data/state/browser-profiles`, the server's alone | cookies are credentials; the browser runs as the server, so a profile stays where no member's process reaches it, and §6.1 keeps each person's partition apart |

At each container start, the user reconcile updates existing project directories
and files to the shared project group with group write access. Directories also
get group traversal and setgid inheritance. This migration does not follow
symlinks into private homes or login folders. A stamp in `/run/solus-managed`
prevents repeated scans during the same container lifetime.

### 5.1 Transcripts are the organization's

Isolation keeps what is a person's own: their logins, their home, and their
temporary files. Sessions are not: a session a member creates in an organization
space gets an organization `editor` entry (access-model.md), so every member may
read and continue it through Solus. Separating transcript files by Linux user
would protect nothing and break sharing.

So a host keeps one transcript folder: the server's own `~/.claude/projects`
and `~/.codex/sessions` (`solus:solus-proj 2770`, setgid). Every member's
`~/.claude/projects` and `~/.codex/sessions` link to it, so any member resumes
any thread at their CLI's default path, and the server's indexer scans and
watches the one folder, as on a single-person host. The CLIs write each
transcript `0600`; when a member's turn ends, one short process running as the
member gives the project group read and write to the transcripts they wrote in
that turn, and to their folders there (`execution/seats/member-transcripts.ts`).
The indexer's watch sees the change. A new transcript stays `0600` until its
turn ends: a second tab that opens the session during that first turn sees its
history after the turn. A transcript the server cannot open reads as empty and
never stops the server.

The trade-off (maintainers, 2026-10-15): a session whose owner removes its
organization entry is private in Solus, but its transcript file stays readable
by other members' processes on that host. Linux cannot follow a per-session grant.

**The home cannot be deleted.** Its parent is not the member's, so the member
cannot delete or rename their home or their seat folders; what is inside them
is theirs. Solus's own files there (`.gitconfig`, `github.json`,
`gh/hosts.yml`, a pasted seat token, the agent profile files and their
manifest, a chat folder) are written by one short process running as the
member (`execution/seats/member-files.ts`, `applyMemberFiles`), not by the
server, with group read added so the server reads them back. `.gitconfig` is
written again whenever it is missing, so a member who deletes it gets it back
at their next process. The server makes no member folder itself on such a
host: `SeatManager.userHome`, `projectsRootFor`, and the seat removal leave the
folders to the host object.

**Nothing in the server's data folder reaches a member.** `/data/state` is the
server's alone (`solus` 0700), so a member's agent cannot open a path in it. A
file the server hands to an agent by path lives in `/data/shared` (maintainers,
2026-10-15): the bundled Solus plugin (`/data/shared/plugins`, readable by all),
and files given to an agent by path, such as a non-image attachment or a large
screenshot (`/data/shared/files/<random id>/`, root `solus:solus-proj` 2710, so
a member opens a path they know but cannot list the folder). Any member who can
see a session's transcript can open its attachments, which the transcript
already shows (maintainers, 2026-10-15). The lint rule
`solus/no-private-path-to-member` rejects `dataDir()` or `solusDir()` in text an
agent reads or in a launch's arguments; `artifact-tools.ts` is listed in it until
its large screenshots move to `/data/shared`.

**Proved in Linux** (the image's users, the real users script, and the switch
built from the image's own stage): the server holds no capability; a member's
process holds none and has `no_new_privs`; bob cannot read ada's login or home,
become ada or root, run the switch, or delete his own home; the switch refuses
root, `solus`, and any uid outside the member range; bob and ada both commit to
one shared repository, and the server reads it.

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
- The browser runs as the server, on every host (2026-10-15; replaces "each
  member's Playwright browser is its own process, as the member user"). Its
  profiles are in the server's data folder (`solus` 0700), so no member's process
  can read another person's cookies; §6.1 keeps the jars apart inside Solus.
- A shared page that two people look at (presence, a guest watching) shows the
  owner's page; another person cannot drive it with their own profile.

### 6.1 The person part (built 2026-10-14)

Built on every host.

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

- **Managed host (solus-cloud `host-worker/image`):** the image
  has the `solus-proj` group and the member switch: a build stage compiles
  `solus-switch.c`, and the runtime stage installs it `root:solus` 0750 with
  `setcap cap_setuid,cap_setgid+ep`. Cloudflare's image import drops file
  capabilities, so the supervisor runs the same `setcap` as root at each start,
  before the server. The supervisor starts the server as
  `solus`, group `solus-proj`, umask `002`, with no capability. The host object runs the user reconcile (§4.1). Seat sync writes each credential file into the member's folder and
  gives it to the member user (today `host-seats.ts` gives every seat to
  `solus`). The checkpoint check (`requireNoWriters`, `ps -u solus`) also checks
  every member user, or a member's detached process would be missed.
- **Self-hosted Linux host attached to an organization:** unchanged for now
  (decision 2). Its members are separated by environment only, as plans/019
  says.
- **Personal machine and desktop:** unchanged.

## 8. Flows

### 8.1 A new person joins the organization

1. The organization owner invites them in Solus Cloud; they accept. The cloud
   adds the `member` row and notifies the host object of every running managed
   host of the organization.
2. Each host object runs the user reconcile (§4.1): it names the user, the
   script creates it and its folders and writes the users file, and the server
   sees the member there.
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
`WORKSPACE_PREPARING`. When the member appears in the users file, the server
sends the change to that person's connections; the client needs no poll.

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

At its first start the host object's user reconcile creates a user and folders
for every member of the host's organization, before the server starts. A member
who opens the host before that ends sees §8.1's preparing state.

### 8.3 A person leaves the organization or is removed from the host

1. The cloud ends their delegation and notifies the host object (the host's
   next refresh is also refused: `onRevoked` in `boot-server.ts`, which stops
   their sessions as today).
2. The user reconcile retires their uid and runs the script: it stops every
   process of that uid (the uid is the member's alone), removes the user, their
   seat folders, their home, and their browser profiles, and writes the users
   file without them. The server sees them leave the file and stops anything of
   theirs still running.
3. Their projects and transcripts stay; their files there keep their numeric uid
   and the `solus-proj` group, so the others can still use them. Their projects
   root stays with its files.

### 8.4 Restart and restore

At each start the user reconcile runs before the server starts (§4.1), so a
restored `/etc/passwd` without the member users is corrected and the users
file, which `/run` does not keep, is written again. Seat sync writes the seats
again (they are in memory). A member whose user cannot be made is not in the
users file, so their turns are refused with a reason; the others work.

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

1. **Launch point** (built 2026-10-15) — `ActingIdentity.launchOptions`; every
   caller in §3 moves to it; the lint rule. No uid yet. Tests:
   `tests/unit/launch-point.test.ts`.
2. **Member users on the server** (built 2026-10-15) — read and watch the users file; on a host
   that has one, the member's folder is their username, `launchOptions` gives
   their uid and gid, no member folder is made lazily, and a member who leaves
   the file is stopped; Solus's home files written through the launch point at
   each launch; `safe.directory`. With no users file (every host but a managed
   host), nothing changes. Code: `host/member-users.ts`,
   `execution/seats/member-files.ts`. Tests: `tests/unit/member-users.test.ts`;
   Lab: `bun lab run member-users --host managed`.
3. **Browser profiles per person** (§6). The person part (owner, partition,
   cookie import, tools, clients) is built (§6.1, 2026-10-14) on every host.
   The browser stays the server's (§6).
4. **Preparing state** (built 2026-10-15) — `memberWorkspace` on server info, `WORKSPACE_PREPARING`,
   the ready event, and the "Setting up your workspace for the first time"
   state: `draftHostGate`, `connectHostHeadline`, and `ConnectHostPage` on
   desktop and web; `deriveHomeEmptyState` on mobile (§8.1). Tests: the gate
   shows the page for a host that is online and preparing, and the composer
   once it is ready.
5. **Host object, cloud, and image** (solus-cloud) — the member users table
   and the user reconcile in `CloudflareHost` (§4.1), run at start and on
   `POST /v1/hosts/:name/members`; the users script; the cloud route
   `GET /v1/orgs/:organizationId/members` for the host worker and the
   notification on an accepted invitation and a removed member; seat sync
   gives a seat to its member user; `requireNoWriters` checks member users;
   the member switch (`solus-switch.c`, its build stage, `setcap`); the
   supervisor starts the server with no capability; the `solus-proj` group in
   the image. Built 2026-10-15; proved in a Linux container, not yet on a
   deployed host.
6. **Proof** — the host worker's Linux container proof (`bun run proof` in
   solus-cloud `host-worker`) gains: bob's agent cannot read alice's seat folder,
   home, or browser profile; bob cannot delete his own home folder; both commit
   to one shared repository; an accepted invite makes the member's user on a
   running host, and a new host makes every member's user at boot; a removed
   member's processes stop, their folders go, and their uid is not given again;
   a restart restores every member user. macOS cannot run this; the Lab's local
   hosts stay as they are.
