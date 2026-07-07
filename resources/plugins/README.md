# Bundled plugins

Each immediate subdirectory here is a plugin/skill that ships with the app.

On startup these are linked into `~/.solus/plugins` (alongside the rest of
Solus's config) so local edits can be tested immediately. Packaged builds copy
them instead because the Claude Code and Codex CLIs — separate processes that
can't read inside `app.asar` — need a real filesystem path. Each plugin
directory is then passed to every agent invocation: to Claude Code via the SDK
`plugins` option and to Codex via a `--skills <path>` flag per plugin.

Drop a plugin directory next to this file to bundle it. Files (like this README)
are ignored — only directories are treated as plugins.
