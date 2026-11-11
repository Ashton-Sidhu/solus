import { describe, expect, test } from 'bun:test'
import { attachableTasks, evidenceChoices } from '@solus/workspace-ui/components/browser/lib/evidence-menu'
import type { BrowserEvidenceOptions } from '@solus/contracts/browser-types'
import type { Task } from '@solus/contracts/task-types'

function task(overrides: Partial<Task>): Task {
  return {
    id: 'github:I_1',
    providerId: 'github',
    kind: 'issue',
    title: 'A task',
    body: '',
    url: null,
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [],
    labels: [],
    writableFields: [],
    updatedAt: 0,
    ...overrides,
  }
}

describe('where a browser capture can be filed', () => {
  test('a finished task is not where the current change files its evidence', () => {
    const tasks = [
      task({ id: 'active', category: 'active' }),
      task({ id: 'done', category: 'done' }),
    ]
    expect(attachableTasks(tasks, tasks).map((entry) => entry.id)).toEqual(['active'])
  })

  test('a page files against the tasks of its own project, not every task', () => {
    const mine = task({ id: 'mine' })
    const elsewhere = task({ id: 'elsewhere' })
    expect(attachableTasks([mine, elsewhere], [mine]).map((entry) => entry.id)).toEqual(['mine'])
  })

  test('a page whose project lists no open task still has somewhere to file', () => {
    // WHY: a page with no project, or a project with no task source, cannot be
    // scoped. Scoping must not silently empty the list.
    const tasks = [task({ id: 'mine' }), task({ id: 'elsewhere' })]
    expect(attachableTasks(tasks, []).map((entry) => entry.id)).toEqual(['mine', 'elsewhere'])
    expect(attachableTasks(tasks, [task({ id: 'closed', category: 'done' })]).map((entry) => entry.id)).toEqual(['mine', 'elsewhere'])
  })

  test('a task row says the provider\'s own word for its state', () => {
    // WHY: two tasks with the same title are told apart by what the provider
    // shows, so the row must not show a Solus word in its place.
    const options: BrowserEvidenceOptions = { worktreePath: '/repo/wt' }
    const choices = evidenceChoices(options, [task({ id: 'jira:c:1', title: 'Cutover', state: { name: 'In review', category: 'active' } })], '/repo/wt')
    expect(choices.map((choice) => choice.id)).toEqual(['store', 'task-jira:c:1'])
    expect(choices[1]).toMatchObject({ label: 'Cutover', detail: 'In review', target: { kind: 'task', taskId: 'jira:c:1' } })
  })
})
