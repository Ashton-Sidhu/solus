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

Desktop, web, and mobile use the same Settings component and host-addressed RPC
methods (`skillsList`, `skillsRemove`, `skillsSearch`, and `skillsInstall`). The
`skillsManage` capability gates the new controls on older hosts. Claude Code and
Codex use the same global management path. Skill changes refresh server command
caches and the active session's command menu. A running provider may need a new
turn or session before it uses changed skill files.
