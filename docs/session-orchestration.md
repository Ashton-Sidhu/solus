# Session orchestration

One session can start other sessions, send them messages, stop them, and hear
back from them. A parent session that coordinates a task can see everything
that happened in it. One module on the host owns these flows: the session
orchestrator in `packages/server/src/execution/orchestration/`.

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
- **Restarts.** The host saves requests, results, and report delivery. Queued
  work stays held until its author resumes it. An uncertain running request
  ends as interrupted. A saved result remains readable and its pending report
  is recovered. Cards show the saved state on desktop, web, and mobile.

## Continuing after a host restart

The host also continues eligible Local root sessions after a restart by default.
It starts a new turn in the saved provider conversation, with the saved model
options and permission mode. This works on personal and self-hosted hosts,
including when the owner uses a remote client. Managed cloud hosts disable it.
Set `continueSessionsAfterHostRestart` to false to opt out.

Queued user prompts remain held for Resume. Explicit Stop, newer prompts, and
settlement cancel pending recovery. Uncertain delivery or a failed native resume
stays held with an error; check history before resuming it. Recovery does not
restore a stopped process or automatically restart delegated children. Closing
or disconnecting a client leaves remote work running and does not invoke recovery.

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
- **One report per turn.** When one turn of the child answers several
  messages from the same parent (a steer joined the turn), the parent gets one
  report. It names the other messages (`also=`), and each of their cards
  settles from it.
- **Nothing carries full content.** A plan, a work, a diff or a transcript is
  named by id; the parent reads it with `read_plan`, `read_work` or
  `read_session`. The reply is cut at 1,200 characters and points to the saved exchange.
  Read its full reply with `read_session_exchange` and `reply_offset=0`, then
  continue with `next_reply_offset` until it is null. Each page is at most
  6,000 UTF-16 code units. The card keeps the whole reply while the host is live; a report lists at most 20 outputs, and a
  merged prompt keeps 10 items whole. A child that answers another session is
  asked to reply in at most five short lines and to put detail in a task
  comment or a work. The limits are
  `ORCHESTRATION_LIMITS` in `packages/contracts/src/session-exchange.ts`.

## Async and nested requests

`wait_seconds=0` and `report=true` are the defaults. The calling agent can end
its turn while another agent works. Session creation returns an accepted
exchange before provider startup finishes. Its `pending:` ID names the card,
not a provider conversation. Use `read_session_exchange` to get the provider
session ID once it initializes. Retrying with the same `request_id` returns
the same exchange during startup. Startup failures settle that exchange and
reach the parent through the normal report path. A wait budget includes startup
and does not cancel the child when it expires.

The result starts a follow-up turn or
waits in the caller's existing queue. A bounded wait returns a report once; a
wait timeout leaves the work and async reporting active.

Each request has its own exchange ID. When A asks B for work and B asks C to
review it, the host links B's request to the specific A-to-B exchange. It does
not link all work in B's session. Unrelated requests and `report=false` messages
can finish independently.

B can be running, waiting for its children, or finished. Ending B's provider
turn while C is open does not finish A's request. C's report carries A's
exchange ID into B's follow-up. B must read the result and complete that turn
before A receives B's final result. Queued child reports also keep the parent
request open. Reported requests to an ancestor are refused to prevent a cycle;
use `report=false` for an ordinary update to an ancestor.

`start_session` and `send_session` accept an optional `request_id`. A retry
with the same ID and the same work returns the original exchange. Different
work with the same ID is refused. The key belongs to the calling session and
is kept for thirty days after a closed request. Use a new key for each review
round. The wait duration can change on a retry.

Use provider-native agents for work the current provider can run with the
needed model. Use Solus sessions for another provider or model, or for durable
work that must remain visible across turns. Give each worker the full brief,
choose its checkout before starting it, and inspect its result before reporting
completion. Critical guidance is loaded with `start_session`; workers also get
these completion rules in their system instruction.

Both providers receive shared orchestration guidance when session tools are
available. Claude receives it in its system prompt append. Codex receives it
with the user's instructions in the thread developer message on start, resume,
and fork. It stays outside collaboration-mode text, which a native mode prompt
can replace. Model selection uses the host catalog, including same-provider
models that native subagent tools may not support.

Claude can defer MCP tool descriptions until tool search; `alwaysLoad` keeps
critical tool guidance visible. Codex uses `deferLoading` for ordinary dynamic
tools and keeps `alwaysLoad` tools available immediately. Tool loading does not change report delivery:
both providers use the same host exchanges, notices, and reports. Native
subagents use their provider's own result delivery.

## The lead session

A task can have one **lead**: the session the task is talked to through
(`docs/plans/task-conversation.md`). Selecting the task opens the lead's
conversation with the task page beside it; the lead reads the prompt, starts
workers as attempts on the same task with `start_session`, hears their reports,
and answers. Its link on `task_session_links` has role `lead`; a task refuses a
second one, and only a session started as lead is lead. Workers are ordinary
`working` attempts.

The lead's task packet ends with the **lead contract**: coordinate, do not
implement beyond very small edits, start workers with the full brief and
`report` on, answer from reports and `read_task_sessions` rather than by reading
transcripts or source, keep replies short, write durable summaries into the
task, and call `read_task_sessions` first when the user writes, but not after
reports. After a restart, that first read helps the lead catch up. Saved queues remain
held, and uncertain running requests end as interrupted.

A lead is woken as rarely as possible, because each wake reads its whole thread
again. Its reports are held until the last message it waits on settles, and
then reach it as one prompt, so it tells the user once that the work is done.
Notices never reach a lead's model: the person answers on the card, and a rate
limit resumes on its own. Stopping the lead drops the reports held for it.

The lead is a parent in the orchestration layer's sense. A parent is not always
a lead: any session that starts another is its parent.

## Agent tools

| Tool | Does |
| --- | --- |
| `start_session` | Starts a session. `task` is required: `attempt` (another session on `task_id`, or on the caller's own task when `task_id` is omitted) or `none` (a session with no task). A task holds its sessions directly; Solus has no subtasks. `report` (default on) asks for notices and the report. `wait_seconds` (up to 600) waits in the call. `host` starts it on another of the owner's hosts (see below). |
| `send_session` | Sends a message to a session: `queue` (default) or `steer`. Same `report` and `wait_seconds`. |
| `stop_session` | Stops a session and clears its queue. |
| `read_session_exchange` | Reads the caller's saved request state, report delivery state, and result by `exchange_id`. Reading does not consume a report or resume held work. |
| `read_session` | A session's status, task and messages. `since` returns only what came after a cursor. |
| `read_task_sessions` | The task view: the task and every session working on it — whoever started it — with its status, what it waits on, its last message and its outputs. It reads durable records, so it works after a restart. |
| `search_sessions` | Search past conversations by title, branch, pull request and what was said. Every word must be somewhere in the session (docs/plans/unified-search.md). |
| `list_agent_targets` | Providers and models this host can run, and the other hosts it can start sessions on. With `host`, what that host offers. |

### Sessions on another host

On a host signed in to the owner's Solus account (the desktop app),
`start_session` can take `host`: a host id or name from `list_agent_targets`.
The session starts on that host as if the owner started it there. This host
gets a short-lived token for that host from the owner's account, which checks
that the owner may use it. The other host shows "Started by an agent on
<host>" at the top of the session, on every client.

The parent gets the same card, notices, wait and report as for a local child.
`stop_session` stops it there. In this version `task` must be `none`, `cwd` is
a path on the other host (default: a new chat folder there), and `send_session`
and `read_session` do not reach another host. After a restart of this host, an
open request to another host is reported as interrupted. The design is in
`docs/plans/cross-host-sessions.md`.

## Queue and provider changes

The host saves accepted queue entries before it confirms them. Prompts and
provider switches use one ordered queue. For example, a switch to Codex, a
prompt, and a switch to Claude run in that order after the current turn ends.
Moving or removing a switch changes the provider of the prompts after it.
The current turn keeps its provider and model options.

Desktop, web, and mobile expose Edit, Remove, Up, Down, Steer now, and Resume.
Edits have a separate draft, so the main composer's text and files stay intact.
Save checks the entry revision. If another client changed or started the entry,
the host refuses the edit and the draft remains available.

After a host restart, all saved entries are held. A started entry also shows
that its result is uncertain. Each author resumes their own work with a fresh
authorization check; the host owner resumes anonymous host work. Later entries
cannot pass a held entry. Agent tools cannot resume held work.

A cross-provider handoff still uses a file on the host. It contains visible
user and assistant history with source provider, session, turn, item, and time
labels. It keeps the first request and latest turn intact, then selects earlier
items by matching terms in the next prompt, with recent history as the tie
breaker. It keeps the original message order. Omitted history can be read with
`read_session`.

The host's `handoffHistoryTokens` setting sets the history budget (default
16,000). `read_config` and `update_config` expose it. The incoming model window
can reduce that budget: Solus reserves space for the complete new prompt and
system context. The estimate uses UTF-8 byte length, not a provider tokenizer.
Required history that exceeds the budget causes a held error before the
provider changes. Private reasoning, tool state, child output, and historical
attachment data are excluded. Public text from failed or interrupted turns is
saved separately and carried if the native history lacks it.

## Child permissions

A delegated session inherits its parent's permission mode. It can use a
clearly stricter mode. Auto and Accept edits are separate policies; a child
cannot switch between them to gain access. A parent in Plan mode can start
only a Plan child. The host saves the policy so unattended follow-ups keep it
after the provider process exits or the host restarts. A user can grant more
access through the normal permission controls.

With `wait_seconds`, a report that arrives in time is the call's result and is
not queued again; a notice ends the wait at once; when the time runs out the
call returns and the session keeps going.

How to orchestrate is described once, in `start_session`'s description, next to
the capability (the rule in `agents/system-hint.ts`). A turn that answers
another session's message is asked, in its system prompt, to end with a summary
of what it did, what it produced and what is still open.

## Architecture

The change uses three focused parts:

- The run ledger saves host-local execution receipts in the host SQLite file
  (`run_exchanges`, beside `run_queue` and `runs`; see
  `docs/plans/orchestration-queue.md`). One row contains the result, its
  complete reply, the bounded model report, and the delivery state. It stores
  no provider callbacks or permission grants. `read_session_exchange` pages
  through the complete reply, also after a restart.
- `ExchangeLedger` owns request identity, saved state, and child relationships.
  It owns every state change: it writes the changed record first and changes
  memory only when the write succeeds. Active receipts and undelivered reports
  remain available. Closed receipts are removed after thirty days when the host
  loads them.
- `ParentDelivery` merges reports for a busy caller. Queue entries save both the
  report IDs and the incoming request IDs for the completion follow-up. Their
  text, IDs, and the reports' delivery state change in one transaction. A
  submission that fails on a known transient error is retried a bounded number
  of times while the host runs.

The provider adapters still run turns. `SessionRuntime` carries the IDs and
calls the orchestration hooks when a report is accepted, removed, or settled.
The orchestration layer alone decides when a request is complete. The existing
shared RPC contract carries the saved state to all clients.

At startup, recovery reattaches reports already present in a saved queue. It
resubmits pending reports that have no queue receipt, and interrupts uncertain
provider work. It does not automatically repeat provider execution or resume
held queue entries. Report acceptance means the runtime accepted its turn;
it does not prove that the model read or acted on the result. A crash in that
interval can leave a held, uncertain turn that the author must inspect.


- **The control plane runs turns.** A focused session request queue owns ordered
  entries and crash receipts, backed by the run ledger in host SQLite. The runtime keeps provider
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
  message to it. A second answer is refused. Blocking questions cannot be
  answered after their turn ends. A Codex async question stays open after its
  turn ends; its answer starts a new turn or steers an active one. The host
  saves the accepted answer and rebuilds one Q&A row from the provider reply
  when history loads. The delivery message does not appear as a user bubble.
  Older single-question replies can be recovered from their saved question and
  confirmed delivery state; ambiguous older replies remain plain text.
  Codex question ids name the app-server that asked, so two seats never share
  one.
- **Rate limits.** A run that answers another session's message always waits in
  its queue for the reset, never on a decision in the child's tab, where nobody
  is looking.
