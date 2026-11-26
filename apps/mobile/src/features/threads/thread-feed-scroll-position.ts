export interface ThreadWorkGroupScrollPosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
}

export function threadOpeningBottomInset(
  composerInset: number,
  composerKeyboardTranslation: number,
): number {
  "worklet";
  // Match KeyboardAwareLegendList's visible inset during the handoff.
  return composerInset + Math.max(0, -composerKeyboardTranslation);
}

export function resolveThreadWorkGroupInitialScroll(
  rows: ReadonlyArray<{ readonly id: string }>,
  position: ThreadWorkGroupScrollPosition | undefined,
) {
  const index = position ? rows.findIndex((row) => row.id === position.rowId) : -1;
  return index >= 0 && position ? { index, viewOffset: -position.offsetWithinRow } : undefined;
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

/** Keep the list at its reading position until the new row and keyboard insets settle. */
export async function finishThreadFeedGlide(input: {
  readonly afterPaint: () => Promise<void>;
  readonly isCurrent: () => boolean;
  readonly dismissKeyboard?: (() => Promise<void>) | undefined;
  readonly scrollToEnd: () => Promise<void>;
}) {
  await input.afterPaint();
  if (!input.isCurrent()) return;
  await input.dismissKeyboard?.();
  if (input.isCurrent()) await input.scrollToEnd();
}
