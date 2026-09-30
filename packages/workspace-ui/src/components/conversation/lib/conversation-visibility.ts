import { getContext, setContext } from 'svelte'

const contextKey = Symbol('conversation-visibility')

/** Whether the conversation a row renders in is on screen. The pool keeps
 *  recent conversations mounted but hidden; their clocks have nothing to
 *  update until the reader comes back. */
export function provideConversationVisibility(isVisible: () => boolean): void {
  setContext(contextKey, isVisible)
}

/** Outside a conversation (a record, a pane of its own) a row is on screen. */
export function conversationIsVisible(): () => boolean {
  return getContext<(() => boolean) | undefined>(contextKey) ?? (() => true)
}
