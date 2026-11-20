// Adapted from T3 Code thread-feed-scroll-position.ts and shared/chatList.ts
// at 9a26f217ac (MIT, see UPSTREAM.md).
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

export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

export interface ChatListAnchorOptions {
  readonly anchorOffset?: number;
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  options: ChatListAnchorOptions = {},
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) {
    return undefined;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const itemAnchorId = getAnchorId(item);
    if (itemAnchorId === null) {
      continue;
    }

    return itemAnchorId === anchorId
      ? {
          anchorIndex: index,
          anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
        }
      : undefined;
  }

  return undefined;
}


/** Follow the accepted prompt without moving a reader on a queued follow-up.
 * On iOS, keep first responder until UIKit starts keyboard dismissal. */
export function composerSubmissionBehavior(input: {
  readonly isIOS: boolean;
  readonly keyboardVisible: boolean;
  readonly hasUserMessage: boolean;
  readonly contentReady: boolean;
  readonly anchorsSubmission: boolean;
}) {
  const sendingWithKeyboard = input.isIOS && input.hasUserMessage && input.keyboardVisible;
  const followSubmission = input.contentReady && (sendingWithKeyboard || input.anchorsSubmission);
  return {
    blurEditor: !sendingWithKeyboard,
    dismissKeyboard: sendingWithKeyboard || followSubmission,
    followSubmission,
  };
}
