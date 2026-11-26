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

const SUBMITTED_ROW_MAX_FRAMES = 12;

/**
 * Runs `run` one frame after the list has laid out the rows a send added, or after a bounded
 * wait. A keyboard that starts closing before then animates the list toward an end that the
 * new rows then move, and the list corrects itself late in one jump.
 */
export function afterSubmittedRowLands(input: {
  readonly isLaidOut: () => boolean;
  readonly nextFrame: (callback: () => void) => void;
  readonly isCurrent: () => boolean;
  readonly run: () => void;
}) {
  let frames = 0;
  let landed = false;
  const tick = () => {
    if (!input.isCurrent()) return;
    if (landed || frames >= SUBMITTED_ROW_MAX_FRAMES) {
      input.run();
      return;
    }
    landed = input.isLaidOut();
    frames++;
    input.nextFrame(tick);
  };
  input.nextFrame(tick);
}
