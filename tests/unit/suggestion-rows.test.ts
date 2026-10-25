import { describe, expect, test } from 'bun:test'
import type { SessionSuggestion } from '@solus/contracts/session-suggestions'
import { suggestionRows } from '@solus/client-core/suggestion-rows'

// docs/plans/custom-roles.md §7: who sees which suggestion, and who may act on it.

const suggestion = (id: string, state: SessionSuggestion['state'], isMine: boolean): SessionSuggestion => ({
  id, sessionId: 's1', authorName: 'Maya', isMine, text: id, attachments: [], state, createdAt: 0,
  ...(state === 'sent' ? { decidedByName: 'Alice' } : {}),
})

describe('suggestion rows', () => {
  test('someone who may prompt can send or dismiss each waiting one, and does not see closed ones that are not theirs', () => {
    const rows = suggestionRows([suggestion('a', 'waiting', false), suggestion('b', 'sent', false)], true)
    expect(rows.map((row) => [row.suggestion.id, row.canDecide, row.canWithdraw])).toEqual([['a', true, false]])
  })

  test('an author who may only suggest can withdraw a waiting one, and sees what became of the last few of their own', () => {
    const own = ['1', '2', '3', '4'].map((id) => suggestion(id, 'dismissed', true))
    const rows = suggestionRows([...own, suggestion('w', 'waiting', true)], false)
    expect(rows.map((row) => row.suggestion.id)).toEqual(['2', '3', '4', 'w'])
    expect(rows.at(-1)).toMatchObject({ canDecide: false, canWithdraw: true, caption: 'Waiting for someone who can prompt to send it' })
    expect(suggestionRows([suggestion('s', 'sent', true)], false)[0]?.caption).toBe('Sent by Alice')
  })
})
