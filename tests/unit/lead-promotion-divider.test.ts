import { describe, expect, test } from 'bun:test'
import { activitySchema, LEAD_PROMOTION_LABEL, type Activity } from '@solus/contracts/activity'
import type { Message } from '@solus/contracts/types'
import { activityLine, dividesThread, showsActivity } from '@solus/workspace-ui/components/activity/lib/activity-line'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'
import { deriveThreadFeedPresentation } from '../../apps/mobile/src/features/threads/thread-feed-presentation'

const promotion: Activity = {
  kind: 'became_lead', id: 'promotion', at: 2,
  subject: { kind: 'session', id: 's' }, by: { kind: 'system' },
}

const history = [
  { messageId: 'u', role: 'user', content: 'Do the work', timestamp: 1 },
  { messageId: 'activity:promotion', role: 'system', content: '', timestamp: 2, activity: promotion },
  { messageId: 'a', role: 'assistant', content: 'Work is done', timestamp: 3 },
]

describe('lead promotion divider', () => {
  test('desktop and web show promotion outside folded work, with the shared label', () => {
    expect(activitySchema.parse(promotion)).toEqual(promotion)
    expect(showsActivity(promotion, null)).toBe(true)
    expect(dividesThread(promotion)).toBe(true)
    expect(activityLine(promotion, null).text).toBe(LEAD_PROMOTION_LABEL)
    const messages: Message[] = history.map((row) => ({ ...row, id: row.messageId }))
    const turns = buildTurns(groupMessages(messages), { running: false })
    expect(turns.some((turn) => turn.lead?.kind === 'system' && turn.lead.message.activity?.kind === 'became_lead')).toBe(true)
  })

  test('mobile shows the same row live and after reload, once, outside folded work', () => {
    const live = TranscriptModel.fromHistory('s', { messages: history.slice(0, 1), before: null })
    live.apply({ type: 'activity', activity: promotion })
    live.apply({ type: 'activity', activity: promotion })
    const restored = TranscriptModel.fromHistory('s', { messages: history, before: null })
    expect(live.order).toEqual(['u', 'activity:promotion'])
    expect(live.items.get('activity:promotion')).toEqual(restored.items.get('activity:promotion'))
    for (const turnActive of [true, false]) {
      const rows = deriveThreadFeedPresentation({
        entries: restored.order.map((id) => ({ id, kind: restored.items.get(id)!.kind })),
        turnActive, working: turnActive, expandedTurnIds: new Set(), expandedWorkGroupIds: new Set(),
      })
      expect(rows.filter((row) => row.type === 'lead-promotion')).toEqual([
        { type: 'lead-promotion', id: 'activity:promotion' },
      ])
    }
  })
})
