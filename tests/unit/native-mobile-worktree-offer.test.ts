import { describe, expect, test } from 'bun:test'
import type { Activity } from '@solus/contracts/activity'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { worktreeOfferText } from '../../apps/mobile/src/features/conversation/lib/worktree-offer'
import { deriveThreadFeedPresentation } from '../../apps/mobile/src/features/threads/thread-feed-presentation'

/**
 * The phone shows the same worktree offer as desktop: the host's offer and its
 * answer are activity, so a reload and a live answer from another client both
 * end on the host's state.
 */

const subject = { kind: 'session' as const, id: 'session-1' }
const offer: Activity = { id: 'offer-1', subject, at: 1, by: { kind: 'system' }, kind: 'worktree_offered', path: '/repo/.claude/worktrees/feature', branch: 'feature' }
const kept: Activity = { id: 'answer-1', subject, at: 2, by: { kind: 'system' }, kind: 'worktree_offer_decided', offerId: 'offer-1', resolution: { decision: 'kept' } }

const page = (activity: Activity[]): SessionHistoryPage => ({
  messages: activity.map((row) => ({ role: 'system', content: '', timestamp: row.at, activity: row })),
  before: null,
})

function offerItem(model: TranscriptModel) {
  const item = [...model.items.values()].find((entry) => entry.kind === 'worktree_offer')
  if (item?.kind !== 'worktree_offer') throw new Error('no worktree offer row')
  return item
}

describe('worktree offers on mobile', () => {
  test('history shows an answered offer with its answer, as one row', () => {
    const model = TranscriptModel.fromHistory('session-1', page([offer, kept]))
    expect(model.order).toEqual(['activity:offer-1'])
    expect(offerItem(model).resolution).toEqual({ decision: 'kept' })
    expect(worktreeOfferText(offerItem(model)).canDecide).toBe(false)
  })

  test('a live offer asks, and a live answer from another client closes it', () => {
    const model = TranscriptModel.fromHistory('session-1', page([]))
    model.apply({ type: 'activity', activity: offer })
    const pending = worktreeOfferText(offerItem(model))
    expect(pending.canDecide).toBe(true)
    expect(pending.title).toContain('feature')
    model.apply({ type: 'activity', activity: { ...kept, resolution: { decision: 'switched' } } })
    expect(offerItem(model).resolution).toEqual({ decision: 'switched' })
    // The same offer again (a replay) does not add a second card.
    model.apply({ type: 'activity', activity: offer })
    expect(model.order).toHaveLength(1)
  })

  test('a failed switch shows its error and can be answered again', () => {
    const model = TranscriptModel.fromHistory('session-1', page([offer]))
    model.setWorktreeOfferResolution('offer-1', { decision: 'failed', error: 'worktree is gone' })
    const text = worktreeOfferText(offerItem(model))
    expect(text).toMatchObject({ failed: true, canDecide: true, detail: 'worktree is gone' })
  })

  test('a finished turn never folds the offer away', () => {
    const rows = deriveThreadFeedPresentation({
      entries: [
        { id: 'u1', kind: 'user' },
        { id: 'a1', kind: 'assistant' },
        { id: 't1', kind: 'tool' },
        { id: 'activity:offer-1', kind: 'worktree_offer' },
        { id: 'a2', kind: 'assistant' },
      ],
      turnActive: false,
      working: false,
      expandedTurnIds: new Set(),
      expandedWorkGroupIds: new Set(),
    })
    expect(rows).toContainEqual({ type: 'worktree-offer', id: 'activity:offer-1' })
  })
})
