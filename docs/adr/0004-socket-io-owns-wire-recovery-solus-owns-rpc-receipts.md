# Socket.IO owns wire recovery; Solus owns RPC receipts

Status: accepted

Solus keeps Socket.IO as the browser-to-host transport instead of replacing it with a
second RPC or streaming framework. Socket.IO already owns the generic connection work:
WebSocket framing, acknowledgements, heartbeat detection, reconnect backoff, rooms, and
temporary connection-state recovery. Solus should not reproduce those mechanisms.

The remaining transport code is application policy that Socket.IO deliberately does not
provide. The client keeps an RPC pending across a reconnect, and the server retains a
short-lived response receipt keyed by the stable client-instance and request ids. That
receipt is the idempotency boundary: if the host completed a mutating RPC but its
acknowledgement was lost, retrying returns the same response instead of executing the
mutation twice. Socket.IO documents its default as at-most-once delivery and says that
additional guarantees are application-owned. Its `retries` and `ackTimeout` options can
provide client-to-server at-least-once delivery, but they do not provide exactly-once
execution or a server-side receipt store.

We considered replacing the pending-request lifecycle with Socket.IO's retry queue. It
still requires server deduplication, and its fixed acknowledgement timeout is the wrong
contract for Solus RPCs: some host operations legitimately run much longer than ordinary
control-plane calls. A bounded retry count can reject a live operation; an effectively
unbounded timeout does not detect a lost acknowledgement. The small Solus queue expresses
the actual rule instead: wait without an operation timeout while connected, retry the same
request id after a temporary disconnect, and reject stale requests that were queued during
a later outage.

RSocket is the closest single protocol alternative because it has request/response,
request/stream, keepalive, backpressure, and optional session resumption. We are not
adopting it: the current TypeScript implementation describes its published rewrite as
unstable preview software; resumption is optional and can fail; and moving would replace
the established authentication, event, IPC/WebSocket, and mobile/web contracts rather
than remove a local helper. tRPC and Connect provide typed RPC and streaming APIs, but do
not supply the lost-ack idempotency receipt semantics either.

Artifact delivery is intentionally separate from RPC events. It uses Node's
backpressured `createReadStream` and HTTP byte ranges so browsers, media elements, and
Electron can use standard HTTP behavior. Hono's Node `serveStatic` helper handles ranges,
but it performs synchronous filesystem stats and assumes a static root. Solus must first
authorize and canonicalize a path against dynamically configured project roots, so using
that helper would either reintroduce event-loop blocking or weaken the path boundary.

## Consequences

- Keep Socket.IO's connection-state recovery enabled and treat `socket.recovered` as an
  optimization, never as a guarantee that durable renderer state is current.
- Keep response receipts narrow and bounded: in-flight work is never evicted, settled
  responses have count, byte, entry-size, and TTL limits, and all client caches share a
  transport-wide admission budget.
- Do not add a generic transport abstraction over Socket.IO. A replacement is justified
  only if it removes the receipt policy while preserving long-running RPCs, authentication,
  direct-client events, remote web/mobile operation, and failed-recovery resynchronization.
- Keep large binary/file payloads off the RPC socket. Standard HTTP streaming and range
  requests own that lifecycle.

## Amendment (2026-08-14, dispatch-client step 3)

Reconnect *scheduling* moved out of Socket.IO: the client dials with
`reconnection: false`, and the host supervisor
(`src/client-core/host-supervisor.ts`) is the sole retry owner — the same
backoff curve, owned one layer up, so the wake taxonomy and per-host phase
can exist. Socket.IO keeps everything else this ADR gave it: connection-state
recovery, acks, and heartbeats all ride the one long-lived `Socket`, which
the supervisor redials rather than replaces. Solus's RPC receipts are
unchanged.

## References

- <https://socket.io/docs/v4/delivery-guarantees/>
- <https://socket.io/docs/v4/connection-state-recovery>
- <https://socket.io/docs/v4/client-options/#retries>
- <https://rsocket.io/about/protocol/>
- <https://github.com/rsocket/rsocket-js>

