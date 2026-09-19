# Completion toasts

When a background turn finishes, the toast shows **Turn finished** and the
session name. It uses the custom title, slug, or first prompt, in that order.
If session metadata is absent, it uses the project folder name. Long names
are shortened to fit a mobile toast. Remote sessions also show the host name.

**Open session** opens the conversation on its host and restores input focus.
The shared notification path applies to desktop, web, and mobile, for Claude
and Codex. Focused sessions and recovered entries do not produce new toasts.

The toast channel and the **Turn finished** event are both switches in
Settings → Notifications; see `docs/notifications.md`.
