import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { pendingWorktreeSetupCard, settleSetupCard, stepDurationMs } from '@solus/contracts/setup-card'
import type { StatusCardState, StatusCardSubstep } from '@solus/contracts/types'
import { taskFolderStages, type TaskFolderStageUpdate } from '@solus/server/execution/sessions/session-task-folders'
import { showsStepDetail, substepNote } from '@solus/workspace-ui/components/conversation/lib/status-card'

// docs/plans/codebases.md §7: the setup card of a task folder shows, below
// each step that the host runs one time for each repository, one sub-step for
// each repository. A setup of one repository has no sub-steps.

const API = '/work/shop/api'
const WEB = '/work/shop/web'
const REPOSITORIES = [{ path: API, name: 'api' }, { path: WEB, name: 'web' }]

interface Report extends TaskFolderStageUpdate { stage: string }

/** The reports that the card gets, and the progress function that makes them. */
function stagesOf(repositories = REPOSITORIES) {
  const reports: Report[] = []
  const checkedOut: string[] = []
  const progress = taskFolderStages(repositories, (stage, update) => reports.push({ stage, ...update }), (name, count) => checkedOut.push(`${name} ${count}`))
  const statusesOf = (report: Report | undefined) => report?.substeps?.map((substep) => `${substep.label}:${substep.status}`)
  return { reports, checkedOut, progress, statusesOf }
}

afterEach(() => setSystemTime())

describe('the sub-steps that the host reports for a task folder', () => {
  test('a step has one sub-step for each repository, in the order of the repositories, from its first report', () => {
    const { reports, progress, statusesOf } = stagesOf()
    progress(WEB, 'fetch', { status: 'active' })

    // WHY: a person must see each repository that the step will go through, also the ones that wait.
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ stage: 'fetch', status: 'active' })
    expect(reports[0]!.substeps).toEqual([
      { id: API, label: 'api', status: 'pending' },
      { id: WEB, label: 'web', status: 'active', startedAt: expect.any(Number) },
    ])
    expect(statusesOf(reports[0])).toEqual(['api:pending', 'web:active'])
  })

  test('each step that runs for each repository has its own sub-steps', () => {
    const { reports, progress } = stagesOf()
    for (const stage of ['fetch', 'checkout', 'submodules'] as const) {
      progress(API, stage, { status: 'active' })
      progress(WEB, stage, { status: 'active' })
    }
    for (const stage of ['fetch', 'checkout', 'submodules']) {
      expect(reports.findLast((report) => report.stage === stage)?.substeps?.map((substep) => substep.id)).toEqual([API, WEB])
    }
  })

  test('a repository goes through its states in order, with the times of the host, and the step ends when each one ended', () => {
    const { reports, progress, statusesOf, checkedOut } = stagesOf()
    setSystemTime(new Date(1_000))
    progress(API, 'checkout', { status: 'active' })
    setSystemTime(new Date(2_000))
    progress(WEB, 'checkout', { status: 'active' })
    setSystemTime(new Date(4_000))
    progress(API, 'checkout', { status: 'done' })
    setSystemTime(new Date(7_000))
    progress(WEB, 'checkout', { status: 'done' })

    expect(reports.map((report) => [report.status, statusesOf(report)])).toEqual([
      ['active', ['api:active', 'web:pending']],
      ['active', ['api:active', 'web:active']],
      // WHY: the step is not done while a repository is in it, so the card does not say "done" too early.
      ['active', ['api:done', 'web:active']],
      ['done', ['api:done', 'web:done']],
    ])
    const [api, web] = reports.at(-1)!.substeps!
    expect(stepDurationMs(api!)).toBe(3_000)
    expect(stepDurationMs(web!)).toBe(5_000)
    expect(checkedOut).toEqual(['api 1', 'web 2'])
  })

  test('a report of files that does not change the state of a repository does not reach the card', () => {
    // WHY: a checkout reports many times a second, and each report to the card is a message to each client.
    const { reports, progress } = stagesOf()
    progress(API, 'checkout', { status: 'active' })
    progress(API, 'checkout', { status: 'active', percent: 20 })
    progress(API, 'checkout', { status: 'active', percent: 60 })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.percent).toBeUndefined()
  })

  test('a step with no work in a repository is skipped there, and a warning stays on the row of its repository', () => {
    const { reports, progress, statusesOf } = stagesOf()
    progress(API, 'fetch', { status: 'skipped' })
    // The step waits for the repository that did not report.
    expect(reports.at(-1)).toMatchObject({ status: 'active' })
    progress(WEB, 'fetch', { status: 'active' })
    progress(WEB, 'fetch', { status: 'warning', detail: 'Used local origin/main; fetch failed' })

    const last = reports.at(-1)!
    expect(last.status).toBe('warning')
    expect(statusesOf(last)).toEqual(['api:skipped', 'web:warning'])
    expect(last.substeps![1]!.detail).toBe('Used local origin/main; fetch failed')
    // A skipped sub-step did no work, so it has no times.
    expect(last.substeps![0]).toEqual({ id: API, label: 'api', status: 'skipped' })
    // WHY: the rows name the repository, so the step does not repeat a detail that is true for one of them only.
    expect(last.detail).toBeUndefined()
  })

  test('a step that each repository skips is skipped', () => {
    const { reports, progress } = stagesOf()
    progress(API, 'submodules', { status: 'skipped' })
    progress(WEB, 'submodules', { status: 'skipped' })
    expect(reports.at(-1)!.status).toBe('skipped')
  })

  test('the repository that fails names the error on its own row, and no row stays in progress', () => {
    const { reports, progress, statusesOf } = stagesOf()
    progress(API, 'fetch', { status: 'active' })
    progress(API, 'checkout', { status: 'active' })
    progress(WEB, 'checkout', { status: 'active' })
    progress(WEB, 'checkout', { status: 'error', detail: 'fatal: could not create the worktree' })

    const checkout = reports.findLast((report) => report.stage === 'checkout')!
    expect(statusesOf(checkout)).toEqual(['api:error', 'web:error'])
    // WHY: the person repairs the repository that has the message. The other one was only stopped.
    expect(checkout.substeps!.map((substep) => substep.detail)).toEqual([undefined, 'fatal: could not create the worktree'])
    // The fetch of `api` ran beside its checkout and did not end.
    expect(statusesOf(reports.findLast((report) => report.stage === 'fetch'))).toEqual(['api:error', 'web:pending'])
    // The launch ends the steps, with the recovery of the card.
    expect(reports.every((report) => report.status !== 'error')).toBe(true)

    // A checkout that the failure stopped reports after it. The card is final.
    const count = reports.length
    progress(API, 'checkout', { status: 'done' })
    expect(reports).toHaveLength(count)
  })

  test('a failure before the first report of a step still has its row', () => {
    const { reports, progress, statusesOf } = stagesOf()
    progress(WEB, 'checkout', { status: 'error', detail: 'no commit' })
    expect(statusesOf(reports.at(-1))).toEqual(['api:pending', 'web:error'])
  })

  test('one repository gives no sub-steps: its reports go to the card as they are', () => {
    const { reports, progress, checkedOut } = stagesOf([{ path: API, name: 'api' }])
    progress(API, 'checkout', { status: 'active', percent: 40 })
    progress(API, 'fetch', { status: 'warning', detail: 'Used local main; fetch failed' })
    progress(API, 'checkout', { status: 'done' })
    // The launch names a failure on the step.
    progress(API, 'checkout', { status: 'error', detail: 'failed' })

    expect(reports).toEqual([
      { stage: 'checkout', status: 'active', percent: 40 },
      { stage: 'fetch', status: 'warning', detail: 'Used local main; fetch failed' },
      { stage: 'checkout', status: 'done' },
    ])
    expect(checkedOut).toEqual(['api 1'])
  })
})

describe('the sub-steps in the setup card contract', () => {
  const substep = (label: string, status: StatusCardSubstep['status']): StatusCardSubstep => ({ id: `/work/${label}`, label, status })
  const card = (substeps: StatusCardSubstep[]): StatusCardState => ({
    id: 'worktree-s', title: 'Preparing worktree…', icon: 'git-branch', status: 'active',
    steps: [{ id: 'checkout', label: 'Check out files', status: 'active', substeps }, { id: 'agent', label: 'Start agent', status: 'pending' }],
  })

  test('the card that a client shows at Send has no sub-steps', () => {
    // WHY: only the host knows the repositories of the plan, and a setup of one repository must look as before.
    expect(pendingWorktreeSetupCard('s', 'main').steps.some((step) => step.substeps !== undefined)).toBe(false)
  })

  test('a setup that ended settles its sub-steps by the rule of its steps', () => {
    const open = card([substep('api', 'done'), substep('web', 'active'), substep('docs', 'pending'), substep('ui', 'skipped'), substep('lib', 'warning')])
    // The run started: setup went past each repository.
    expect(settleSetupCard(open, 'running').steps[0]!.substeps!.map((each) => each.status)).toEqual(['done', 'done', 'done', 'skipped', 'warning'])
    // WHY: a stopped setup must not show a repository in progress. One that did not start stays as it was.
    expect(settleSetupCard(open, 'failed').steps[0]!.substeps!.map((each) => each.status)).toEqual(['done', 'error', 'pending', 'skipped', 'warning'])
    expect(settleSetupCard(open, 'running').steps[1]!.substeps).toBeUndefined()
  })
})

describe('the row of a sub-step on the desktop card', () => {
  test('says "running" or "skipped", then the time of its repository, and nothing while it waits', () => {
    const row = (status: StatusCardSubstep['status'], times: Pick<StatusCardSubstep, 'startedAt' | 'endedAt'> = {}): StatusCardSubstep => ({ id: API, label: 'api', status, ...times })
    expect(substepNote(row('pending'))).toBe('')
    expect(substepNote(row('active', { startedAt: 1_000 }))).toBe('running')
    expect(substepNote(row('skipped'))).toBe('skipped')
    expect(substepNote(row('done', { startedAt: 1_000, endedAt: 3_100 }))).toBe('2.1s')
    expect(substepNote(row('warning', { startedAt: 1_000, endedAt: 2_000 }))).toBe('1.0s')
    expect(substepNote(row('error', { startedAt: 1_000, endedAt: 1_500 }))).toBe('0.5s')
  })

  test('a failed or warned row shows its detail, as a step does', () => {
    expect(showsStepDetail({ status: 'error', detail: 'fatal: no commit' })).toBe(true)
    expect(showsStepDetail({ status: 'warning', detail: 'Used local main; fetch failed' })).toBe(true)
    // A row that the failure of a different repository stopped has no message.
    expect(showsStepDetail({ status: 'error' })).toBe(false)
    expect(showsStepDetail({ status: 'done', detail: 'kept from a warning' })).toBe(false)
  })
})
