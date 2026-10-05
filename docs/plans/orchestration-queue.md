# Durable session queue and handoffs

## Scope

One host-owned queue contains prompts and provider switches. Clients project
the same state through typed RPC and session events. This change keeps the
existing session runtime, adapters, lineage, and orchestration exchange model.
It does not add provider accounts, forks, merge-back, or durable child-result
recovery.

`continueSessionsAfterHostRestart` defaults to true on personal and self-hosted
hosts. Managed cloud hosts always expose and persist false. This is the policy
for restart continuation. The current user queue still restores held for
explicit Resume.

## Restart continuation

The execution host retains its latest eligible run in the host-local SQLite
`session_restart_runs` table, before provider launch. The receipt records the
native conversation, effective model options, permission mode, task, and author.
Tool names identify work that stopped; tool inputs and provider callbacks are
not retained. Provider initialization updates the native conversation id.

One runtime owns the receipt store. It loads the receipts once and keeps an
in-memory snapshot. Live events do not query SQLite. Changed receipts are saved
synchronously; duplicate native initialization, tool events, status changes,
and removals cause no write. A tracked tool adds one write when it starts and
one when it finishes. Recovery remains durable without a delayed flush.
Disabled hosts perform no receipt SQL during ordinary turns; startup still
loads and removes any receipts left from an earlier enabled run.

Startup recovery runs after seats and tools are wired. It claims continuation
delivery in SQLite, saves a continuation at the front of the durable queue,
then starts a new native turn. The existing user queue stays held. A source
queue receipt is replaced by its continuation, so Resume does not repeat the
original prompt. A crash during uncertain delivery produces held work with a
history warning rather than another automatic send.

Normal completion and explicit Stop remove the receipt. New prompts invalidate
pending recovery. Settled sessions, changed provider lineage, changed host
ownership, and missing native conversation ids do not continue automatically.
Setup or native resume failures remain in the queue for review.

Recovery covers Local sessions run for the host or its owner, including an owner
connected remotely to a personal or self-hosted host. Organization and guest
authority are not restored. Automations, watch probes, and delegated child
sessions keep their own lifecycle and do not receive automatic continuations.
The next root turn receives a notice about active tools or children that stopped.

Closing a client or losing its connection does not invoke recovery. A managed
cloud host disables it. This is same-host recovery with the host database and
provider history intact; it does not move work to a replacement host or restore
an operating-system process.

## Ownership

- `SessionRequestQueue` owns order, revisions, prompt edits, provider rebinding,
  and execution receipts. `SessionQueueStore` writes atomic per-session files.
- `SessionRuntime` owns admission, seats, live provider handles, steering, and
  handoff application. It claims an entry before provider work starts and
  settles the receipt afterward.
- `SessionPermissionStore` retains user-authorized permission modes.
  `HandoffCarryStore` retains only public text from incomplete turns.
- The shared client queue controller owns RPC commands and stale refresh
  checks. A queue editor has a separate draft. The native mobile client uses
  the same contracts and command rules.

## Dispatch

1. Validate and save a prompt or provider switch; preserve its author.
2. Publish the authoritative queue projection.
3. Wait for the current provider turn and earlier entries.
4. Save a started receipt before delivery.
5. For a switch, check the bounded handoff and apply the existing lineage change.
6. Deliver the next prompt with the selected provider and its saved options.
7. Remove a settled receipt. Hold failed setup or handoff work with its error.

Restored receipts and pending entries are always held. Explicit Resume binds
only the caller's entries to their fresh authorization. No token, seat, tool
closure, permission grant, or callback is restored from disk. A started receipt
is uncertain, so Resume can repeat work; the client states this before the user
resumes it.

Queue commands require a current revision. Moving an entry invalidates order
revisions. Steering reserves the entry while the provider answers. A failed
steer leaves the prompt queued; an accepted steer removes it. A provider switch
reserves its queue position before the asynchronous seat check.

## Handoff budget

The budget is the smaller of the host history limit and the incoming context
window after reserves. Required messages remain whole. Earlier history uses
term matches and recency, and delivery restores source order. A rejected
handoff keeps the switch and later prompts held. The prompt being sent is a
separate payload and is never shortened.

## Provider decision

Ordered switches support Claude Code and Codex. OpenCode retains its existing
idle switch path; queued switching is explicitly unavailable. Native provider
children retain the provider's own permission handling. Solus-delegated child
sessions inherit a saved parent policy and cannot enlarge it.

## Verification

Focused tests cover restart receipts, FIFO switches, revision conflicts,
preserved files and reference context, busy-turn safety, handoff bounds and
source labels, partial public replies, and child permission policies. Client
logic tests cover native queue drafts and remembered model options. Interactive
client verification is a separate pass under the repository's development
safety rules.

`SessionRuntime` remains a large pre-existing file. This change extracts queue
state and persistence; it does not split unrelated runtime responsibilities.
