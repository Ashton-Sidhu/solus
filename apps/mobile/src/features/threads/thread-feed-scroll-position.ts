export interface ThreadWorkGroupScrollPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
}

export function resolveThreadWorkGroupInitialScroll(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadWorkGroupScrollPosition | undefined,
) {
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  return index >= 0 && position ? { index, viewOffset: -position.offsetWithinRow } : undefined;
}

export function finishThreadFeedSubmission(input: {
  readonly keyboardVisible: boolean;
  readonly animated: boolean;
  readonly blurEditor: () => void;
  readonly dismissKeyboard: () => Promise<void>;
  readonly scrollMessageToEnd:
    | ((options: { animated: boolean; closeKeyboard: boolean }) => Promise<void>)
    | null;
}) {
  if (!input.keyboardVisible) input.blurEditor();
  if (input.scrollMessageToEnd) {
    return input.scrollMessageToEnd({
      animated: input.animated,
      closeKeyboard: input.keyboardVisible,
    });
  }
  if (input.keyboardVisible) return input.dismissKeyboard();
}

export function resolveThreadFeedSubmissionAnchor<AnchorId>(input: {
  readonly currentAnchorMessageId: AnchorId | null;
  readonly submittedMessageId: AnchorId;
  readonly hasStartedTurn: boolean;
  readonly hasUserMessage: boolean;
  readonly queuedMessageCount: number;
  readonly deliveryDeferred: boolean;
}): AnchorId | null {
  // Keeping the first message's anchor holds a short thread in place; a follow-up never anchors.
  if (input.currentAnchorMessageId !== null) {
    return input.currentAnchorMessageId;
  }

  if (input.deliveryDeferred || input.hasStartedTurn || input.hasUserMessage) {
    return null;
  }

  return input.queuedMessageCount > 0 ? null : input.submittedMessageId;
}
