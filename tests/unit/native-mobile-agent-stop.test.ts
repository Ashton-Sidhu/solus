import { describe, expect, test } from 'bun:test'
import type { Activity } from '@solus/contracts/activity'
import type { SessionHistoryPage } from '@solus/contracts/session-history'
import { TranscriptModel } from '../../apps/mobile/src/features/conversation/lib/transcript-model'

/**
 * When another agent session stops a run, the phone says so and names that
 * session, as the desktop and web divider do. A person's stop adds no row: the
 * phone has never drawn one.
 */

const subject = { kind: 'session' as const, id: 'session-1' }
const agentStop: Activity = { id: 'stop-1', subject, at: 1, by: { kind: 'agent', sessionId: 'lead', title: 'Lead review' }, kind: 'stopped' }
const personStop: Activity = { id: 'stop-2', subject, at: 2, by: { kind: 'user', user: { id: { kind: 'local', localId: 'me' }, displayName: 'Me' } }, kind: 'stopped' }

const page = (activity: Activity[]): SessionHistoryPage => ({
  messages: activity.map((row) => ({ role: 'system', content: '', timestamp: row.at, activity: row })),
  before: null,
})

function noticeTexts(model: TranscriptModel): string[] {
  return model.order.flatMap((id) => {
    const item = model.items.get(id)
    return item?.kind === 'notice' ? [item.text] : []
  })
}

describe("an agent's stop on mobile", () => {
  test('history names the stopping session; a person stop adds no row', () => {
    const model = TranscriptModel.fromHistory('session-1', page([agentStop, personStop]))
    expect(noticeTexts(model)).toEqual(['Stopped by Lead review'])
  })

  test('a live stop with no session title says an agent stopped it, once', () => {
    const model = TranscriptModel.fromHistory('session-1', page([]))
    const untitled: Activity = { ...agentStop, by: { kind: 'agent', sessionId: 'lead' } }
    model.apply({ type: 'activity', activity: untitled })
    model.apply({ type: 'activity', activity: untitled })
    expect(noticeTexts(model)).toEqual(['Stopped by an agent'])
  })
})
