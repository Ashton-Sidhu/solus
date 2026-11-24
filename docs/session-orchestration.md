# Session orchestration

One session can start other sessions, send them messages, stop them, and hear
back from them. A parent session that coordinates a task can see everything
that happened in it. One module on the host owns these flows: the session
orchestrator in `packages/server/src/execution/orchestration/`.

## What the user sees

- **A card for each other session.** When an agent calls `start_sessions` or
  `send_session`, a card appears in its conversation for each session before
  that session can answer. One `start_sessions` call that starts seven
  sessions makes seven cards. The card shows each message and its reply. On a reload, every
  client rebuilds the same card from the transcript.
- **Several sessions are one card.** When one turn talks to more than one
  session, their cards fold behind one header: the providers' avatars, "7
  agents", a status line such as "3 working · 1 waiting · 3 done", and the
  time. Opening it lists one row per session. A session that waits on a person
  opens the group, so its request is not hidden. The `start_sessions`,
  `send_session` and `stop_session` calls themselves show only when they fail;
  the card shows what they did. Desktop, web, and mobile show the same group.
- **Requests come to the card.** When the other session needs a person — a
  question, a plan that holds its turn open, or a permission — the request shows on the card
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
- **A report as soon as the child's turn ends.** Its first line is metadata (message,
  session, task, provider, requested model, executed model, status, duration).
  The executed model is the model the provider reported running for the root
  agent: Claude's main-thread assistant messages (a sub-agent's are skipped, and
  a dated id the model list does not know loses its date), or Codex's
  `model/rerouted`. When it differs from the requested model, the next line is
  `Requested model X; the provider reported running Y.` Then the outputs, one
  line each, and the child's last message.
- Reports and notices that arrive while the parent is busy merge into its queued prompt. An idle parent can act on a report while other children still work. Nothing is
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

Each result starts a follow-up turn or waits in the caller's existing queue. A bounded wait returns a report once; a
wait timeout leaves the work and async reporting active.

Each request has its own exchange ID. When A asks B for work and B asks C to
review it, the host links B's request to the specific A-to-B exchange. It does
not link all work in B's session. Unrelated requests and `report=false` messages
can finish independently.

B can be running, waiting for its children, or finished. While B's turn has
ended and a report from C is still to come, B's status is `background`, as for
other work an agent waits on (`docs/background-work.md`). Every client sees
that wait. C's report wakes B. Ending B's provider turn while C is open does
not finish A's request. C's report carries A's
exchange ID into B's follow-up. B must read the result and complete that turn
before A receives B's final result. Queued child reports also keep the parent
request open. Reported requests to an ancestor are refused to prevent a cycle;
use `report=false` for an ordinary update to an ancestor.

`start_sessions` and `send_session` accept an optional `request_id`. A retry
with the same ID and the same work returns the original exchange. For
`start_sessions`, each session in the list gets the key `<request_id>#<place in
the list>`, so a retry returns every session the first call started. Different
work with the same ID is refused. The key belongs to the calling session and
is kept for thirty days after a closed request. Use a new key for each review
round. The wait duration can change on a retry.

To run `start_sessions` children in parallel, put every session in one call.
The sessions start together, and a wait covers all of them. Separate calls may
run one after another. Use `independent: true` for an independent conversation.
Give each child the full brief, choose its checkout before starting it, and
inspect its result before reporting completion. Each session in the call has
its own provider, model, host, workspace, permission mode, and reports.
Children also get completion rules in their system instructions.

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

## Delegation in any session

The agent does small or tightly coupled work itself. It delegates when the user
asks or when independent parts benefit from running in parallel. A child can
delegate when its brief asks for it.

For foreground work on the same provider, the agent uses a native subagent if
the native tool supports the model and the child needs no extra settings. It
uses `start_sessions` for background work, a separate worktree, another
provider, settings the native tool cannot apply, or an explicit request for
`start_sessions`. It can also use `start_sessions` when the native tool is
unavailable.

The parent checks `list_agent_targets` before its first `start_sessions`
delegation. A child inherits the parent's provider, model, and reasoning
effort by default. If a requested model or setting is unavailable, the agent
reports the problem and asks before choosing a substitute.

In Settings → Sessions → Delegation, you can set a default worker model and
add instructions for delegation. When you set a worker model, the agent uses
`start_sessions` and omits the provider and model fields to apply your choice.
You can override that choice for specific work. Both Claude and Codex receive
these settings in runs that have `start_sessions`.

You can also set a fallback model there, on desktop, web, and mobile. With no
fallback model, nothing changes. When an agent starts a session with
`start_sessions` and gives neither `agent_provider` nor `model_id`, the session
gets its default: the worker model, else the model of the agent that starts it.
If the provider of that default is out of usage, the session uses the fallback
model. These rules apply:

- A provider is out of usage on the host when one of its usage windows is at
  100% and its reset is in the future, or when a rate limit from it holds a
  session of the same person on the host now, until its reset. A provider can
  refuse turns below 100% (a Claude weekly limit at 95%), so the held limit
  also counts.
- For a member who uses their own provider seat, only the held limits of their
  own sessions count. The host keeps no usage numbers of a member's seat for
  this check, and the limits of one person never move the sessions of another.
- The fallback is used only when it is on another provider, that provider and
  model are available on the host, and that provider is not out of usage too.
  Otherwise the session keeps its default.
- A session that names `agent_provider` or `model_id` never changes. A session
  on another host keeps its default, because this host does not know the usage
  of the other host.
- The composer and automations do not use the fallback model.

The `start_sessions` result says when a session uses the fallback model: the
model, the provider that is out of usage, and its reset time when it is known.

## Stopping child work

When the user stops a parent, Solus also stops each session the parent started
that still does work for it: a message from the parent to that child is still
open. The stop goes down the tree, so the children of a stopped child stop too.
A child that finished its parent's work is not stopped, also when it runs again
for the user or another session. A host stop (an accepted plan) and an agent's
`stop_session` stop only the session they name.

## Agent tools

| Tool | Does |
| --- | --- |
| `start_sessions` | Starts 1 to 10 durable sessions at once, on either provider. Each entry in `sessions` has its own settings: `prompt`, and optional `title`, `independent`, `agent_provider`, `model_id`, `reasoning_effort`, `permission_mode`, `host`, `cwd`, `isolation`, `worktree_base_branch`, `report`, and attachments. So one call can start a Codex implementer in its own worktree and a Claude reviewer in plan mode. Only two fields belong to the call: `wait_seconds` (up to 600, for all sessions at once) and `request_id`. Every entry is checked before any session starts, so one bad entry starts none. By default each session is a child: reports default on, the parent waits for reported child work, and Stop reaches its active children. With `independent: true`, a session is an independent conversation: reports default off, and it does not hold its caller open or belong to the caller's stop tree. A started session joins no task; a session that works on a task links it with `link` and `kind: 'task'`. `isolation` selects a shared checkout or a new worktree for each session. The default worker model applies to a child with neither a provider nor a model, and the fallback model replaces that default while its provider is out of usage. Otherwise, models inherit on the same provider, and another provider uses its default model. Permission mode can be inherited or narrowed. |
| `send_session` | Sends a message to a session: `queue` (default), `steer`, or `restart`. `restart` stops the turn in progress and then queues the message; it runs after the messages already in the queue, and the sender's earlier messages to that session settle with no report, as with `stop_session`. `agent_provider`, `model_id`, and `reasoning_effort` run the message on that provider and model, checked as `start_sessions` checks them; a field left out keeps the session's own value. Another provider hands the session off with its context when the message starts, as the person's provider picker does (plans/021); on a rate-limited session this drops the prompt the limit holds. A message to a new fork starts the fork from its source thread at the fork point. `release_rate_limit` releases a rate-limit hold ([Rate-limit decisions](rate-limits.md)). Same `report` and `wait_seconds`. Reaches a session the sender started on another host (see below). `attachments` (also on each `start_sessions` entry) takes up to 8 files on this host (10 MB each). When the message is sent, each file is uploaded to the attachment store of the host that runs the session, with the same upload code a client uses, in one folder per message. The session reads the file as it was when sent. PNG, JPEG, GIF and WebP go as image refs that the provider sees. Other files go as `[Attached file: <path>]` lines before the text. Every client shows both kinds as chips. |
| `stop_session` | Stops the turn in progress. The queued messages stay, and the next one starts when the turn ends. |
| `fork_session` | Does what **Fork from this response** and **Merge back** do for a person ([Session actions](session-actions.md), [Project panel](project-panel.md)). `fork`: copies a session (default: the calling session) through `point_id` (default: its latest completed response) into a new session with the same setup. No turn runs; the result gives the new session's id and link, and `send_session` starts work in it. `merge_back`: brings the findings of a fork's completed turns (default: the calling session is the fork) to the session it was forked from. When that source is the calling session, the result gives the findings. Otherwise they go to the source as a queued message with no report. The tool acts for the person the calling session works for: a fork needs permission to start a session on the host. Sessions on this host only. |
| `read_session_exchange` | Reads the caller's saved request state, report delivery state, and result by `exchange_id`. Reading does not consume a report or resume held work. |
| `read_session` | A session's status, task, pending input and timeline, in T3 Code's thread-read model. Every item has a fixed `position` and an `itemId`; a tool call and its result are one item, and rows inside a subagent are not on the timeline. `view` `messages` (default) gives the user and assistant messages and plans; `activity` gives every item, with tool input and output, reasoning and notices. A read starts at the beginning; `after_position=nextPosition` reads on. `limit` (default 50, at most 100) and `max_chars_per_item` (default 20,000, at most 50,000) keep a read small; a value over the bound reads the bound. A cut item continues with `item_id` and `text_offset=nextTextOffset`. The result is JSON. Beside the requested `model`, `executedModel` names the model the provider reported running for the session's latest report, when one did. |
| `read_task` + `read_session` | Read the task for its linked session IDs, then read a session for its status, pending input and history. |
| `queue_session` | Manages the messages queued in a session (default: the calling session), as a person does from the queue above the input bar: `list` (each with its `queue_id`, `revision`, and why it waits, such as a rate limit and its reset time), `read`, `edit` (its attachments stay), `cancel`, `move`, `steer` (into the turn in progress), and `resume` (held messages). A change needs the `revision` that `list` gave; a message that changed or started since is refused. It acts for the person the calling session works for, so only a message's author steers it. Sessions on this host only. |
| `list_sessions` | Lists the person's sessions, newest activity first, as the session list shows them: the calling session's project, every project with `all_projects`, or the sessions one session started with `parent_session_id`. Each row has the live status (for example `rate_limited`), provider, and model. Paged with `cursor`. |
| `organize_session` | Settles, snoozes, archives, marks unread, or renames (`title`; empty clears it) a session in the person's list. A rename goes through the same path as a person's rename and records the agent in the activity. |
| `search_sessions` | Search past conversations by title, branch, pull request and what was said. Every word must be somewhere in the session (docs/plans/unified-search.md). Each result names the `item id` of the matched message, which `read_session` opens with `item_id`. A Claude history row has no provider id, so its item id is its role and time (`assistant@<ms>`). |
| `list_agent_targets` | Providers and models this host can run, and the other hosts it can start sessions on. With `host`, what that host offers. |

### Who an agent's tool acts for

A session tool acts for the person that the calling turn works for, with the
same access that person has from a client. A tool that reads a session (`read_session`,
`search_sessions`) reads only a session that the person may open. A tool that
changes a session's record (`organize_session`, `list_sessions`, the link tools)
goes through the Solus API operations, which check the same rules as the HTTP
API. A command to this host's runtime is checked against the RPC that a person's
client sends for it, for the same session (`assertToolMay`):

| Tool | Checked as |
| --- | --- |
| `start_sessions` (on this host) | `createHeadlessSession` |
| `send_session` | `promptHeadlessSession`; with `restart`, also `stopSession`; with `release_rate_limit`, also `rateLimitDecision` |
| `stop_session` | `stopSession` |
| `queue_session` | `sessionQueue` to list or read, `sessionQueueChange` to change |
| `fork_session` | `forkSessionFromResponse` on the source; a merge back, `promptHeadlessSession` on the source |
| `organize_session` rename | `setSessionTitle` |

A guest's turn thus acts only on the session its link shares. The host's own
work, which runs for no person, may do every command, as it may read every
session (plans/031 rule 1). A session on another host is checked by that host.

### Sessions on another host

`start_sessions` can take `host`: a host id or name from `list_agent_targets`.
The session starts on that host as if the owner started it there. The other
host shows "Started by an agent on <host>" at the top of the session, on every
client. This host reaches the other host in one of two ways:

- **Paired host.** In Settings → Hosts → this host → Access, under Paired hosts, enter the
  other host's address and the code from its Pair a device. This host then
  holds a pairing token for it, like a paired phone. The token lasts 30 days
  and renews while it is used. Before each connection, this host checks that
  the address still answers as the paired host. The other host lists this one
  under Devices with access; revoke it there to end the pairing. Pairing needs
  no Solus account. A managed host cannot be paired.
- **Solus account.** On the desktop app while it is signed in to the owner's
  Solus account, every other host in the account that is not paired. The
  app's sign-in gets a five-minute token for that host at each connection. When
  the app signs out, this way ends at once; paired hosts stay.

A paired host always uses its pairing, even when it is also in the account.

The parent gets the same card, notices, wait and report as for a local child.
`stop_session` stops it there. `send_session` reaches a session this session
started there: host B gets the message through `promptHeadlessSession` and runs
it with the session's own stored settings. The sender's follow ignores host B's
events until host B echoes the message (its `user_message` carries the exchange
id as `clientPromptId`), so the reply is from the turn that answers it, not from
a turn that was running when it came. A queued message that host B drops (a Stop
drains the queue) settles as interrupted. Attachments go to host B first,
through `attachUpload`, and the prompt names the paths on host B. In this version `task` must
be `none`, `cwd` is a path on the other host (default: a new chat folder there),
`list_agent_targets` with `host` lists that host's projects so an agent can
pass one as `cwd`. After a restart of this host, an
open request to another host is reported as interrupted.

`read_session` reads a session that is not on this host. It asks the turn's
person's other hosts (the same reach as `start_sessions`) and the Solus APIs of
their organizations at the same time. A host that has the session wins over an
API, because the host has the provider transcript with its tools and the API has
only the stored text. The result names where the session was found and links to
it there. The task and the pending input of a remote session are not shown. The design is in
`docs/plans/cross-host-sessions.md`.

## Queue and provider changes

A provider pick in the composer changes nothing on the host. The provider
changes when you send (`plans/021-provider-switch-on-send.md`). Each prompt
carries its provider and model. The host compares that provider with the
thread provider (the provider of the session's active provider thread):

- Same provider: the prompt continues the thread. A model change inside one
  provider is not a handoff.
- Another provider, session idle: the host hands the session off, then runs
  the prompt on the new provider with the handoff seed.
- Another provider, session busy: the prompt queues and never steers into the
  current turn. The handoff happens when that prompt starts. A prompt queued
  before it keeps its own provider.
- Another provider, session rate-limited: the prompt that the limit holds is
  abandoned, the limit card clears, and the prompt runs after the handoff.

Each handoff records one `agent_switched` activity. Its `provider` is the new
thread provider and `fromProvider` the old one. Clients read the thread
provider from it. A session that has a provisional handoff from an older
client continues it: a prompt on the provisional provider starts it, and a
prompt on the provider it left takes the old thread back.

The host saves accepted queue entries before it confirms them. Prompts keep
their provider in the queue. Older clients can still queue a provider switch
(`sessionQueueChange` with `kind: 'switch'`) or call `switchSessionAgent`.
Both are deprecated and stay for one release. A queued switch applies in queue
order, and a prompt queued after it takes its provider. The current turn keeps
its provider and model options.

Desktop, web, and mobile expose Send now, Edit, Remove, and Resume. Send now
shows only when the running turn can take a steer. The clients do not reorder
the queue; the host `move` mutation stays for agents and older clients.
Edits have a separate draft, so the main composer's text and files stay intact.
Save checks the entry revision. If another client changed or started the entry,
the host refuses the edit and the draft remains available. If the entry leaves
the queue while its edit is open, the edit ends. A changed edit with text goes
back to the composer when the composer is empty; otherwise a notice says that
the edit was discarded. A changed attachment counts as a change.

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

How to orchestrate is described once, in `start_sessions`' description, next to
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

See [Agent delegation](plans/agent-delegation.md) for the ownership boundary and retained Solus features.
