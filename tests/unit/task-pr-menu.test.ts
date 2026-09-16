import { describe, expect, it } from 'bun:test'
import { taskPrMenuTitle } from '@solus/workspace-ui/components/session/lib/task-pr-menu'
import type { TaskPrChoice } from '@solus/workspace-ui/components/session/lib/task-list'
import { pullRequestFixture } from './__fixtures__/pull-request'

const choice: TaskPrChoice = {
  number: 43,
  targetScope: '/repo',
  title: '#43 Fix task navigation',
  url: null,
  pullRequest: null,
}

describe('task PR menu titles', () => {
  it('shows the reference once when the saved title includes it', () => {
    expect(taskPrMenuTitle(choice)).toBe('Fix task navigation')
    expect(taskPrMenuTitle({ ...choice, title: '#43 — Fix navigation' })).toBe('Fix navigation')
  })

  it('uses the current PR title after a branch observation supplies it', () => {
    expect(taskPrMenuTitle({
      ...choice,
      pullRequest: pullRequestFixture(43, { title: 'Updated title' }),
    })).toBe('Updated title')
  })

  it('keeps an unloaded PR readable without inventing a title', () => {
    expect(taskPrMenuTitle({ ...choice, title: '#43' })).toBe('Pull request')
  })

  it('preserves a different number that is part of the title', () => {
    expect(taskPrMenuTitle({ ...choice, title: '#431 regression' })).toBe('#431 regression')
  })
})
