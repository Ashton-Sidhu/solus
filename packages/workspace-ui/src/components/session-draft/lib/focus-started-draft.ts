/** A draft's composer unmounts on send. Address its replacement after it mounts. */
export async function focusStartedDraft(
  tabId: string,
  renderComplete: Promise<void>,
  focusedChatTabId: () => string | null,
  requestFocus: (target: { tabId: string }) => void,
): Promise<void> {
  await renderComplete
  // A route change during the handoff must not take focus back from its owner.
  if (focusedChatTabId() === tabId) requestFocus({ tabId })
}
