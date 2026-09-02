import { describe, expect, it } from 'bun:test'
import { taskTabs } from '../../packages/workspace-ui/src/components/tasks/task-page/lib/task-tabs'

describe('the task page keeps its four sections when it becomes a strip', () => {
  it('lists the desktop sections in the desktop order', () => {
    // The strip is the same page, not a mobile subset: a reader moving between
    // a phone and a 1440px window must not have to relearn what a task holds.
    expect(taskTabs({ linked: 0, sessions: 0, activity: 0 }).map((tab) => tab.id)).toEqual([
      'overview',
      'linked',
      'sessions',
      'activity',
    ])
  })

  it('carries a count on every section that is a collection of things', () => {
    const tabs = taskTabs({ linked: 3, sessions: 2, activity: 7 })
    expect(tabs.map((tab) => tab.count)).toEqual([undefined, 3, 2, 7])
  })

  it('gives Overview no count, because it would be counting the task', () => {
    expect(taskTabs({ linked: 1, sessions: 1, activity: 1 })[0].count).toBeUndefined()
  })

  it('reports zero rather than hiding it, and lets the strip decide what to draw', () => {
    // The rule "an empty section draws no number" belongs to the strip, so the
    // model stays honest and one component owns the presentation choice.
    const tabs = taskTabs({ linked: 0, sessions: 0, activity: 0 })
    expect(tabs.slice(1).map((tab) => tab.count)).toEqual([0, 0, 0])
  })
})
