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
 * is GitHub's or Jira's, so the capture is posted there as a comment with the
 * bytes published first, as it is for a pull request.
 */

function task(overrides: Partial<Task>): Task {
  return {
    id: 'github:I_1',
    providerId: 'github',
    kind: 'issue',
    reference: 'acme/widgets#1',
    title: 'A task',
    body: '',
    url: 'https://github.com/acme/widgets/issues/1',
    state: { name: 'Open', category: 'open' },
    category: 'open',
    placements: [],
    labels: [],
    writableFields: [],
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
    const choices = evidenceChoices(options, [task({ title: 'Fix the crash' })], '/repo/wt')
    const [first] = choices
    expect(first.id).toBe('store')
    expect(first.target).toBeUndefined()
    // A task row names the task and its state in the provider's words, and files by task key.
    expect(choices.at(-1)).toMatchObject({ label: 'Fix the crash', detail: 'Open', target: { kind: 'task', taskId: 'github:I_1' } })
    // Every choice carries a glyph so the destination kind reads at a glance.
    expect(choices.every((choice) => choice.icon != null)).toBe(true)
  })

  test('a finished task is not where the current change files its evidence', () => {
    const open = task({ id: 'github:I_open', category: 'active' })
    const done = task({ id: 'github:I_done', state: { name: 'Closed', category: 'done' }, category: 'done' })
    expect(attachableTasks([open, done]).map((entry) => entry.id)).toEqual(['github:I_open'])
  })
})
