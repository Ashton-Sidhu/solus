import { describe, expect, test } from 'bun:test'
import type { Activity } from '@solus/contracts/activity'
import type { Message } from '@solus/contracts/types'
import { activityLine } from '@solus/workspace-ui/components/activity/lib/activity-line'
import { foldWorktreeOfferDecision, worktreeOfferView, type WorktreeOffer } from '@solus/workspace-ui/components/conversation/lib/worktree-offer'

/**
 * The card's state is the host's: the answer arrives as its own activity and
 * folds onto the offer row, so no second row appears and a reload reads the
 * same state as the live client.
 */

const subject = { kind: 'session' as const, id: 'session-1' }
const offer = (): WorktreeOffer => ({ id: 'offer-1', subject, at: 1, by: { kind: 'system' }, kind: 'worktree_offered', path: '/Users/me/repo/.claude/worktrees/feature', branch: 'feature' })
const decided = (resolution: Extract<Activity, { kind: 'worktree_offer_decided' }>['resolution']): Extract<Activity, { kind: 'worktree_offer_decided' }> =>
  ({ id: 'answer-1', subject, at: 2, by: { kind: 'system' }, kind: 'worktree_offer_decided', offerId: 'offer-1', resolution })

function transcript(activity: WorktreeOffer): Message[] {
  return [{ id: 'activity:offer-1', role: 'system', content: '', timestamp: 1, activity }]
}

describe('worktree offer card', () => {
  test('an open offer asks the question with both actions', () => {
    const view = worktreeOfferView(offer())
    expect(view).toMatchObject({ title: 'The agent is working in worktree feature', target: '…/worktrees/feature', detail: 'Switch this session to it?', canDecide: true })
  })

  test('the answer folds onto its offer and closes the actions', () => {
    const messages = transcript(offer())
    foldWorktreeOfferDecision(messages, decided({ decision: 'kept' }))
    expect(messages).toHaveLength(1)
    const activity = messages[0]!.activity as WorktreeOffer
    expect(worktreeOfferView(activity)).toMatchObject({ type: 'kept current', canDecide: false })
  })

  test('a failed switch shows the error and keeps the actions for another try', () => {
    const messages = transcript(offer())
    foldWorktreeOfferDecision(messages, decided({ decision: 'failed', error: 'worktree is gone' }))
    const view = worktreeOfferView(messages[0]!.activity as WorktreeOffer)
    expect(view).toMatchObject({ type: 'failed', failed: true, canDecide: true })
    expect(view.detail).toContain('worktree is gone')
  })

  test('an answer to an offer that is not loaded changes nothing', () => {
    const messages = transcript(offer())
    foldWorktreeOfferDecision(messages, { ...decided({ decision: 'switched' }), offerId: 'other' })
    expect((messages[0]!.activity as WorktreeOffer).resolution).toBeUndefined()
  })

  test('feeds that list activity name the offer and the answer in words', () => {
    expect(activityLine(offer(), null).text).toContain('worktree feature')
    expect(activityLine(decided({ decision: 'switched' }), null).text).toContain("switched to the agent's worktree")
  })
})
