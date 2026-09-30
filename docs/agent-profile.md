# Agent profile

Your agent profile is the set of files that makes an agent work your way:

| Provider | Files |
|---|---|
| Claude | `CLAUDE.md`, `skills/`, `agents/`, `commands/` in `~/.claude` |
| Codex | `AGENTS.md`, `skills/`, `prompts/` in `~/.codex`, and the skills in `~/.agents/skills` |

On a host that several people use, such as a cloud host of your organization,
your turns run on your own seat. Solus copies your profile from your computer
into your seats there, so an agent on that host uses your instructions and
skills. The copy goes one way: your computer is the source.

| Host | Where the copy goes |
|---|---|
| A host of your organization, such as a managed VM | Your seats (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) |
| A host you own, such as a personal VM | The host's own `~/.claude` and `~/.codex`, which your turns there use |
| Your computer itself | Nothing: it is the source |

On a host you own, a copy never replaces a file that the host already had, and
never writes through a link. It adds what your computer has, and Settings counts
the files it kept. Only files that an earlier copy put there are updated or
removed.

## When Solus copies it

Solus on your computer copies the profile the first time it reaches one of
those hosts, each time the app runs: when a draft or a conversation aims at the
host, or when Settings → Providers shows it. To copy changes later, open
Settings → Providers → Your agent profile and select **Copy again**. A session
that started before the copy arrived reads the new files in its next session.

The web and phone clients do not run on your computer, so they cannot copy. They
show what is on the host and can remove it.

## What is not copied

- Logins, `settings.json`, plugins, MCP servers, hooks, and transcripts.
- Hidden files and folders, and `node_modules`.
- A file larger than 1 MB, and the files after the profile reaches 16 MB.
  Settings shows how many files were left out.

## Removing it

**Remove** deletes the copied files from your seats on that host. Your logins
and anything else in your seats stay. A new copy replaces the old one: a skill
you deleted on your computer is deleted on the host too. A file that your
computer could not send (too large or unreadable) is not deleted: the copy
already on the host stays.

## How it works

`agentProfileRead` runs on your computer's own host, for its administrator
only. It reads the files above. `agentProfileApply` runs on the target host. For
an organization member, it writes the files into that member's seat homes
(`CLAUDE_CONFIG_DIR` and `CODEX_HOME`). For the host's owner, it writes them into
the host login's homes. A guest is refused. A manifest, `.solus-profile.json`
in each seat home, lists the copied files, so the next copy removes the files
it no longer holds. `AgentProfileManager` (`execution/seats/agent-profile.ts`)
owns these files.

Before it changes a file, the host refuses the whole copy if:

- a path is outside the entries above, or is in the copy twice;
- a path is both a file and a folder;
- a file is larger than 1 MB, or all files are larger than 16 MB, after decoding;
- a path in the seat goes through a link, because a write or a removal there
  would change a file outside the seat.

The manifest is written last. If a write fails after the copy starts, the host
reports the file, and some files can be new and some old. Copy again to finish.
