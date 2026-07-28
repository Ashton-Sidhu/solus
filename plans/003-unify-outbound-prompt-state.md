# Plan 003: Replace pending-steer text matching with a correlated outbox

> **Executor instructions**: Execute in order, keeping the app buildable after
> each step. Run every verification command. Update `plans/README.md` on
> completion.
>
> **Drift check (run first)**:
> `git diff --stat de80040..HEAD -- src/shared/types.ts src/main/control-plane.ts src/main/server/handlers/session-handlers.ts src/preload/index.ts src/renderer/contexts/workspace src/renderer/components/conversation src/renderer/components/input/InputBar.svelte tests/unit/session-event-card-stream.test.ts tests/unit/control-plane-device-tabs.test.ts`
> These files were dirty at plan creation; stop if the pending-steer protocol no
> longer matches the current-state description.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/002-simplify-steering-contract.md`
- **Category**: bug, tech-debt
- **Planned at**: commit `de80040`, 2026-07-27

## Why this matters

The renderer currently stores steering prompts separately from queued prompts,
matches acknowledgements by visible text, and renders a pending steer using the
queue boolean. This loses file/reference presentation, makes identical prompts
ambiguous, and spreads one outbound-prompt lifecycle across four large files.
A client-generated identifier allows one optimistic record to move through
sending, steered, queued, and failed states without duplication.

## Current state

- `src/shared/types.ts:1135-1142` defines `PendingSteerPrompt` with `localId`,
  `text`, and images—nearly the same data as `QueuedPromptSnapshot`.
- `workspace.context.svelte.ts:1281-1297` inserts `pendingSteers` only while the
  local status is `running`.
- `session-event-reducer.svelte.ts:419-447` settles pending state from either
  `user_message` or `prompt_queued`.
- `session-event-reducer.svelte.ts:878-883` matches the oldest prompt whose text
  equals the event text.
- `ConversationView.svelte:1003-1017` maps pending images into attachments and
  passes `queued`.
- `UserMessageBubble.svelte:118` consequently emits
  `data-delivery="queue"` for pending steering.
- `SolusAPI.prompt` and the session handler return `void`, even though
  `ControlPlane.runTurn` knows `started | steered | queued`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Reducer steering test | `bun test tests/unit/session-event-card-stream.test.ts -t "steer"` | all matched tests pass |
| Control-plane steering test | `bun test tests/unit/control-plane-device-tabs.test.ts -t "steer"` | all matched tests pass |
| Provider tests | `bun test tests/unit/claude-steering.test.ts tests/unit/codex-steering.test.ts` | all pass |
| Build | `bun run build` | exit 0 |

## Suggested executor toolkit

- Use `make-interfaces-feel-better` if available when changing pending/queued
  presentation. Preserve the existing 40px+ send-button target and exact
  transition properties.

## Scope

**In scope**

- `src/shared/types.ts`
- `src/main/control-plane.ts`
- `src/main/server/handlers/session-handlers.ts`
- Renderer-facing API typing/implementation in `src/preload/index.ts` and the
  existing client-core RPC surface if required
- `src/renderer/contexts/workspace/session.factories.ts`
- `src/renderer/contexts/workspace/workspace.context.svelte.ts`
- `src/renderer/contexts/workspace/session-event-reducer.svelte.ts`
- `src/renderer/components/conversation/ConversationView.svelte`
- `src/renderer/components/conversation/UserMessageBubble.svelte`
- `src/renderer/components/input/InputBar.svelte` only if send return handling
  belongs there
- Focused steering tests

**Out of scope**

- Persisting optimistic/failed prompts across app restart
- Redesigning historical transcript storage
- Restyling normal sent-message bubbles
- General queue cancellation refactoring

## Git workflow

- Suggested branch: `advisor/003-outbound-prompt-state`
- Commit message example: `refactor: correlate outbound prompt delivery`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Define the correlated protocol

Add a `clientPromptId` generated once in the renderer for interactive sends.
Carry it through `PromptOptions`, `user_message`, and `prompt_queued`. Define a
single renderer outbox record with:

- client prompt ID;
- visible text;
- complete presentation attachments/references needed by the bubble;
- state such as `sending | steered | queued | failed`;
- optional server `queueId`.

Keep `QueuedPromptSnapshot` for authoritative server queue hydration if needed,
but normalize it to the same conversation presentation model. Do not persist
the live outbox.

**Verify**:
the build succeeds after type propagation.

### Step 2: Return the dispatch outcome to the sender

Change `submitPrompt`, the session handler, and `SolusAPI.prompt` to return a
small result containing the canonical disposition and any queue identifier
needed by the renderer. Events still fan out to sibling tabs; the RPC result
settles the submitting tab without status/source-specific echo tricks.

If returning `queueId` requires changing `SessionRunLifecycle`, do so directly
rather than finding it later by text.

**Verify**:
control-plane filtered steering tests pass.

### Step 3: Use one optimistic record for every interactive send

In `WorkspaceContext.sendMessage`, add one outbox entry before RPC dispatch for
idle, steering, and explicit queue sends. On the result/event:

- `steered` or `started`: move the record into committed `messages` exactly
  once, or mark it committed if messages directly render the state;
- `queued`: keep the same record and attach its server queue ID;
- failure: retain a visible failed/retryable record or restore its full content
  to the composer. Do not silently clear it.

Remove `PendingSteerPrompt`, `pendingSteers`, and `settlePendingSteer(text)`.
Never correlate by visible prompt text.

**Verify**:
`rg -n "pendingSteers|PendingSteerPrompt|settlePendingSteer" src` returns no
matches.

### Step 4: Give pending and queued states distinct presentation

Replace `queued: boolean` with a narrow delivery/presentation state on
`UserMessageBubble`, unless normal committed messages need no prop. Pending
steering should say or expose “Steering…”; queued prompts should retain queue
semantics and cancellation. Preserve current visuals unless a small distinction
is needed; no broad restyle.

Make attachment conversion happen once in a colocated conversation/input
helper if the same image-to-message mapping remains at two or more importers.

**Verify**:
DOM/component tests assert pending steering is not labeled as queue and queued
prompts retain their cancel control.

### Step 5: Cover races and identity

Add tests for:

- two simultaneous prompts with identical text but different images;
- accepted steer;
- refused steer becoming queued without a duplicate bubble;
- explicit queue;
- RPC/provider failure retaining or restoring the prompt;
- sibling tab receives one committed event but no sender-local duplication;
- file, plan, work, and session reference presentation survives steering.

Use `session-event-card-stream.test.ts` as the reducer test style and
`control-plane-device-tabs.test.ts` for multi-tab routing.

## Test plan

The tests above encode the business intent: one user action creates one visible
prompt throughout its delivery lifecycle, regardless of text duplication,
transport latency, or fallback to queue.

## Done criteria

- [ ] Every interactive send has a stable `clientPromptId`.
- [ ] No acknowledgement is matched by prompt text.
- [ ] `pendingSteers` and `PendingSteerPrompt` are deleted.
- [ ] Accepted, queued, and failed outcomes preserve one visible prompt.
- [ ] Full presentation attachments/references survive steering.
- [ ] Pending steering is not rendered as `data-delivery="queue"`.
- [ ] Focused reducer/control-plane/provider tests pass.
- [ ] `bun run build` passes.
- [ ] `plans/README.md` status is updated.

## STOP conditions

- RPC response serialization cannot return the disposition without a protocol
  version change affecting external clients. Report the compatibility boundary.
- Historical/persisted messages would need a migration.
- Completing correlation requires changing unrelated automation or task-run
  transcript formats. Interactive sends may carry IDs while background sends
  omit them.

## Maintenance notes

Keep delivery state client-local except for server queue identity. Historical
transcripts should record the user message, not transient “sending” UI state.

