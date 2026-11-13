import { expect, test } from 'bun:test'
import type { PullRequest } from '@solus/contracts/providers'
import type { TaskPrChoice } from '@solus/workspace-ui/components/session/lib/task-list'
import { pullRequestMenuRows } from '@solus/workspace-ui/components/session/lib/pull-requests-menu'
import { pullRequestFixture } from './__fixtures__/pull-request'

function choice(targetScope: string, number: number, overrides: Partial<PullRequest> = {}, requiredChecksFail = false): TaskPrChoice {
  return {
    number,
    targetScope,
    title: `PR ${number}`,
    url: `https://${targetScope}/pull/${number}`,
    pullRequest: pullRequestFixture(number, overrides),
    requiredChecksFail,
  }
}

test('open pull requests come before merged and closed ones, each in link order', () => {
  // WHY: the menu is where a person acts on a session's pull requests; the
  // ones that still need something stay at the top, and the settled ones stay
  // listed (they can still be unlinked) without crowding the open ones.
  const rows = pullRequestMenuRows([
    choice('github.com/acme/repo', 1, { state: 'merged' }),
    choice('github.com/acme/repo', 2),
    choice('github.com/acme/repo', 3, { state: 'closed' }),
    choice('github.com/acme/repo', 4, { draft: true }),
  ])

  expect(rows.map((row) => [row.choice.number, row.isSettled])).toEqual([
    [2, false],
    [4, false],
    [1, true],
    [3, true],
  ])
})

test('every row names its repository once the session spans two', () => {
  // WHY: a number names a pull request only inside one repository.
  const single = pullRequestMenuRows([choice('github.com/acme/repo', 7)])
  expect(single[0]!.reference).toBe('#7')

  const mixed = pullRequestMenuRows([choice('github.com/acme/repo', 7), choice('github.com/acme/site', 52)])
  expect(mixed.map((row) => row.reference)).toEqual(['repo#7', 'site#52'])
})

test('the state line says why a pull request cannot merge, and only that is tinted', () => {
  const [failing, open] = pullRequestMenuRows([
    choice('github.com/acme/repo', 8, {}, true),
    choice('github.com/acme/repo', 9),
  ])

  expect(failing!.stateLabel).toBe('Required checks failing')
  expect(failing!.stateTone).toBeDefined()
  expect(open!.stateLabel).toBe('Open')
  expect(open!.stateTone).toBeUndefined()
})

test('a pull request with no record still lists, with its state unknown', () => {
  const [row] = pullRequestMenuRows([{ number: 5, targetScope: 'github.com/acme/repo', title: 'Linked', url: null, pullRequest: null }])

  expect(row!.stateLabel).toBe('Status unavailable')
  expect(row!.isSettled).toBe(false)
})
