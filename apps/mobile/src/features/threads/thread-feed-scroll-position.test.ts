import { describe, expect, it, vi } from "vite-plus/test";
import {
  finishThreadFeedSubmission,
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
} from "./thread-feed-scroll-position";

describe("finishThreadFeedSubmission", () => {
  const setup = () => ({
    scope: new AbortController().signal,
    keyboardVisible: true,
    blurEditor: vi.fn(),
    dismissKeyboard: vi.fn(async () => {}),
    scrollToEnd: vi.fn(async () => {}),
  });

  it("lets the closing viewport reveal the follow-up before checking whether to scroll", async () => {
    const commands = setup();
    const keyboard = Promise.withResolvers<void>();
    commands.dismissKeyboard.mockReturnValueOnce(keyboard.promise);
    const finished = finishThreadFeedSubmission(commands);
    expect(commands.dismissKeyboard).toHaveBeenCalledOnce();
    expect(commands.scrollToEnd).not.toHaveBeenCalled();
    keyboard.resolve();
    await finished;
    expect(commands.scrollToEnd).toHaveBeenCalledOnce();
    expect(commands.blurEditor).not.toHaveBeenCalled();
  });

  it("dismisses the keyboard once when the first prompt lands in a draft", async () => {
    const commands = setup();
    await finishThreadFeedSubmission({ ...commands, scrollToEnd: null });
    expect(commands.dismissKeyboard).toHaveBeenCalledOnce();
    expect(commands.scrollToEnd).not.toHaveBeenCalled();
    expect(commands.blurEditor).not.toHaveBeenCalled();
  });

  it("blurs a hardware keyboard's input and follows without dismissing a soft keyboard", async () => {
    const commands = setup();
    await finishThreadFeedSubmission({ ...commands, keyboardVisible: false });
    expect(commands.blurEditor).toHaveBeenCalledOnce();
    expect(commands.scrollToEnd).toHaveBeenCalledOnce();
    expect(commands.dismissKeyboard).not.toHaveBeenCalled();
  });

  it("does not scroll a different conversation after the keyboard closes", async () => {
    const commands = setup();
    const scope = new AbortController();
    const keyboard = Promise.withResolvers<void>();
    commands.dismissKeyboard.mockReturnValueOnce(keyboard.promise);
    const finished = finishThreadFeedSubmission({ ...commands, scope: scope.signal });
    scope.abort();
    keyboard.resolve();
    await finished;
    expect(commands.scrollToEnd).not.toHaveBeenCalled();
  });
});

describe("tool-group scroll restoration", () => {
  const position = {
    rowId: "read-output",
    offsetWithinRow: 80,
    scrollOffset: 600,
  };

  it("restores the visible row and its detail offset rather than stale absolute pixels", () => {
    const before = [{ id: "first" }, { id: "read-output" }, { id: "last" }];
    const after = [{ id: "older" }, ...before];
    expect(resolveThreadWorkGroupInitialScroll(before, position)).toEqual({
      index: 1,
      viewOffset: -80,
    });
    expect(resolveThreadWorkGroupInitialScroll(after, position)).toEqual({
      index: 2,
      viewOffset: -80,
    });
  });
});

describe("resolveThreadFeedSubmissionAnchor", () => {
  it("keeps an offline first message at the end", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "offline-first",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
        deliveryDeferred: true,
      }),
    ).toBeNull();
  });

  it("anchors the first user message in a thread", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "first-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        deliveryDeferred: false,
        queuedMessageCount: 0,
      }),
    ).toBe("first-message");
  });

  it("preserves the first-message anchor when another message is queued", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        deliveryDeferred: false,
        queuedMessageCount: 1,
      }),
    ).toBe("first-message");
  });

  it("keeps the first message's anchor, not the follow-up's, after a user message appears", () => {
    const followUp = {
      submittedMessageId: "second-message",
      hasStartedTurn: true,
      hasUserMessage: true,
      deliveryDeferred: false,
      queuedMessageCount: 0,
    };
    expect(
      resolveThreadFeedSubmissionAnchor({ ...followUp, currentAnchorMessageId: "first-message" }),
    ).toBe("first-message");
    expect(
      resolveThreadFeedSubmissionAnchor({ ...followUp, currentAnchorMessageId: null }),
    ).toBeNull();
  });

  // regression: #7897 stop pushing follow-up messages to the top
  it("does not anchor a thread that has already started a turn", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "second-message",
        hasStartedTurn: true,
        hasUserMessage: false,
        deliveryDeferred: false,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });
});
