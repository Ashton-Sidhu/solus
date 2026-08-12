# Compress remote frames and project tool results

Status: accepted

Solus enables `permessage-deflate` for Socket.IO frames above 1 KB and compresses
the bundled web client over HTTP. A loopback WebSocket handshake removes the
extension offer before negotiation. The desktop renderer therefore uses the
same transport and RPC protocol as remote clients without paying for local zlib
work. Static compression is registered only before the bundled-client fallback;
artifact and byte-range routes stay outside it, and Hono also skips 206
responses.

Session events and history loads apply a result projection before they cross the
host boundary. A tool call ships its name, arguments, status, error head, and
the UTF-8 byte count of omitted output. It never ships what the tool printed. A
subagent report is a different event and keeps the complete answer. Failed tool
output keeps at most a 2 KB error head so the activity row can explain the
failure without transferring the full result.

The provider protocols do not expose one universal report marker. Codex child
turns carry a parent tool id. Claude's persisted blocking Agent results are
top-level rows with no parent id. Provider normalizers therefore mark known
subagent tool results, and history projection correlates a result with the
matching subagent tool row in the loaded window. No projection state is held in
the server between events or sessions.

Some history features previously parsed correlation facts from tool output.
Projection extracts only the structured agent-session id and watcher outcome
needed to rebuild agent-conversation cards. These facts describe what the call
did; the printed output is still discarded. Automation cards resolve from their
tool arguments and durable automation store instead of result text.

## Measurement

A read-only sample of the eight most recent Claude sessions in this project
showed:

- a 146.8 KB median session-open payload,
- a 52.9 KB median tool-using turn, with 42.7% from tool output,
- a 333 B p50 and 20.6 KB p99 single tool output.

This was enough to proceed with projection. Debug builds also emit
`session_event_bytes` and `session_load_bytes` counters at the live and history
wire boundaries so the decision can be checked against later workloads.

## Consequences

- Desktop-local, desktop-hosted, web, and mobile use one wire contract.
- A subagent's Copy report action remains complete.
- Copy transcript keeps tool name, status, call id, input, and omitted byte
  count, but not nested tool stdout.
- Reattach replay passes through the same live projection chokepoint.
- Full tool output has no hydration RPC. A later request for it should follow
  ADR 0003 and load it only on demand.
