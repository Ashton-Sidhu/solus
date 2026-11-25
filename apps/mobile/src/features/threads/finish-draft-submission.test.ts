import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import type { submittedThreadParams } from "./thread-route-state";

const state = vi.hoisted(() => ({ text: "First prompt", clear: vi.fn(), cleanup: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: {
    setParams: (params: ReturnType<typeof submittedThreadParams>) => ({
      type: "SET_PARAMS",
      payload: { params },
    }),
  },
}));
vi.mock("../../state/composerDraftOperations", () => ({ abortComposerDraftOperations: () => {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  clearComposerDraftContent: state.clear,
  getComposerDraftSnapshot: () => ({ text: state.text, attachments: ["local-image"] }),
  scheduleUnusedComposerAttachmentCleanup: state.cleanup,
}));
import { submitNewTaskDraft } from "./finish-draft-submission";

const message = {
  environmentId: EnvironmentId.make("host"), threadId: ThreadId.make("thread"),
  messageId: MessageId.make("first"), commandId: CommandId.make("send"),
  createdAt: "2026-11-24T00:00:00Z", text: "First prompt", attachments: [],
};

it("waits for the local save before opening the thread and keeps a later edit", async () => {
  const saved = Promise.withResolvers<void>();
  const dispatch = vi.fn();
  const submit = () => submitNewTaskDraft({ dispatch }, "draft", message.text, message, () => saved.promise);
  const first = submit();
  expect(dispatch).not.toHaveBeenCalled();
  expect(state.clear).not.toHaveBeenCalled();
  saved.resolve();
  expect(await first).toBe(message.messageId);
  expect(dispatch).toHaveBeenCalledWith({
    type: "SET_PARAMS",
    payload: { params: { draft: undefined, environmentId: "host", threadId: "thread" } },
  });
  expect(state.clear).toHaveBeenCalledOnce();
  expect(state.cleanup).toHaveBeenCalledWith(["local-image"]);
  state.text = "A later edit";
  await submit();
  expect(state.clear).toHaveBeenCalledTimes(1);
});

it("does not navigate or clear after the account changes or the local save fails", async () => {
  const dispatch = vi.fn();
  state.clear.mockClear();
  expect(await submitNewTaskDraft({ dispatch }, "draft", message.text, message,
    async () => {}, () => false)).toBeNull();
  await expect(submitNewTaskDraft({ dispatch }, "draft", message.text, message,
    async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect(dispatch).not.toHaveBeenCalled();
  expect(state.clear).not.toHaveBeenCalled();
});
