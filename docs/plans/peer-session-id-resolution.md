# Peer session ID resolution

`prompt_session` accepts a stable Solus session ID or a provider thread ID.
The host resolves the stored session lineage before it dispatches the prompt.
It uses the stable session ID for the active run and queue, and the active
provider thread ID for a backend resume request.

Completion watchers accept both ID forms for the caller and target. They keep
the target ID supplied by the tool in card updates, so the completion matches
the original exchange. Two different IDs for the same session cannot create
a self-watch.

This applies to Claude and Codex through the shared host control plane, across
desktop, web, mobile, local IPC, and remote connections. No client change is
required. Regression tests cover restart, busy queues, and completion delivery.
