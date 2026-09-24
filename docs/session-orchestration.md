# Session orchestration

One session can start other sessions, send them messages, stop them, and hear
back from them. A parent session that coordinates a task can see everything
that happened in it. One module on the host owns these flows: the session
orchestrator in `packages/server/src/orchestration/`.

## What the user sees

- **A card for each other session.** When an agent calls `start_session` or
  `send_session`, a card appears in its conversation before the other session
  can answer. The card shows each message and its reply. On a reload, every
  client rebuilds the same card from the transcript.
- **Requests come to the card.** When the other session needs a person — a
  question, a plan to approve, or a permission — the request shows on the card
  with the same question, plan or permission card the other session shows in
  its own tab. Answer it in either place; the first answer wins. Only a person
  answers: an agent never answers or approves for another session.
- **What a session produced.** The card lists the plans and works the other
  session wrote, the files it changed and on which branch, the pull request for
  its branch when one exists, and the sessions it started. Each opens where it
  lives. The card's menu opens the other session's task.
- **Rate limits.** A session parked on its provider's rate limit shows "rate
  limited until 15:40 · resumes on its own". It resumes by itself at the reset.
- **Reports and notices never show as text.** The host writes them into the
  parent's conversation for its model; the card shows their facts instead.
- **Restarts.** Orchestration state is in memory. A host restart ends every open
  message; a card whose reply was lost says so. A parent that delegated to a
  child is told the child's turn ended.

## What the parent's model receives

- **A notice, at once**, when a child waits on the user (a question, a plan, a
  permission) or is rate limited. The notice is short: the question and its
  options, the plan's title and id, the tool's name, or the reset time. If the
  request is answered, or the limit ends, before the parent reads the notice, it
  is taken back out of the parent's queue.
- **A report when the child's turn ends.** Its first line is metadata (message,
  session, task, provider, status, duration). Then the outputs, one line each,
  and the child's last message.
- Everything that waits for a busy parent reaches it as one prompt. Nothing is
  lost while the parent itself is rate limited.
- **Nothing carries full content.** A plan, a work, a diff or a transcript is
  named by id; the parent reads it with `read_plan`, `read_work` or
  `read_session`. The reply is cut at 4,000 characters, a report lists at most
  20 outputs, and a merged prompt keeps 10 items whole. The limits are
  `ORCHESTRATION_LIMITS` in `packages/contracts/src/session-exchange.ts`.

## Agent tools

| Tool | Does |
| --- | --- |
| `start_session` | Starts a session. `task` is required: `subtask` (a new subtask under the caller's root task), `attempt` (another session on `task_id`), or `independent`. `report` (default on) asks for notices and the report. `wait_seconds` (up to 600) waits in the call. |
| `send_session` | Sends a message to a session: `queue` (default) or `steer`. Same `report` and `wait_seconds`. |
| `stop_session` | Stops a session and clears its queue. |
| `read_session` | A session's status, task and messages. `since` returns only what came after a cursor. |
| `read_task_sessions` | The task view: the root task, its subtasks, and every session working on any of them — whoever started it — with its status, what it waits on, its last message and its outputs. It reads durable records, so it works after a restart. |
| `search_sessions` | Full-text search over past conversations. |
| `list_agent_targets` | Providers and models this host can run. |

With `wait_seconds`, a report that arrives in time is the call's result and is
not queued again; a notice ends the wait at once; when the time runs out the
call returns and the session keeps going.

How to orchestrate is described once, in `start_session`'s description, next to
the capability (the rule in `agents/system-hint.ts`). A turn that answers
another session's message is asked, in its system prompt, to end with a summary
of what it did, what it produced and what is still open.

## Architecture

- **The control plane runs turns.** It keeps each session's queue, provider
  handles, steering, stop and rate-limit parking. A run carries the ids of the
  messages it answers and nothing more about them. It reports what happens to a
  run through hooks: queued, started, parked on a rate limit, a request for
  input, an answer, a work or plan produced, settled.
- **The orchestrator owns every message.** `exchange.ts` holds the state
  machine; every change goes through it and is published once as an
  `agent_conversation_update`. Nothing else emits that event.
  `session-outputs.ts` collects what a turn produced. `parent-delivery.ts`
  queues reports and notices into the parent, merges them and takes stale
  notices back. `task-view.ts` builds the task view.
- **One written format.** `packages/contracts/src/session-exchange.ts` writes and
  reads reports, notices and the tag on a tool result. The client rebuilds cards
  with the same codec the host writes with.
- **Answer routing.** Every answer names the session that asked and the
  question. The host refuses it unless that session waits on that question now,
  and unless the caller is that session's own tab or a session with an open
  message to it. A second answer and an answer after the turn ended are refused.
  Codex question ids name the app-server that asked, so two seats never share
  one.
- **Rate limits.** A run that answers another session's message always waits in
  its queue for the reset, never on a decision in the child's tab, where nobody
  is looking.
