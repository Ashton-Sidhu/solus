import { describe, expect, test } from 'bun:test'
import type { CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import { checksPresentation } from '@solus/workspace-ui/components/prs/lib/checks'
import {
  checksButtonLabel,
  checksPopover,
  nextMoveLabel,
  nextMoveOpensDraft,
} from '@solus/workspace-ui/components/project-panel/lib/linked-pull-request-row'

function check(name: string, outcome: 'failure' | 'cancelled' | 'success' | 'skipped' | 'running'): CheckItem {
  return {
    id: name,
    name,
    conclusion: outcome === 'running' ? null : outcome,
    inFlight: outcome === 'running',
    detailsUrl: null,
    appName: null,
    startedAt: null,
    completedAt: null,
  }
}

function summary(items: CheckItem[], headSha = 'head'): PrChecksSummary {
  return {
    state: items.some((item) => item.inFlight) ? 'pending' : 'passing',
    required: items,
    optional: [],
    headSha,
    inFlight: items.some((item) => item.inFlight),
  }
}

describe('the checks button on the pull request row', () => {
  test('names failures before running checks, cancelled ones included', () => {
    const checks = summary([check('lint', 'failure'), check('bot', 'cancelled'), check('unit', 'running'), check('e2e', 'success')])
    expect(checksButtonLabel(checksPresentation(checks, 'head', false), checks)).toBe('2 failed')
  })

  test('names running checks while nothing has failed', () => {
    const checks = summary([check('unit', 'running'), check('e2e', 'running'), check('lint', 'success')])
    expect(checksButtonLabel(checksPresentation(checks, 'head', false), checks)).toBe('2 running')
  })

  test('says nothing when every check passed: the green glyph says it', () => {
    const checks = summary([check('lint', 'success'), check('docs', 'skipped')])
    expect(checksButtonLabel(checksPresentation(checks, 'head', false), checks)).toBeNull()
  })

  test('does not assert a result read against an older head', () => {
    const checks = summary([check('lint', 'failure')], 'old-head')
    expect(checksButtonLabel(checksPresentation(checks, 'new-head', false), checks)).toBe('Checking')
  })

  test('says so when the checks could not be read', () => {
    expect(checksButtonLabel(checksPresentation(undefined, 'head', true), undefined)).toBe('Unavailable')
  })
})

describe('the checks popover', () => {
  test('lists what needs a look first and folds the completed checks', () => {
    const model = checksPopover(summary([check('e2e', 'success'), check('unit', 'running'), check('lint', 'failure')]))
    expect(model.heading).toBe('Some checks were not successful')
    expect(model.summary).toBe('1 of 3 failing')
    expect(model.attention.map((item) => item.name)).toEqual(['lint'])
    expect(model.running.map((item) => item.name)).toEqual(['unit'])
    expect(model.completed.map((item) => item.name)).toEqual(['e2e'])
    expect(model.foldsCompleted).toBe(true)
  })

  test('while checks run, says how many of how many', () => {
    const model = checksPopover(summary([check('unit', 'running'), check('e2e', 'running'), check('lint', 'success')]))
    expect(model.heading).toBe('Some checks haven’t completed yet')
    expect(model.summary).toBe('2 of 3 running')
  })

  test('when all passed, shows every check: there is nothing to fold behind', () => {
    const model = checksPopover(summary([check('lint', 'success')]))
    expect(model.heading).toBe('All checks have passed')
    expect(model.foldsCompleted).toBe(false)
  })

  test('with no checks, says no checks were reported', () => {
    expect(checksPopover(summary([])).heading).toBe('No checks reported')
  })
})

test('the next move is one short verb; only the agent handoffs open a draft', () => {
  expect(nextMoveLabel('fix-checks')).toBe('Fix')
  expect(nextMoveLabel('merge')).toBe('Merge')
  expect(nextMoveLabel('mark-ready')).toBe('Ready')
  expect(nextMoveOpensDraft('fix-checks')).toBe(true)
  expect(nextMoveOpensDraft('resolve-conflicts')).toBe(true)
  expect(nextMoveOpensDraft('merge')).toBe(false)
  expect(nextMoveOpensDraft('update-branch')).toBe(false)
})
