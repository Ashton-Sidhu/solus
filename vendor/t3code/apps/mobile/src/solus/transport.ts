import { WsTransport, type WsTransportOptions } from "@solus/client-core/ws-transport";

export function createConversationTransport(options: WsTransportOptions) {
  const transport = new WsTransport(options);
  // Some providers send the final input only on completion. The mobile transcript
  // consumes input updates separately from the execution status.
  transport.events.subscribe("session.eventReceived", ({ sessionId, event }, envelope) => {
    if (event.type !== "tool_call_complete" || !event.toolId || !event.toolInput) return;
    transport.events.receive({
      ...envelope,
      payload: {
        sessionId,
        event: {
          type: "tool_call_update",
          toolId: event.toolId,
          toolInput: event.toolInput,
          parentToolUseId: event.parentToolUseId,
        },
      },
    });
  });
  return transport;
}
