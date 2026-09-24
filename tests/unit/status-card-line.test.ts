import { describe, expect, test } from 'bun:test'
import type { StatusCardState } from '@solus/contracts/types'
import { statusCardLine } from '@solus/workspace-ui/components/conversation/lib/status-card'

function card(status: StatusCardState['status'], stepStatuses: StatusCardState['steps'][number]['status'][]): StatusCardState {
  return {
    id: 'worktree-1',
    title: 'Preparing worktree…',
    status,
    steps: stepStatuses.map((stepStatus, i) => ({ id: `s${i}`, label: `Step ${i}`, status: stepStatus })),
  }
}

describe('statusCardLine', () => {
  test('a running card names the step the user waits on, as a count', () => {
    const line = statusCardLine(card('active', ['done', 'active', 'pending']), 0)
    expect(line.type).toBe('setting up')
    expect(line.rail).toBe('step 2 of 3')
    expect(line.progressPercent).toBe(33)
  })

  test('a finished card collapses to its step count and the time the user waited', () => {
    const line = statusCardLine(card('done', ['done', 'done', 'done']), 2100)
    expect(line.type).toBe('ready')
    expect(line.rail).toBe('3 steps · 2.1s')
  })

  test('a finished card with no observed timing does not show an empty time', () => {
    expect(statusCardLine(card('done', ['done']), 0).rail).toBe('1 step')
  })

  test('a failed card says so in the type slot, and the rail keeps counts only', () => {
    const line = statusCardLine(card('error', ['done', 'error', 'pending']), 0)
    expect(line.type).toBe('failed')
    expect(line.rail).toBe('3 steps')
  })
})
