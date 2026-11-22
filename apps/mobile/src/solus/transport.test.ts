import { expect, it } from "vite-plus/test";
import type { WireNormalizedEvent } from "@solus/contracts/types";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { createConversationTransport } from "./transport";

it("shows tool input that arrives on completion in the live session", () => {
  const transport = createConversationTransport({
    serverUrl: "https://host.invalid",
  });
  const transcript = new TranscriptModel("session");
  transport.events.subscribe("session.eventReceived", ({ sessionId, event }) => {
    if (sessionId === transcript.sessionId) transcript.apply(event);
  });
  function receive(sessionId: string, event: WireNormalizedEvent) {
    transport.events.receive({
      type: "session.eventReceived",
      occurredAt: 1,
      payload: { sessionId, event },
    });
  }
  receive("session", { type: "tool_call", index: 0, toolId: "read", toolName: "Read" });
  receive("other", { type: "tool_call_complete", index: 0, toolId: "read", toolInput: "other" });
  const itemId = transcript.order[0]!;
  expect(transcript.items.get(itemId)).toMatchObject({ input: null, status: "running" });
  receive("session", {
    type: "tool_call_complete",
    index: 0,
    toolId: "read",
    toolInput: "current",
  });
  expect(transcript.items.get(itemId)).toMatchObject({ input: "current", status: "running" });
  receive("session", { type: "tool_result", toolUseId: "read", status: "ok", contentBytes: 0 });
  expect(transcript.items.get(itemId)).toMatchObject({ input: "current", status: "completed" });
  expect(transcript.order).toHaveLength(1);
  transport.destroy();
});
