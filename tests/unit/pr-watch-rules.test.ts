import { describe, expect, test } from 'bun:test'
import type { CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'
import {
  evaluateWatch,
  initialWatchState,
  NO_CHECKS_GRACE_MS,
  REMARK_ONLY_WAKE_LIMIT,
  wakeText,
  type WatchRead,
  type WatchRemark,
} from '@solus/server/prs/pr-watch-rules'
import type { PullRequestWatchState } from '@solus/server/data/sessions/pull-request-watches'

const STARTED_AT = Date.parse('2026-10-07T12:00:00Z')

function check(name: string, conclusion: CheckItem['conclusion'], id = name): CheckItem {
  return {
    id, name, conclusion, inFlight: conclusion === null,
    detailsUrl: `https://ci.example/${name}`, appName: 'GitHub Actions', startedAt: null, completedAt: null,
  }
}

function checks(required: CheckItem[], optional: CheckItem[] = []): PrChecksSummary {
  return { state: 'pending', required, optional, headSha: 'head-1', inFlight: required.some((item) => item.inFlight) }
}

function remark(id: string, at: string, author = 'reviewer'): WatchRemark {
  return { id, kind: 'comment', author, body: `comment ${id}`, at }
}

function read(overrides: Partial<WatchRead> & { headSha?: string; mergeable?: boolean | null; state?: 'open' | 'closed' | 'merged' } = {}): WatchRead {
  return {
    pullRequest: {
      number: 42,
      url: 'https://github.com/solus/app/pull/42',
      title: 'Fix it',
      state: overrides.state ?? 'open',
      headSha: overrides.headSha ?? 'head-1',
      mergeable: overrides.mergeable === undefined ? true : overrides.mergeable,
    },
    checks: overrides.checks ?? checks([]),
    remarks: overrides.remarks === undefined ? [] : overrides.remarks,
    viewer: 'agent-account',
    readAt: overrides.readAt ?? STARTED_AT,
  }
}

const minutes = (count: number) => STARTED_AT + count * 60_000

/** Run reads in order, as the watcher does, and collect the news kinds of each. */
function run(reads: WatchRead[], state: PullRequestWatchState = initialWatchState(STARTED_AT)): { state: PullRequestWatchState; kinds: string[][] } {
  const kinds: string[][] = []
  for (const next of reads) {
    const evaluation = evaluateWatch(state, next)
    state = evaluation.next
    kinds.push(evaluation.news.map((item) => item.kind))
  }
  return { state, kinds }
}

describe('PR watch rules', () => {
  test('a failed check is news once, as soon as it fails, while others still run', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', null), check('lint', null)]) }),
      read({ checks: checks([check('build', 'failure'), check('lint', null)]) }),
      read({ checks: checks([check('build', 'failure'), check('lint', null)]) }),
    ])
    expect(kinds).toEqual([[], ['checks-failed'], []])
  })

  test('a check that fails again after a rerun on the same head is news again', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', 'failure')]) }),
      read({ checks: checks([check('build', null)]) }),
      read({ checks: checks([check('build', 'failure')]) }),
    ])
    expect(kinds).toEqual([['checks-failed'], [], ['checks-failed']])
  })

  test('the pass is news once per head, and a push starts the checks over', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', 'success')]) }),
      read({ checks: checks([check('build', 'success')]) }),
      read({ headSha: 'head-2', checks: checks([check('build', null)]) }),
      read({ headSha: 'head-2', checks: checks([check('build', 'success')]) }),
    ])
    expect(kinds).toEqual([['checks-passed'], [], [], ['checks-passed']])
  })

  test('a required check that appears already passed after the pass is told', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', 'success')]) }),
      read({ checks: checks([check('build', 'success'), check('deploy-preview', 'success')]) }),
    ])
    expect(kinds).toEqual([['checks-passed'], ['checks-passed']])
  })

  test('advisory checks that pass later do not wake the agent again', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', 'success')]) }),
      read({ checks: checks([check('build', 'success')], [check('coverage-bot', 'success')]) }),
    ])
    expect(kinds).toEqual([['checks-passed'], []])
  })

  test('with no required check, every check gates the pass; with no check at all there is no pass', () => {
    expect(run([read({ checks: checks([], [check('a', 'success'), check('b', null)]) })]).kinds).toEqual([[]])
    expect(run([read({ checks: checks([], [check('a', 'success'), check('b', 'skipped')]) })]).kinds).toEqual([['checks-passed']])
    expect(run([read({ checks: checks([]) })]).kinds).toEqual([[]])
  })

  // A workflow that skips every job (paths-ignore: docs/**) reports no check, so the pass never comes.
  test('a head with no check at all is news once after the grace period, and never claims a pass', () => {
    const graceMinutes = NO_CHECKS_GRACE_MS / 60_000
    const reads = [0, graceMinutes - 1, graceMinutes + 1, graceMinutes + 30].map((at) => read({ readAt: minutes(at) }))
    expect(run(reads).kinds).toEqual([[], [], ['no-checks'], []])
    const told = evaluateWatch(evaluateWatch(initialWatchState(STARTED_AT), reads[0]).next, reads[2])
    const text = wakeText({ number: 42, url: 'u', headSha: 'head-1' }, told.news, null)
    expect(text).toContain(`No checks have reported on this head after ${graceMinutes + 1} minutes`)
    expect(text).not.toContain('Every check that gates the merge passed')
  })

  test('a head that had checks is not waited on; a push waits again', () => {
    expect(run([
      read({ readAt: minutes(0) }),
      read({ readAt: minutes(5), checks: checks([check('build', null)]) }),
      read({ readAt: minutes(30), checks: checks([check('build', 'success')]) }),
      read({ readAt: minutes(60) }),
    ]).kinds).toEqual([[], [], ['checks-passed'], []])
    expect(run([
      read({ readAt: minutes(0), checks: checks([check('build', 'success')]) }),
      read({ readAt: minutes(5), headSha: 'head-2' }),
      read({ readAt: minutes(25), headSha: 'head-2' }),
    ]).kinds).toEqual([['checks-passed'], [], ['no-checks']])
  })

  test('the wait for checks survives a restart', () => {
    // Each read starts from the stored JSON, as after a restart.
    let state = initialWatchState(STARTED_AT)
    const kinds: string[][] = []
    for (const at of [0, 10, 20]) {
      const evaluation = evaluateWatch(JSON.parse(JSON.stringify(state)) as PullRequestWatchState, read({ readAt: minutes(at) }))
      state = evaluation.next
      kinds.push(evaluation.news.map((item) => item.kind))
    }
    expect(kinds).toEqual([[], [], ['no-checks']])
  })

  // Required checks passed while others still ran: the agent was woken early and never again.
  test('the optional checks still running at the required pass wake the agent once when they all pass', () => {
    const { kinds } = run([
      read({ checks: checks([check('build', 'success')], [check('e2e', null)]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success')]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success')]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success'), check('bot', null)]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success'), check('bot', 'success')]) }),
    ])
    expect(kinds).toEqual([['checks-passed'], ['all-checks-passed'], [], [], []])
  })

  test('an owed optional check that fails is told as a failure, and its passing rerun settles the debt', () => {
    const { kinds, state } = run([
      read({ checks: checks([check('build', 'success')], [check('e2e', null)]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'failure')]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'failure')]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success')]) }),
      read({ checks: checks([check('build', 'success')], [check('e2e', 'success')]) }),
    ])
    expect(kinds).toEqual([['checks-passed'], ['checks-failed'], [], ['all-checks-passed'], []])
    expect(state.owedChecks).toEqual([])
  })

  test('an owed check that becomes required is gate news, and a push forgets what was owed', () => {
    expect(run([
      read({ checks: checks([check('build', 'success')], [check('e2e', null)]) }),
      read({ checks: checks([check('build', 'success'), check('e2e', 'success')]) }),
      read({ checks: checks([check('build', 'success'), check('e2e', 'success')]) }),
    ]).kinds).toEqual([['checks-passed'], ['checks-passed'], []])
    expect(run([
      read({ checks: checks([check('build', 'success')], [check('e2e', null)]) }),
      read({ headSha: 'head-2', checks: checks([check('build', 'success')]) }),
      read({ headSha: 'head-2', checks: checks([check('build', 'success')], [check('e2e', 'success')]) }),
    ]).kinds).toEqual([['checks-passed'], ['checks-passed'], []])
  })

  test('a conflict is news when it starts; unknown mergeability keeps the last answer', () => {
    const { kinds } = run([
      read({ mergeable: false }),
      read({ mergeable: null }),
      read({ mergeable: false }),
      read({ mergeable: true }),
      read({ mergeable: false }),
    ])
    expect(kinds).toEqual([['conflicting'], [], [], [], ['conflicting']])
  })

  test('remarks after the start are news; the agent account and older remarks are not', () => {
    const evaluation = evaluateWatch(initialWatchState(STARTED_AT), read({
      remarks: [
        remark('old', '2026-10-07T11:00:00Z'),
        remark('own', '2026-10-07T12:05:00Z', 'agent-account'),
        remark('new', '2026-10-07T12:06:00Z'),
      ],
    }))
    expect(evaluation.news).toEqual([{ kind: 'remarks', remarks: [remark('new', '2026-10-07T12:06:00Z')] }])
    expect(evaluation.next.remarksThrough).toBe('2026-10-07T12:06:00Z')
  })

  test('an edited comment is news again by its edit time, and two remarks at one second are each told once', () => {
    const first = evaluateWatch(initialWatchState(STARTED_AT), read({ remarks: [remark('a', '2026-10-07T12:01:00Z')] }))
    const tie = evaluateWatch(first.next, read({
      remarks: [remark('a', '2026-10-07T12:01:00Z'), remark('b', '2026-10-07T12:01:00Z')],
    }))
    expect(tie.news).toEqual([{ kind: 'remarks', remarks: [remark('b', '2026-10-07T12:01:00Z')] }])
    const edited = evaluateWatch(tie.next, read({ remarks: [remark('a', '2026-10-07T12:09:00Z'), remark('b', '2026-10-07T12:01:00Z')] }))
    expect(edited.news).toEqual([{ kind: 'remarks', remarks: [remark('a', '2026-10-07T12:09:00Z')] }])
  })

  test('a read that did not ask for remarks keeps the watermark', () => {
    const first = evaluateWatch(initialWatchState(STARTED_AT), read({ remarks: [remark('a', '2026-10-07T12:01:00Z')] }))
    const skipped = evaluateWatch(first.next, read({ remarks: null }))
    expect(skipped.news).toEqual([])
    expect(skipped.next.remarksThrough).toBe('2026-10-07T12:01:00Z')
  })

  test('only remarks, wake after wake, end the watch; other news resets the count', () => {
    let state = initialWatchState(STARTED_AT)
    for (let index = 1; index < REMARK_ONLY_WAKE_LIMIT; index++) {
      const evaluation = evaluateWatch(state, read({ remarks: [remark(`r${index}`, `2026-10-07T13:${String(index).padStart(2, '0')}:00Z`)] }))
      expect(evaluation.end).toBeNull()
      state = evaluation.next
    }
    const reset = evaluateWatch(state, read({ mergeable: false, remarks: [remark('x', '2026-10-07T14:00:00Z')] }))
    expect(reset.next.remarkOnlyWakes).toBe(0)
    const last = evaluateWatch(state, read({ remarks: [remark('y', '2026-10-07T14:00:00Z')] }))
    expect(last.end).toBe('remark-limit')
  })

  test('a merge ends the watch quietly; a close ends it with news', () => {
    expect(evaluateWatch(initialWatchState(STARTED_AT), read({ state: 'merged' }))).toMatchObject({ news: [], end: 'merged' })
    expect(evaluateWatch(initialWatchState(STARTED_AT), read({ state: 'closed' }))).toMatchObject({ news: [{ kind: 'closed' }], end: 'closed' })
  })
})

describe('PR watch wake text', () => {
  test('names the pull request, lists each item with its link, and says how to stop', () => {
    const text = wakeText({ number: 42, url: 'https://github.com/solus/app/pull/42', headSha: 'abcdef123' }, [
      { kind: 'checks-failed', checks: [check('build', 'failure')] },
      { kind: 'remarks', remarks: [{ ...remark('a', '2026-10-07T12:01:00Z'), body: '<!-- bot -->Please   rename this', path: 'src/a.ts', url: 'https://github.com/c/1' }] },
    ], null)
    expect(text).toContain('pull request #42 (https://github.com/solus/app/pull/42)')
    expect(text).toContain('head abcdef1')
    expect(text).toContain('build (GitHub Actions): failure — https://ci.example/build')
    expect(text).toContain('reviewer on src/a.ts: "Please rename this" — https://github.com/c/1')
    expect(text).toContain('watch_pull_request with watching=false')
  })

  test('a long list is cut at ten items', () => {
    const many = Array.from({ length: 13 }, (_, index) => check(`c${index}`, 'failure'))
    const text = wakeText({ number: 1, url: 'u', headSha: 'h' }, [{ kind: 'checks-failed', checks: many }], null)
    expect(text).toContain('and 3 more')
    expect(text).not.toContain('c12')
  })
})
