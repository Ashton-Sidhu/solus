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

describe('a host card with skipped steps, warnings, and host times', () => {
  test('a skipped step and a step with a warning count as finished', () => {
    // WHY: setup went past them; the count and the seam must not wait on them.
    const line = statusCardLine(card('active', ['skipped', 'warning', 'active', 'pending']), 0)
    expect(line.rail).toBe('step 3 of 4')
    expect(line.progressPercent).toBe(50)
  })

  test('the total time is the host span, from the first start to the last end', () => {
    // WHY: the fetch and the checkout run at the same time, so a sum of step
    // times would count that time twice.
    const hostCard = card('done', ['done', 'done', 'skipped'])
    hostCard.steps[0] = { ...hostCard.steps[0], startedAt: 1_000, endedAt: 3_000 }
    hostCard.steps[1] = { ...hostCard.steps[1], startedAt: 1_000, endedAt: 2_500 }
    expect(statusCardLine(hostCard, 9_999).rail).toBe('3 steps · 2.0s')
  })

  test('a finished card with a warning is still ready', async () => {
    const { settleSetupCard } = await import('@solus/contracts/setup-card')
    const settled = settleSetupCard({ ...card('active', ['warning', 'skipped', 'active']), icon: 'git-branch' }, 'running')
    expect(settled.steps.map((step) => step.status)).toEqual(['warning', 'skipped', 'done'])
    expect(settled.title).toBe('Worktree ready')
    expect(statusCardLine(settled, 0).type).toBe('ready')
  })
})

describe('step durations', () => {
  test('a step faster than a tenth of a second shows no time', async () => {
    // WHY: "0.0s" beside a step reads as a broken timer, not as "fast".
    const { formatStepDuration } = await import('@solus/contracts/setup-card')
    expect(formatStepDuration(3)).toBe('')
    expect(formatStepDuration(99)).toBe('')
    expect(formatStepDuration(100)).toBe('0.1s')
    expect(formatStepDuration(1800)).toBe('1.8s')
  })
})

describe('the status row during setup', () => {
  test('names the step that runs now, with its percentage', async () => {
    // WHY: the row above the setup card must say what the card says, not a
    // generic "Connecting to your agent…".
    const { setupActivityLabel } = await import('@solus/contracts/setup-card')
    const card = (steps: StatusCardState['steps'], status: StatusCardState['status'] = 'active'): StatusCardState =>
      ({ id: 'worktree-s', title: 'Preparing worktree…', status, steps })
    expect(setupActivityLabel(card([
      { id: 'connection', label: 'Connecting to sidhu', status: 'done' },
      { id: 'repository', label: 'Preparing repository', status: 'active', percent: 54 },
    ]))).toBe('Preparing repository… 54%')
    // Fetch and checkout run together: the later step speaks.
    expect(setupActivityLabel(card([
      { id: 'fetch', label: 'Fetch base branch', status: 'active' },
      { id: 'checkout', label: 'Check out files', status: 'active' },
    ]))).toBe('Checking out files…')
    // A client-built card uses its own label.
    expect(setupActivityLabel(card([{ id: 'pr-fetch', label: 'Fetching pull request', status: 'active' }]))).toBe('Fetching pull request…')
    // No setup runs: the row keeps its own words.
    expect(setupActivityLabel(card([{ id: 'agent', label: 'Start agent', status: 'done' }], 'done'))).toBeNull()
    expect(setupActivityLabel(null)).toBeNull()
  })
})
