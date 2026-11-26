import { describe, expect, it } from 'bun:test'
import { prMenuTitle } from '@solus/workspace-ui/components/session/lib/pr-menu'
import type { PrChoice } from '@solus/workspace-ui/components/session/lib/sidebar-rows'
import { pullRequestFixture } from './__fixtures__/pull-request'

const choice: PrChoice = {
  number: 43,
  targetScope: '/repo',
  title: '#43 Fix task navigation',
  url: null,
  pullRequest: null,
}

describe('task PR menu titles', () => {
  it('shows the reference once when the saved title includes it', () => {
    expect(prMenuTitle(choice)).toBe('Fix task navigation')
    expect(prMenuTitle({ ...choice, title: '#43 — Fix navigation' })).toBe('Fix navigation')
  })

  it('uses the current PR title after a branch observation supplies it', () => {
    expect(prMenuTitle({
      ...choice,
      pullRequest: pullRequestFixture(43, { title: 'Updated title' }),
    })).toBe('Updated title')
  })

  it('keeps an unloaded PR readable without inventing a title', () => {
    expect(prMenuTitle({ ...choice, title: '#43' })).toBe('Pull request')
  })

  it('preserves a different number that is part of the title', () => {
    expect(prMenuTitle({ ...choice, title: '#431 regression' })).toBe('#431 regression')
  })
})
