# ADR 0005: Publish typed host events to explicit clients

**Status:** Accepted

## Context

Host-to-client facts were previously spread across `RPC_TOPICS`, server event-emitter methods, preload `onFoo` callbacks, per-topic Socket.IO wiring, demo callbacks, and renderer subscriptions. That made events difficult to discover and made recipient policy unclear. It also allowed native shell signals and high-volume streams to become accidental app-wide broadcasts.

[ADR 0004](./0004-socket-io-owns-wire-recovery-solus-owns-rpc-receipts.md) already assigns temporary wire recovery to Socket.IO and RPC deduplication to Solus. This decision keeps that boundary.

## Decision

- `src/shared/host-events.ts` is the canonical event catalog. It owns names, payload types, semantic category, recovery policy, and descriptions.
- Every wire event uses one `{ type, payload, occurredAt }` envelope on the single Socket.IO `host-event` message.
- `HostEventPublisher.publish` accepts one concrete client ID or a readonly list of concrete client IDs.
- `HostEventPublisher.broadcast` explicitly targets every currently routable client.
- Stable client IDs are mapped to transport delivery endpoints by `ClientEventRegistry`; socket IDs and rooms remain transport-internal.
- Each `ServerConnection` owns one `HostEventSubscriber`. RPC APIs contain commands and queries only.
- Domain mutation owners raise internal typed signals after successful writes; the composition root adapts those facts to host events.
- Durable state is reconciled by its renderer store and remains recoverable through authoritative RPC queries.
- Run logs use domain-specific retain/release RPCs and publish only to the concrete client IDs watching that run.
- Native window and OS theme signals stay on platform-local APIs and never cross the host event transport.

## Consequences

- Adding a normal event changes the shared catalog, its publisher, its owning store, and focused tests. It does not change preload event callbacks or transport topic mappings.
- Recipient selection is visible and searchable at publication sites.
- Broadcast is best-effort delivery to routable clients, not durable offline queuing.
- Socket.IO recovery may replay missed envelopes. A fresh connection still requires stores to reload or streams to retain and backfill.
- There is no backwards-compatibility adapter for `RPC_TOPICS`, `SolusServer.broadcast/sendTo/sendTargeted`, or `SolusAPI.onFoo` event methods.
