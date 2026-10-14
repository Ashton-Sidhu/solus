# Agent profile

Your agent profile is what makes an agent work your way, on every host you
have a seat on:

| Part | What it holds |
|---|---|
| Instructions | Your extra instructions: a setting every prompt carries, edited on the Agent profile page. A home's `CLAUDE.md` or `AGENTS.md` is not part of it: an instructions file belongs with a project. |
| Files | `agents/`, `commands/` in `~/.claude`; `prompts/` in `~/.codex` |
| Skills | Skills installed from skills.sh, as references the host installs itself; hand-written skills as their files |
| MCP servers | The servers you added: name, address, and how they sign in. Never a key or a token. |

It is one document (`plans/020-agent-profile.md`). Each file, each skill, and
each server is one entry, and one entry is the unit that syncs and conflicts.
Logins, settings, plugins, hooks, and transcripts are not part of it.

## Where it lives

| You are | The profile's home | How a host gets it |
|---|---|---|
| Not signed in to Solus Cloud | Your computer | Solus on your computer pushes it to a host the first time it reaches one each run, and again when you ask |
| Signed in | Your account | Every host you have a seat on pulls it: when your seat connects, when a client of yours changes it, and every few minutes |

On a host that several people use, your profile goes into your own seats
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), and your MCP servers become records only
you see and use. On a host you own, such as a personal VM, it goes into the
host's own homes, and a file or a server the host already had is never
replaced: Settings counts what was kept.

Your computer is never overwritten. The account document is the place the
profile is sent from, not a copy that replaces `~/.claude`. When your computer
and the account differ on one entry, Settings shows both and you pick.

## Your computer fills the profile

On the desktop, Settings → Agent profile starts from this computer: the first
time the page opens with an empty profile, the skills installed with the
skills CLI, the subagents, commands, and prompts in the provider homes, and the
MCP servers of Settings → MCP join the profile by themselves. "Import from
this computer" adds what you installed since. An import never removes an entry:
the profile is your list, and the computer only fills it. The same join happens at sign-in, when your account
has no profile yet, and after "Clear synced profile".

What the desktop pushes to a host, signed out, is this list, so an entry you
removed on the page stays off every host. Web and mobile have no
computer to read; they add from skills.sh and by address.

## Sync

Signed in to Solus Cloud, your agent profile always syncs through your
account, the same as your settings. There is no switch per device. The first
time a client of yours signs in, it reads the account: an account with a
profile is used as it is, and an empty one starts from this computer's profile
on the desktop, or from this device's copy elsewhere. Settings → Account & sync shows
the sync status, the conflicts, and each host with its account link and what it
holds of the profile; the Agent profile tab holds the content. Edits apply at
once and are sent after a short pause.
Two clients that change different entries merge; one entry both changed is a
conflict with "Keep mine" and "Take theirs". "Clear synced profile" resets the
profile: the account copy and its MCP connections go, and the device you clear
on starts the profile again from its own copy (with this computer's profile
joined to it, on the desktop). Your other devices then take that new copy.

Your account is the one list. A server you add, rename, or remove in Settings →
MCP, on a host you own or as your own server on a shared host, changes your
profile, and every host follows. A server a host already had before you signed
in joins your profile on that host's next pull. A removal waits for Solus Cloud
to confirm it, so no host brings the server back; when the cloud does not
answer, the removal is refused with that reason.

Each entry can be removed, which takes it out of your profile and off every
host. Every host reconciles on its next pull: when your seat connects, when a
client of yours changes the profile, and every few minutes. You can remove an
entry in Settings → Agent profile on every client and on
your account page at app.solus.sh.

## MCP connections

Signed in, you sign in to a server once, at app.solus.sh, whether the server
is yours or the host's. Solus Cloud is the OAuth
client and the only refresher. A host reads an access token
from your account for each call and holds it in memory until it expires. It
never holds the refresh token or the client. A server row on a host then reads
"Connected through Solus Cloud".

A connection you made on a host before you signed in moves into your account
by itself the next time that host pulls your profile. When the account already
holds one for that server, the account's wins and the host revokes its own
token. Nothing on the host is deleted before the cloud confirmed the write.

When Solus Cloud does not answer, a host uses the token it cached until that
token expires, and then shows "Solus Cloud unreachable". That is not a sign-in
problem, and signing in again does not fix it. While you are signed in, the host
can always read your account: if its permission to act for you was refused, it
gets a new one from your sign-in during the same call. Only when no Solus sign-in
can give it one does the row show "Sign in to Solus".

Not signed in, a connection stays on the host that made it. The push carries
the server's record, and you sign in once on each host, as with a provider
seat.

## What is not copied

- Logins, `settings.json`, plugins, hooks, and transcripts.
- Hidden files and folders, and `node_modules`.
- A file larger than 1 MB, and the files after the profile reaches 16 MB.
  Settings shows how many were left out.

## Removing it

**Remove** on a host deletes what the profile put there: the copied files, the
registry skills it installed, and the MCP records it made, with their
connections. Your logins and anything else in your seats stay.

## How it works

- `agentProfileRead` runs on your computer's own host, for its administrator
  only. It reads the files, lists the registry skills with the skills CLI, and
  adds the host's own MCP records.
- `agentProfileApply` runs on the target host with a document from your
  computer. `agentProfilePull` makes the host read the document from your
  account with your delegated token.
- `AgentProfileManager` (`execution/seats/agent-profile.ts`) owns the profile
  on a host: the read, the apply, the pull, and the status. An apply runs three
  appliers in order — the files (`profile-files.ts`), the registry skills
  through the skills CLI, and the MCP records
  (`integrations/profile-integrations.ts`) — and writes one manifest last,
  `.solus-profile.json` in each seat home, with the source, the account
  revision, and every entry it owns. A pull applies only when the account
  revision moved, then asks `IntegrationConnections.reconcile` to move the
  person's host-local MCP connections into their account.
- The host refuses the whole copy before it changes anything when a path is
  outside the profile, a file is too large, a path goes through a link in the
  seat, or a registry skill and a hand-written skill share one name.
