# Agent delegation

`start_sessions` starts 1 to 10 sessions in one call. By default each session is the caller's child. With `independent: true`, each is an independent conversation. All of them use the durable session engine.

One tool, because a child and an independent session differ only in one flag and a few defaults. Two near-identical tools would make the agent choose between them and repeat the same fields in every prompt.

A list, because a lead starts its workers together. Every entry is checked first: its runner, its workspace, and its attachments. One bad entry starts no session, and the error names the entry. Then every session starts at the same time, and `wait_seconds` waits for all of them at once. When one session fails to start after the check, the others still start, and the result says which one failed. A retry key `request_id` becomes `<request_id>#<place in the list>` for each session.

A child can use the same provider or another provider. Claude can start Codex children and Codex can start Claude children. The brief is explicit; parent history is not copied. Same-provider children inherit the current model and reasoning effort when no model is specified. A provider change selects that provider's default model. Explicit models and reasoning levels are checked against the target host's catalog.

Every setting belongs to one session, because a lead often staffs one plan with different kinds of work: a Codex implementer in its own worktree, a Claude reviewer that only plans, a session on another host, a separate conversation. Each entry has its own prompt, title, `independent`, provider, model, reasoning level, permission mode, host, `cwd`, `isolation`, `worktree_base_branch`, `report`, and attachments. An entry that leaves a field out inherits from the caller, not from the other entries. Only `wait_seconds` and `request_id` belong to the call. There are no call-level defaults, so each setting has one place. The catalog of each host is read once for the call, however many sessions run there.

Children default to async reports and a shared workspace. `isolation: worktree` binds each session to a separate checkout before its provider starts. Without an explicit base, local work starts from the selected checkout's committed HEAD. Uncommitted edits are not copied. A remote isolated session needs the target host's `cwd` and `worktree_base_branch`.

A started session joins no task, and `start_sessions` has no `task_id`. A lead is not a role of a task, so its workers are not filed under one. A session that works on a task links itself with `link` and `kind: 'task'`; the link belongs to the task, so the task page lists the session. Starting sessions does not create tasks.

The parent waits for reported child work. Stopping the parent reaches active descendants. Independent sessions do not hold the caller open and are excluded from its stop tree; their reports default off, and explicit reports do not give them child ownership. The calling session still supplies authority, organization, seat, and permission limits. A child cannot increase its caller's permission level. Remote starts forward that limit; guest starts remain supervised.

Solus keeps session and exchange IDs, retry receipts, attachments, remote host selection, and user input cards. `send_session` continues a session, with queue or steer delivery. `read_session_exchange` reads a receipt. `stop_session` stops work. Questions, plans, and permission requests stay with the user. A wait timeout does not cancel the session.

The result has one line for each session, each with its own exchange tag. The tag names the session's place in the list (`item`), so a client rebuilds each card from its own entry on reload. A history row carries one result for each exchange it opened (`agentConversationResults`).

Solus uses its session and exchange controls for children and independent sessions alike, so one tool with one flag is enough. Desktop, web, and mobile show the same cards, including restored history.
