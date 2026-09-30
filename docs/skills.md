# Skills settings

Settings → Skills searches skills.sh and manages global skills on the selected
host. The search field uses the workspace text size and a full-width control.
Install, remove, loading, and error feedback stays on the page; this page does
not use toasts.

The Global skills section lists skills discovered by `skills list -g --json`,
including their source and agent names. Filter by name, source, or agent. Refresh
reloads changes made outside Solus. Opening the page and reconnecting to the host
also reload the list. Mounted Settings pages share one inventory per host.
Global CLI commands run in a temporary directory on the host so the server's
working directory and its npm project settings do not affect skill management.
The temporary directory is removed when each command finishes.

Install adds a registry skill globally to each active provider. Remove requires
an inline confirmation and removes that named global skill from all agents on
the selected host, including agents that are not currently active. Local skill
files may be deleted. Project skills and plugin-bundled skills are outside this
list. Solus checks the inventory after removal because the skills CLI can return
a successful exit code after a partial failure.

On a host that several people use, an organization member manages their own
skills, not the host's. Solus runs the skills CLI with `CLAUDE_CONFIG_DIR` and
`CODEX_HOME` set to the member's seat homes, and `HOME` set to their Claude seat
home, where the CLI keeps its store and lock file. An install copies the files
into each seat (`--copy`), with no links. The member's agent finds the skills
there, and no other person on the host sees them. The page says "your agents"
for a member's list. The host owner manages the host's own skills, as before.
Skills from the member's computer arrive in the same seats through the
[agent profile](agent-profile.md).

Desktop, web, and mobile use the same Settings component and host-addressed RPC
methods (`skillsList`, `skillsRemove`, `skillsSearch`, and `skillsInstall`). The
`skillsManage` capability gates the new controls on older hosts. Claude Code and
Codex use the same global management path. Skill changes refresh server command
caches and the active session's command menu. A running provider may need a new
turn or session before it uses changed skill files.
