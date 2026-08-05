import { describe, expect, it } from 'bun:test'
import {
  holdSidebarTaskOrder,
  type SidebarTask,
  type TaskStatus,
} from '../../src/renderer/components/session/lib/task-list'

function task(id: string, status: TaskStatus): SidebarTask {
  return {
    id,
    key: id,
    title: id,
    projectKey: '/repos/solus',
    projectLabel: 'solus',
    branchName: id,
    serverId: null,
    prNumber: null,
    status,
    attention: null,
    unread: false,
    activityAt: 0,
    runStartedAt: 0,
    tabIds: [id],
  }
}

describe('holdSidebarTaskOrder', () => {
  it('appends a new sidebar task even when the source puts it first', () => {
    // Task-store refreshes may return newest-first. The sidebar is a place, not
    // a feed, so a newly observed row belongs below every row already present.
    const orderedIds = ['existing']
    const ordered = holdSidebarTaskOrder(orderedIds, [
      task('new', 'idle'),
      task('existing', 'idle'),
    ])

    expect(ordered.map((item) => item.id)).toEqual(['existing', 'new'])
    expect(orderedIds).toEqual(['existing', 'new'])
  })

  it('does not move existing rows when activity reorders the source', () => {
    const orderedIds = ['first', 'second']
    const ordered = holdSidebarTaskOrder(orderedIds, [
      task('second', 'question'),
      task('first', 'idle'),
    ])

    expect(ordered.map((item) => item.id)).toEqual(['first', 'second'])
  })
})
