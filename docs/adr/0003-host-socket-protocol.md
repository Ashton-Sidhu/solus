# 0003 — A plain WebSocket between clients and hosts

Status: accepted (2026-10-31)

## Context

Clients reached a host over Socket.IO. A dial cost the WebSocket upgrade, the
Engine.IO open packet, and then the Socket.IO CONNECT and its acknowledgement
before the host was ready. Through a tunnel each of these is a relay round trip.
The client library (`socket.io-client` and `engine.io-client`) was also a large
part of the web entry chunk.

## Decision

One plain WebSocket per host on `/ws`, with typed frames declared in
`packages/contracts/src/host-socket.ts`:

- The client sends `hello` first, with the dial's one credential, its client
  instance, the protocol version, and where it was in the event stream
  (`resume`). The host answers `welcome` or `refused` (with a code, then a close).
  So the host is ready one round trip after the socket opens. The client opens
  the socket before its credential is ready and sends `hello` when it is.
- Before `hello`, the client may send only `pong`. Any other frame is refused
  with `PROTOCOL`.
- Admission keeps its rules and their order: the credential decides alone; else
  a tunnel request is refused; else an open bind admits; else a trusted
  requester is admitted; else the socket is refused.
- RPC: `rpc {id, method, args}` and `result {id, result | error}`. The response
  receipts (`ResponseReceiptCache`) still make a resent request run once.
- Events: `event {seq, event}`. The host keeps each client's recent events, so a
  client that dropped and comes back with `resume` gets what it missed
  (`welcome.recovered`) instead of a reload.
- Host requests: `request {id, event, payload}` and `reply {id, payload}`.
- Liveness: the host sends `ping` every 15 s; the client answers `pong`. A side
  that hears nothing for 25 s closes the socket.
- Large text frames: a client that names `frameParts` in its `hello` gets a text
  frame over 16 KiB of UTF-16 units as parts (`splitTextFrame`). A WebSocket
  message arrives whole, and a ping waits behind it, so on a slow link one large
  frame reads as a silent socket. Each part counts as a sign of life, and the client
  answers it with `pong`. A client that does not name the field gets whole frames.
- Browser frames are binary frames: a 4-byte header length, the header JSON, the
  JPEG bytes.

The host uses the `ws` package. Browsers, Electron, React Native, Node, and Bun
use the platform `WebSocket`.

## Consequences

- No socket library in any client. A plain HTTP request to `/ws` gets `426`.
- Reconnect, backoff, and replay are Solus code (`HostSupervisor`, the host's
  event log), not a library's.
