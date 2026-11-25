import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { enqueueHostThreadMessage } from "./enqueue-thread-message";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";

const message = {
  environmentId: EnvironmentId.make("host"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  commandId: CommandId.make("command"),
  text: "next prompt",
  createdAt: "2026-11-24T12:00:00.000Z",
  dispatchMode: "steer" as const,
  attachments: [],
};

it("accepts the T3 message after the local save while host delivery is still pending", async () => {
  let saved = () => {};
  let delivered = () => {};
  const submit: ConversationController["submit"] = vi.fn(() => ({
    messageId: message.messageId,
    saved: new Promise<boolean>((resolve) => { saved = () => resolve(true); }),
    delivered: new Promise<void>((resolve) => { delivered = resolve; }),
  }));
  const done = vi.fn();
  const queued = enqueueHostThreadMessage({ submit }, message, vi.fn());
  expect(queued).not.toBeNull();
  void queued?.then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  saved();
  await queued;
  expect(done).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith("next prompt", expect.objectContaining({
    delivery: "steer",
    pendingMessage: { messageId: "message", commandId: "command", createdAt: message.createdAt },
  }));
  delivered();
});

it("rejects an upload failure before save so the composer can recover", async () => {
  const submit = () => ({
    messageId: message.messageId, saved: Promise.resolve(false), delivered: Promise.resolve(),
  });
  await expect(enqueueHostThreadMessage({ submit }, message, vi.fn())).rejects.toThrow(/attachment/i);
});

it("reports a local command error without clearing the draft", async () => {
  const report = vi.fn();
  const submit = () => ({ messageId: null, delivered: Promise.reject(new Error("command failed")) });
  expect(enqueueHostThreadMessage({ submit }, { ...message, text: "/compact" }, report)).toBeNull();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(new Error("command failed"));
});

it("reports a delivery failure separately after accepting a saved message", async () => {
  const delivery = Promise.withResolvers<void>();
  const report = vi.fn();
  const submit = () => ({
    messageId: message.messageId, saved: Promise.resolve(true), delivered: delivery.promise,
  });
  await expect(enqueueHostThreadMessage({ submit }, message, report)).resolves.toBeUndefined();
  delivery.reject(new Error("host delivery failed"));
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(new Error("host delivery failed")));
});

it("gives a local write failure to the composer once", async () => {
  const saved = Promise.reject<boolean>(new Error("disk full"));
  const report = vi.fn();
  const submit = () => ({
    messageId: message.messageId, saved, delivered: saved.then(() => {}),
  });
  await expect(enqueueHostThreadMessage({ submit }, message, report)).rejects.toThrow("disk full");
  await Promise.resolve();
  expect(report).not.toHaveBeenCalled();
});
