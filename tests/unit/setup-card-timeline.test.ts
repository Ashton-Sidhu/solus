import { describe, expect, test } from 'bun:test'
import type { StatusCardState, StatusCardStep } from '@solus/contracts/types'
import { setupOutputHome, stepRailStateOf, stepTrailingNote, substepElapsedNote } from '@solus/workspace-ui/components/conversation/lib/status-card'

// The setup card draws its steps on the step timeline (StepRail), and each
// repository of a task folder as a branch off its step.

function step(status: StatusCardStep['status'], extra: Partial<StatusCardStep> = {}): StatusCardStep {
  return { id: extra.id ?? 'checkout', label: 'Check out files', status, ...extra }
}

function failedCard(steps: StatusCardStep[], output: string[] | undefined = ['fatal: a branch named solus/fix-auth already exists']): Pick<StatusCardState, 'status' | 'steps' | 'output'> {
  return { status: 'error', steps, output }
}

describe('where a failed setup card shows the host output', () => {
  test('under the repository that failed, so the error sits next to its repository', () => {
    const card = failedCard([
      step('done', { id: 'fetch' }),
      step('error', {
        substeps: [
          { id: '/work/web', label: 'web', status: 'done' },
          { id: '/work/api', label: 'api', status: 'error', detail: 'The branch exists' },
          { id: '/work/shared', label: 'shared', status: 'pending' },
        ],
      }),
    ])
    expect(setupOutputHome(card)).toEqual({ kind: 'substep', stepId: 'checkout', substepId: '/work/api' })
  })

  test('under the step that failed when no repository failed', () => {
    expect(setupOutputHome(failedCard([step('done', { id: 'fetch' }), step('error')]))).toEqual({ kind: 'step', stepId: 'checkout' })
  })

  test('after the steps when the card failed with no failed step, such as a sync', () => {
    expect(setupOutputHome(failedCard([step('done')]))).toEqual({ kind: 'end' })
  })

  test('nowhere while setup runs, and nowhere when the host sent no output', () => {
    // WHY: an empty terminal panel or one on a running card is noise, not evidence.
    expect(setupOutputHome({ status: 'active', steps: [step('active')], output: ['Cloning'] })).toBeNull()
    expect(setupOutputHome(failedCard([step('error')], []))).toBeNull()
  })
})

describe('what the title row of a step says at its end', () => {
  test('a running step of several repositories counts the ones that finished', () => {
    const running = step('active', {
      substeps: [
        { id: 'web', label: 'web', status: 'done' },
        { id: 'api', label: 'api', status: 'active' },
        { id: 'shared', label: 'shared', status: 'pending' },
      ],
    })
    expect(stepTrailingNote(running, undefined)).toBe('1 of 3')
  })

  test('a running step of one repository says nothing: its spinner and its bar show it', () => {
    expect(stepTrailingNote(step('active', { percent: 40 }), 1_200)).toBe('')
  })

  test('a finished step shows its time, from the host or else from this client', () => {
    expect(stepTrailingNote(step('done', { startedAt: 1_000, endedAt: 2_400 }), undefined)).toBe('1.4s')
    expect(stepTrailingNote(step('done'), 2_100)).toBe('2.1s')
    expect(stepTrailingNote(step('skipped'), 900)).toBe('skipped')
  })
})

test('each setup status has its own marker on the step timeline', () => {
  // WHY: a failed or skipped step must not read as a step that waits.
  expect((['pending', 'active', 'done', 'error', 'warning', 'skipped'] as const).map(stepRailStateOf)).toEqual(['next', 'current', 'done', 'failed', 'warning', 'skipped'])
})

describe('the time beside a running repository', () => {
  test('counts from the host start time, so a person sees that the repository moves', () => {
    expect(substepElapsedNote({ status: 'active', startedAt: 10_000 }, 14_200)).toBe('4.2s')
  })

  test('is empty without a host start time, and never negative when the clocks differ', () => {
    // WHY: a made-up or negative time is worse than no time.
    expect(substepElapsedNote({ status: 'active' }, 14_200)).toBe('')
    expect(substepElapsedNote({ status: 'active', startedAt: 20_000 }, 14_200)).toBe('')
  })

  test('is empty once the repository stopped: its row shows the time it took instead', () => {
    expect(substepElapsedNote({ status: 'done', startedAt: 10_000 }, 14_200)).toBe('')
  })
})
