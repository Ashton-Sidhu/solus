# Agent delegation

`delegate_task` creates child work. `start_session` creates an independent conversation. Both use the durable session engine. The Claude and Codex wrapper tools are removed; there are no tool aliases.

A child can use the same provider or another provider. Claude can delegate to Codex and Codex can delegate to Claude. The brief is explicit; parent history is not copied. Same-provider children inherit the current model and reasoning effort when no model is specified. A provider change selects that provider's default model. Explicit models and reasoning levels are checked against the target host's catalog.

Delegation defaults to async reports and a shared workspace. `isolation: worktree` binds the child to a separate checkout before its provider starts. Without an explicit base, local work starts from the selected checkout's committed HEAD. Uncommitted edits are not copied. A remote isolated child needs the target host's `cwd` and `worktree_base_branch`.

Local children inherit their parent's existing task. `task_id` selects another existing task; null opts out. Delegation does not create tasks. Remote task membership is not supported. An independent session defaults to no task and no reports; explicit reports do not give it child ownership.

The parent waits for reported child work. Stopping the parent reaches active descendants. Independent starts do not hold the caller open and are excluded from its stop tree. The calling session still supplies authority, organization, seat, and permission limits. A child cannot increase its caller's permission level. Remote starts forward that limit; guest starts remain supervised.

Solus keeps session and exchange IDs, retry receipts, attachments, remote host selection, and user input cards. `send_session` continues the child, with queue or steer delivery. `read_session_exchange` reads a receipt. `stop_session` stops work. Questions, plans, and permission requests stay with the user. A wait timeout does not cancel the child.

This follows T3 Code's split between delegated child work and independent thread launch. Solus uses its existing session and exchange controls instead of a second task-status API. Desktop, web, and mobile show the same child cards, including restored history. Old transcript parsers remain able to read completed wrapper calls; the wrappers cannot be invoked.
