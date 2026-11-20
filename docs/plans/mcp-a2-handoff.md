# MCP A2 handoff: progress, the two call limits, trace context

Phase A2 of `mcp-first-class.md` (§5 and §13). Nothing was pushed. No pull
request was opened.

## Names later phases use

- **Event** `tool_progress` in `NormalizedEvent` (`contracts/src/types.ts`):
  `{ type, toolUseId, progress, total?, message? }`. Live only.
- **Client type** `ToolProgress` and `Message.toolProgress`
  (`contracts/src/types.ts`). Mobile: the tool item's `progress`.
- **View** `toolProgressView(progress)` in `@solus/contracts/tool-progress`:
  `{ message, fraction, percent }` or null. Desktop, web, and mobile read it.
- **Module** `packages/server/src/integrations/call-progress.ts`:
  `CALL_TIMEOUT_MS` (60 s, the silence limit), `CALL_MAX_TOTAL_MS`
  (30 min), `CallLimits` (`start`, `pause`, `progressed`), `ProgressEvents`
  (`report`, `end`; one event each 250 ms, newest wins), `CallClock` and
  `SYSTEM_CALL_CLOCK`. `IntegrationGateway`'s second constructor argument is
  now a `CallClock` (it has `now`).
- **Span kind** `integration_call` (`SPAN_KINDS.integrationCall`), with the
  attributes `mcp.method.name`, `gen_ai.tool.name`, `integration`, and the
  Insights fields `integration`, `tool`, `method`.
- **Trace** `w3cTraceparent(span)` in `execution/observability/tracer.ts`;
  `SessionEmitter.turnContextOf(sessionId, toolUseId?)` answers
  `{ context, dimensions }`; `IntegrationGateway.useTurnContext(...)` is
  installed in `boot-server.ts`. G (MCP tasks) keeps the `traceparent` of
  the call; F1 adds the span for `resources/read` from a tool.

## Gateway edits (for the merge with A3, B1, H1)

Only `callAs` and two new private helpers changed: `startCallSpan`, and the
module functions `callRequest` and `callSpanStatus`. The A3 result mapping
(`mapCallResult`), the B1 transport and session opening, and the H1 app
capture are unchanged. `readAppResource` and `callAppTool` still use the
60 s timeout, now imported from `call-progress.ts`.

## `parentToolUseId()`

It is the id of the tool call's own card in both adapters.

- Claude: Claude Code (SDK 0.3.322 binary) sets
  `_meta["claudecode/toolUseId"]` to the streamed `tool_use` id on each
  `tools/call` (`...ue&&{"claudecode/toolUseId":ue}` with `ue=b.toolUseId`),
  and the card's `toolId` is that block id.
- Codex: the dispatcher receives `callId` of `item/tool/call`. The
  app-server builds the `dynamicToolCall` item's `id` and the request's
  `call_id` from the same core item id (its own test asserts both equal
  `dynamic-1`). The exact construction line was not read verbatim.

## Time limits of the providers

- Claude Code: a server of type `sdk` has no idle timeout; the tool timeout
  default is 100,000,000 ms (`MCP_TOOL_TIMEOUT`, not set by Solus). The upper
  clamp of that value was not read.
- Codex: `dynamic_tools.rs` waits for the client's answer with no timeout;
  the end of a turn cancels pending requests.

## Contradictions corrected in the plan

- The SDK client has no `openTelemetry` option and writes no trace keys
  (§1 item 19, §13).
- The desktop and web reducer settles a Claude card at input end; progress
  reopens it (§1 item 20, §5).
- `turnContextOf` also answers the turn's span dimensions, and the span
  hangs from the tool call's span when it is open (§13).

## Other changes

- `apps/mobile/.../transcript-model.ts` would have passed 1,000 lines. The
  pending-request types moved to `pending-requests.ts`; `transcript-model.ts`
  re-exports them, so no importer changed.

## Not done or not verified

- Mobile was not run: it needs a native build. Its model and the shared
  view have unit tests; `thread-work-log.tsx` was type-checked only.
- Desktop (Electron) was not run. Desktop and web share
  `ToolGroupItem.svelte`; screenshots come from a temporary web harness
  page that mounted that component.
- No real provider turn was run.
- A reconnect replays no `tool_progress`. For Claude, a reconnecting desktop
  or web client sees the card settled (input end) until the next event,
  with the turn's live row still running.
