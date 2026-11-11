import { describe, expect, test } from 'bun:test'
import type { Activity } from '@solus/contracts/activity'
import type { User } from '@solus/contracts/user'
import { activityLine } from '@solus/workspace-ui/components/activity/lib/activity-line'

const ME: User = { id: { kind: 'account', accountId: 'me' }, displayName: 'Mina Reader' }

function moved(to: string | null): Activity {
  return {
    id: 'event-1',
    subject: { kind: 'task', id: 'github:I_1' },
    kind: 'task_changed',
    change: 'status_changed',
    by: { kind: 'user', user: ME },
    at: 1,
    to,
  }
}

describe('a task move on the activity feed', () => {
  test('a status category reads as the label the Tasks page shows', () => {
    // WHY: a move from a view that mixes sources names a category, and the
    // feed must use the same word as the column the person moved the task to.
    expect(activityLine(moved('active'), ME.id).text).toBe('You moved this to Active')
    expect(activityLine(moved('done'), ME.id).text).toBe('You moved this to Done')
  })

  test('a provider column shows with the provider\'s own name', () => {
    // WHY: GitHub and Jira own the column names. Solus does not rename them.
    expect(activityLine(moved('In review'), ME.id).text).toBe('You moved this to In review')
  })

  test('a move with no recorded target still reads', () => {
    expect(activityLine(moved(null), ME.id).text).toBe('You moved this to unknown')
  })
})
