# Wire Payload Budget — frame compression and tool result projection

**Goal:** cut the bytes a remote client must pull to open and follow a session,
without changing what any surface can show. Two independent causes: nothing on
the wire is compressed, and a tool result crosses the wire in full even though
the transcript draws a summary built from the tool's *input*.

The governing rule for the second half, which is also a contract cleanup:

> **A tool call ships what it did — name, args, status. Never what it printed.**

**Status: proposed.** Nothing implemented. WP0 gates WP3 and WP4.

---

## What is true today

### One transport carries everything

The desktop renderer is not a special case. `solus:local-connection` hands the
renderer a port and a token (`src/preload/index.ts:385`) and it connects to the
local server over the same Socket.IO transport a phone uses
(`src/renderer/main.ts:47`). Electron IPC is reserved for native shell concerns.
`clientEvents.register` is called in one place
(`src/main/transports/websocket.ts:120`) — every host event and every RPC
acknowledgement, local or remote, is a Socket.IO frame.

Convenient (one chokepoint) and also the main risk: a change made for a phone on
hotel wifi lands on the desktop loopback connection too.

### Nothing is compressed

`grep -ri "compress|gzip|deflate|permessage"` over `src/main`, `src/preload`, and
`client/src` returns no hits.

- **Socket.IO frames.** `new Server(http, {...})` at
  `src/main/transports/websocket.ts:53` does not set `perMessageDeflate`.
  Engine.IO v4+ defaults it off.
- **Static assets.** `serveStatic({ root })` at `src/main/server/http.ts:274`
  serves the web client bundle uncompressed. This is the mobile cold-start cost,
  paid before first paint.

### `tool_result.content` conflates two unrelated things

One field carries both:

1. **Tool output** — what a Bash, Read, or Grep call printed.
2. **A subagent's answer** — the deliverable `SubagentReport` renders as prose
   with headings and sections.

They share a field only because the provider models a subagent as a tool. That
accident is the root of both the wire cost and the awkwardness downstream: every
consumer has to re-derive which one it is holding.

Both providers already mark the difference on the event itself —
`toolUseId === parentToolUseId` means "this is the subagent's own answer":

- Claude — `applyToolResult` keys on exactly this
  (`session-event-reducer.svelte.ts:926`).
- Codex — `codex-event-normalizer.ts:729,745` emit
  `toolUseId: parentToolUseId, parentToolUseId`.

**The server can therefore separate them from the event alone, with no
per-session bookkeeping.**

### What actually consumes the content

| Consumer | Reads |
|---|---|
| `subagent-view.ts:284` `reportText` | the **whole** text — the agent's answer |
| `ToolGroupItem.svelte:98` `failureLine` | first non-empty line of a **failed** tool, capped at 240 chars |
| `tool-trace.ts:18` `subagentTranscriptText` | full output of nested tools — feeds exactly one `CopyButton` (`SubagentPane.svelte:242`) |
| `find.ts:9` | nothing — tool messages are excluded from search |

The visible transcript row is built from `toolInput` via `activity-summary.ts`,
never from the result. For a successful ordinary tool, **no consumer reads the
output at all.**

Nested results do land live: `tool_result` is intercepted at
`session-event-reducer.svelte.ts:124`, *before* the `parentToolUseId` guard at
line 150, so it never reaches `applyChildEvent`. `applyToolResult` handles the
nested case via `list = parent?.subMessages ?? session.messages`.

Two paths carry results, and both need the change:

1. **Live** — `src/main/server/index.ts:322`, the one point where a control-plane
   event becomes `session.eventReceived`.
2. **History** — `loadSession` (`history-handlers.ts:115`) returns up to
   `RESTORED_TRANSCRIPT_LIMIT = 200` messages. For a cold session open on a phone
   this is likely the larger of the two.

### Precedent

ADR 0003 already accepted this trade for diffs: render the normal patch, fetch
full file contents only when a reader expands. Record this as an ADR when it
lands.

---

## Vocabulary

Locked before implementation.

- **tool output** — what a tool printed. Never shipped.
- **subagent report** — a subagent's answer. Always shipped whole. Not tool
  output, despite arriving in the same provider field.
- **error head** — the bounded head of a failed tool's output, carried as part of
  status.
- **result projection** — the server-side step that applies the rule. Verb:
  *project*.
- **frame compression** — deflate on Socket.IO frames. Distinct from **asset
  compression** on static HTTP responses.

Do not introduce "slimming", "pruning", "digest", or "payload projection".

---

## WP0 — Measure first

**Gates WP3 and WP4.** The claim that tool output dominates session bytes is
inference from reading consumers, not a measurement.

Add a debug-only counter behind `isDebugEnabled` at `src/main/server/index.ts:322`
and in the `loadSession` handler: serialized byte size, bucketed by event type and
tool name.

```ts
log.debug('session_event_bytes', { sessionId, eventType, toolName, bytes })
```

Report before writing projection code:

1. total bytes for a typical session open (`loadSession`, 200 messages),
2. total bytes for a typical turn, tool output vs everything else,
3. p50 and p99 size of a single tool output.

If tool output is not the dominant term, WP3 and WP4 are not worth their contract
churn. WP1 and WP2 stand on their own either way.

---

## WP1 — Frame compression

```ts
// src/main/transports/websocket.ts:53
const io = new Server(http, {
  path: '/ws',
  transports: ['websocket'],
  perMessageDeflate: { threshold: 1024 },
  …
})
```

Browsers offer `permessage-deflate` in the handshake automatically — no client
change for web, mobile, or the desktop renderer.

**The loopback question.** The desktop renderer is a WebSocket client on
127.0.0.1, so this spends CPU and a per-connection zlib context on frames that
never touch a network. Socket.IO disabled the extension by default for this
reason.

The lever is per-emit: the extension is negotiated at handshake, but
`socket.compress(false).emit(...)` skips compression for one send.
`attachWebSocketTransport` can classify a connection as loopback from
`socket.handshake.address` and mark its delivery closure. `ClientEventRegistry`
already owns a per-client delivery function (`client-event-registry.ts:12`), so
this lives inside the closure registered at `websocket.ts:120`; the RPC ack path
at `websocket.ts:131` takes the same treatment.

Default to adding the branch — a purely-remote optimization should not tax the
surface developers use all day. WP0's numbers settle it.

**Verification.** Assert the negotiated extension list on a remote-style
connection and its absence on a loopback emit.
`tests/unit/server-hardening.test.ts` already stands up a real server.

**Effort:** low. **Blocked by:** nothing.

---

## WP2 — Asset compression

Add `compress()` to the Hono app in `src/main/server/http.ts`, ahead of the
`serveStatic` fallback at line 274.

Verify rather than assume:

- Hono's `compress` wraps the response in a `CompressionStream`. Confirm it
  composes with `@hono/node-server/serve-static`, which streams — a middleware
  that buffers would undo the streaming the comment at line 269 calls out
  deliberately.
- Confirm it leaves `/artifact` and the byte-range paths alone
  (`src/main/server/byte-range.ts`). Range requests and content encoding interact
  badly.

Scope to the static bundle. The RPC surface does not travel over HTTP.

**Effort:** low. **Risk:** the range-request interaction. **Blocked by:** nothing.

---

## WP3 — Split the contract, project live events

One PR: the contract change and its live producer and consumers move together, or
the tree is broken in between.

### The contract

```ts
// what a tool did — one shape, main thread or nested, Claude or Codex
| { type: 'tool_result'; toolUseId: string; parentToolUseId?: string
    status: 'ok' | 'error'; errorHead?: string; contentBytes: number }

// the agent's answer — a deliverable, not tool output
| { type: 'subagent_report'; toolUseId: string; text: string; isError?: boolean }
```

`tool_result` loses `content` entirely. `errorHead` is capped at 2 KB — an order
of magnitude above the 240-char display cap, so styling can change without a
server change.

`tool_call_update` loses `content` the same way: that is where Codex packs
`aggregatedOutput` (`codex-event-normalizer.ts:597,612`).

### Where projection runs

At `src/main/server/index.ts:322`, before `events.publish(...)`.
`HostEventPublisher.publishToRecipients` builds one event object and hands the
same reference to every recipient (`host-event-publisher.ts:43`), so a per-client
variant would change the fan-out shape.

The rule is a single branch on data already present:

```
toolUseId === parentToolUseId  →  subagent_report, text kept whole
otherwise                      →  tool_result, output dropped, errorHead when failed
```

No server state. This is the whole reason the split is worth doing: an earlier
draft of this plan needed a per-session set of `isSubagent` tool ids held in the
control plane, and that state was the only place a bug could hide.

### Renderer consequences

- `applyToolResult` (`session-event-reducer.svelte.ts:924`) stops reading
  `content` and stops needing its
  `event.parentToolUseId === event.toolUseId ? parent : …` trick — the server
  resolved it. It sets status, `errorHead`, and `contentBytes`.
- A new `subagent_report` case sets the report on the launcher tool.
- **Rename `Message.toolResult` → `Message.report`.** After this change the field
  only ever holds a subagent's answer, so the name no longer describes it
  (`CLAUDE.md`: name meaning, not history). The compiler finds every site —
  `reportText`, `subagent-group.ts:119`, `SubagentTranscript.svelte:53`,
  `ToolGroupItem.svelte:54,98`, `tool-trace.ts`.
- `ToolGroupItem.failureLine` reads `errorHead` instead of slicing content.
- `subagentTranscriptText` writes `Output: (12.4 KB, not shipped)` from
  `contentBytes` in place of the output block.

### The one accepted loss

`subagentTranscriptText` feeds exactly one `CopyButton` — the subagent pane's
"Copy transcript" (`SubagentPane.svelte:242`), on one of its two tabs. That copy
stops carrying nested tools' stdout; it keeps tool name, status, call id, input,
and the byte count. The sibling "Copy report" is untouched, since
`subagent_report` keeps its text whole.

Deliberate. Weighing one clipboard button's completeness against shipping every
tool result to every client on every turn is not close. No hydration RPC —
`contentBytes` tells the button what it is missing, and ADR 0003 is the template
if anyone ever asks for it.

**Effort:** medium. **Blocked by:** WP0.

---

## WP4 — Project history loads

The same rule in `loadSession` (`history-handlers.ts:115`).

The shape differs: in history a result is its own row —
`role: 'tool_result'` with `toolResultForId` and `parentToolUseId`
(`claude-session-helpers.ts:129-134`). The report marker should hold there too,
as `toolResultForId === parentToolUseId`, since `parseJsonlLine` passes both
fields straight through. **Verify against a real transcript before relying on
it** — this is inferred from the live reducer's branch, not observed.

Map report rows to the report field and drop output from the rest.
`session-transcript.ts:138-149` is the client side that consumes these; it
already runs its `tool_result` branch before its `parentToolUseId` branch, so
ordering is not affected.

`loadSessionPreview` (`claude-backend.ts:443`) is already byte-bounded at 16 KB
head plus 8 KB tail — no change.

Because both paths now emit the same shape, the pre-existing divergence between
live and reloaded subagent transcripts closes on its own. That was an open
product question in the previous draft; the split resolves it.

**Effort:** low-to-medium. **Blocked by:** WP3, which owns the contract.

---

## Surfaces

Per the checklist in `CLAUDE.md`:

- **Clients.** Desktop, web, and mobile consume the same events over the same
  transport — the web client mounts `src/renderer` directly
  (`client/vite.config.ts:11`), so all three are covered by construction.
- **Providers.** Claude and Codex both need the rule, and both already carry the
  report marker. Codex additionally packs output into `tool_call_update`.
- **Contracts.** `NormalizedEvent` changes shape: `src/shared/types.ts`, the
  preload bridge, and both transports, declared once.
- **Modes.** No layout, focus, or overlay change. Editor and Pill unaffected.
- **Connection modes.** Desktop-local, desktop-hosted, and standalone remote
  differ for the first time if WP1 takes the loopback branch. That belongs in the
  ADR.
- **Reverse and stale states.** Projection is not user-visible state and has no
  reverse.

## Tests

Each must fail if the business rule changes:

| Test | Encodes |
|---|---|
| `result-projection.test.ts` — `toolUseId === parentToolUseId` becomes `subagent_report` with text intact | `reportText` can still render an agent's answer |
| `result-projection.test.ts` — a nested tool's result ships no output | the actual saving |
| `result-projection.test.ts` — a failed tool carries `errorHead`, capped | the failure line still has input |
| `result-projection.test.ts` — Codex `tool_call_update` ships no `aggregatedOutput` | provider parity |
| `codex-event-normalizer.test.ts` — Codex report marker matches Claude's | the single branch is genuinely provider-agnostic |
| history projection — a report row survives whole, an output row does not | WP4 matches WP3 |
| reattach replay emits projected events | the chokepoint really is one |
| `server-hardening.test.ts` — deflate negotiated remote, skipped loopback | WP1's product decision |

Extend rather than duplicate: `tests/unit/claude-event-normalizer.test.ts`,
`tests/unit/codex-event-normalizer.test.ts`,
`tests/unit/server-hardening.test.ts`,
`tests/unit/server-targeted-events.test.ts`.

## Sequencing

WP0 → WP1 and WP2 in parallel → WP3 → WP4.

One concern per PR. WP1 and WP2 are separate despite both being "compression":
different servers, different risk. WP3 and WP4 are separate because the second
depends on the contract the first establishes.

## Open questions

1. **Loopback opt-out in WP1** — worth the branch, or accept the CPU cost?
   Recommendation: add it. WP0's numbers settle it.
2. **`errorHead` cap** — 2 KB proposed, against a 240-char display cap. Generous
   on purpose so the display rule can move without a server change.
3. **`Message.toolResult` → `Message.report` rename** — in scope for WP3, or a
   follow-up? In scope is cleaner; the compiler does the work.
