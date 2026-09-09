import { describe, expect, test } from 'bun:test'
import { pullRequestNumber } from '@solus/server/browser/pull-request-link'
import { attachableTasks, evidenceChoices } from '@solus/workspace-ui/components/browser/lib/evidence-menu'
import type { BrowserEvidenceOptions } from '@solus/contracts/browser-types'
import type { Task } from '@solus/contracts/task-types'

/**
 * The evidence loop's rules.
 *
 * A capture that only the agent saw is the state this feature exists to remove,
 * so what matters here is where a capture can go and how it gets there: a task
 * keeps the local asset (Solus renders it, and the task domain refuses to push
 * it upstream where it would resolve to nothing), while a pull request cannot
 * read a local asset at all and needs the bytes published first.
 */

function task(overrides: Partial<Task>): Task {
  return {
    id: 't1',
    providerId: 'local',
    kind: 'task',
    title: 'A task',
    body: '',
    status: 'todo',
    url: null,
    labels: [],
    updatedAt: 0,
    ...overrides,
  }
}

describe('browser evidence', () => {
  test('a pull request URL resolves to the number a comment is posted against', () => {
    // `gh pr view` answers with a web URL; everything downstream needs the number.
    expect(pullRequestNumber('https://github.com/acme/widgets/pull/412')).toBe(412)
    expect(pullRequestNumber('https://github.com/acme/widgets/pull/412/files')).toBe(412)
    expect(pullRequestNumber('https://github.com/acme/widgets/pulls')).toBeNull()
    expect(pullRequestNumber('')).toBeNull()
  })

  test('nothing is offered that cannot work', () => {
    // A page with no pull request must not show a row that fails when pressed.
    const withoutPr: BrowserEvidenceOptions = { worktreePath: '/repo/wt', branch: 'feature' }
    const ids = evidenceChoices(withoutPr, [], '/repo/wt').map((choice) => choice.id)
    expect(ids).toEqual(['store'])

    const withPr: BrowserEvidenceOptions = {
      worktreePath: '/repo/wt',
      branch: 'feature',
      pullRequest: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    }
    const withPrChoices = evidenceChoices(withPr, [], '/repo/wt')
    // The pull request is the only filing destination here, so it follows the
    // capture-only lead immediately.
    expect(withPrChoices[1].target).toEqual({ kind: 'pr', number: 7, cwd: '/repo/wt' })
  })

  test('capture-only leads and is always present', () => {
    // A capture with nowhere to go yet is still worth taking, so the
    // destination-free option cannot disappear when destinations exist — and it
    // is the reliable default, so it comes first.
    const options: BrowserEvidenceOptions = {
      worktreePath: '/repo/wt',
      pullRequest: { number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    }
    const choices = evidenceChoices(options, [task({ projectKey: '/repo' })], '/repo/wt')
    const [first] = choices
    expect(first.id).toBe('store')
    expect(first.target).toBeUndefined()
    // Every choice carries a glyph so the destination kind reads at a glance.
    expect(choices.every((choice) => choice.icon != null)).toBe(true)
  })

  test('a finished task is not where the current change files its evidence', () => {
    const tasks = [
      task({ id: 'open', status: 'in_progress', projectKey: '/repo' }),
      task({ id: 'done', status: 'done', projectKey: '/repo' }),
    ]
    expect(attachableTasks(tasks, '/repo/wt').map((entry) => entry.id)).toEqual(['open'])
  })

  test('a worktree files against its own project, not every open task', () => {
    const tasks = [
      task({ id: 'mine', status: 'todo', projectKey: '/repo' }),
      task({ id: 'elsewhere', status: 'todo', projectKey: '/other' }),
    ]
    expect(attachableTasks(tasks, '/repo/wt').map((entry) => entry.id)).toEqual(['mine'])
    // A page with no worktree cannot be scoped, so scoping must not silently
    // empty the list and leave the user with nowhere to file.
    expect(attachableTasks(tasks, undefined).map((entry) => entry.id)).toEqual(['mine', 'elsewhere'])
  })
})
