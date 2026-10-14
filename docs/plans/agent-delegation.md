# Agent delegation

Status: implemented, 2026-10-13.

Solus exposes three ways to delegate work. Choose by the required conversation,
workspace, and lifecycle. A different model alone does not require a new session.

| Required behavior | Mechanism |
| --- | --- |
| Work on the current provider with a model the native tool supports | Provider's built-in subagent tool |
| Temporary work on the other provider, returning one final answer | `claude_subagent` or `codex_subagent` |
| A durable conversation, its own worktree, another host, or independent continuation with reports | `start_session` |

The native tool schema defines native model support and context inheritance.
`list_agent_targets` describes the host's Solus launch models; it does not prove
native subagent support. If the native tool or available wrapper cannot support
the requested work, use `start_session`.

Only the available provider wrapper is named in shared runtime guidance. Its
description is loaded before tool selection. Wrapper calls run in the current
working directory with a self-contained prompt. They do not share the parent's
conversation or retain memory between calls. Their answer is the tool result.
Solus session report and exchange rules apply to `start_session` and
`send_session`, not to native or wrapper calls.

## Task mode

Task membership applies when a session was started in task mode, as identified
by its `Working On Task` packet. Task leads start durable worker sessions on the
task. Outside task mode, `start_session` uses `task='none'`; delegation does not
create or attach a task unless the user requests it.

Native and wrapper subagents have no task fields. For a durable session,
`task='attempt'` joins an existing task, using `task_id` or the calling session's
current task. It means task membership, not a retry. `task='none'` must omit
`task_id`. Remote sessions currently use `none` because task links do not cross
hosts. See [cross-host sessions](cross-host-sessions.md).

## Validation and results

Wrappers validate explicit model and reasoning choices against shared model
profiles before dispatch. Unsupported choices are refused with supported
values. An omitted reasoning level uses the selected model's profile default.
The advertised model default is the model the wrapper dispatches.

Failed exits and signals return a failed tool result. Interrupted work is
identified separately. Output from either state is labeled as partial output;
it must not be reported as a completed answer. Empty output from a successful
run remains a successful result.

`start_session` returns field-specific argument errors and rejects conflicting
task fields before dispatch. An accepted session has its session ID from the
start. Provider startup failures remain available through its exchange.

## Verification

Focused tests cover guidance for both providers, available and unavailable
wrappers, task field conflicts, unsupported model and reasoning choices,
profile defaults, failed exits, interruption, startup rejection, and success.
The shared server behavior applies to desktop, web, and mobile connections.
This change does not add client controls or change transport contracts.
