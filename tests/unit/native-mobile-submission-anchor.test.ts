import { describe, expect, test } from 'bun:test'
import { resolveThreadFeedSubmissionAnchor, resolveChatListAnchoredEndSpace, CHAT_LIST_ANCHOR_OFFSET } from '../../apps/mobile/src/features/threads/thread-feed-scroll-position'

const firstSend = {
  currentAnchorMessageId: null, submittedMessageId: 'first-prompt', hasStartedTurn: false,
  hasUserMessage: false, queuedMessageCount: 0, deliveryDeferred: false,
}

describe('T3 first-prompt scroll anchor', () => {
  test('the first prompt stays anchored as the reply grows and work rows arrive', () => {
    const anchor = resolveThreadFeedSubmissionAnchor(firstSend)
    expect(anchor).toBe('first-prompt')
    const prompt = { id: 'first-prompt', message: true }
    const locate = (row: { id: string; message: boolean }) => row.message ? row.id : null
    const options = { anchorOffset: 76 + CHAT_LIST_ANCHOR_OFFSET }
    const before = resolveChatListAnchoredEndSpace([prompt], anchor, locate, options)
    const after = resolveChatListAnchoredEndSpace([prompt, { id: 'work', message: false }, { id: 'reply', message: true }], anchor, locate, options)
    expect(before).toEqual({ anchorIndex: 0, anchorOffset: 92 })
    expect(after).toEqual(before)
  })

  test('a follow-up keeps the first anchor instead of moving the conversation again', () => {
    expect(resolveThreadFeedSubmissionAnchor({ ...firstSend, currentAnchorMessageId: 'first-prompt', submittedMessageId: 'follow-up', hasStartedTurn: true, hasUserMessage: true })).toBe('first-prompt')
  })

  test('an existing, queued, or offline conversation does not gain a first-prompt anchor', () => {
    for (const change of [{ hasStartedTurn: true }, { hasUserMessage: true }, { queuedMessageCount: 1 }, { deliveryDeferred: true }]) {
      expect(resolveThreadFeedSubmissionAnchor({ ...firstSend, ...change })).toBeNull()
    }
  })

  test('history before the anchored prompt releases the initial short-thread spacing', () => {
    expect(resolveChatListAnchoredEndSpace(['older-prompt', 'first-prompt'], 'first-prompt', id => id)).toBeUndefined()
    expect(resolveChatListAnchoredEndSpace(['first-prompt'], null, id => id)).toBeUndefined()
  })
})
