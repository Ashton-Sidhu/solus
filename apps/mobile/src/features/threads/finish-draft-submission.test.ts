import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ text: "First prompt", clear: vi.fn(), cleanup: vi.fn() }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { setParams: (params: object) => ({ type: "SET_PARAMS", payload: { params } }) },
}));
vi.mock("../../state/composerDraftOperations", () => ({ abortComposerDraftOperations: () => {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  clearComposerDraftContent: state.clear,
  getComposerDraftSnapshot: () => ({ text: state.text, attachments: ["local-image"] }),
  scheduleUnusedComposerAttachmentCleanup: state.cleanup,
}));
import { finishDraftSubmission } from "./finish-draft-submission";

it("opens the saved thread, releases its attachments, and preserves text entered during a delayed save", () => {
  const dispatch = vi.fn();
  const blur = vi.fn();
  finishDraftSubmission({ dispatch }, { blur }, "draft", "First prompt", "host", "thread");
  expect(blur).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledWith({
    type: "SET_PARAMS",
    payload: { params: { draft: undefined, environmentId: "host", threadId: "thread" } },
  });
  expect(state.clear).toHaveBeenCalledOnce();
  expect(state.cleanup).toHaveBeenCalledWith(["local-image"]);
  state.text = "A later edit";
  finishDraftSubmission({ dispatch }, { blur }, "draft", "First prompt", "host", "thread");
  expect(state.clear).toHaveBeenCalledTimes(1);
});
