import { describe, expect, test } from 'bun:test'
import type { CheckItem } from '@solus/contracts/checks-types'
import { pullRequestWatchWake, pullRequestWatchWakeMarks, pullRequestWatchWakeSummary } from '@solus/client-core/pull-request-watch-wake'
import { wakeText, type WatchNews } from '@solus/server/prs/pr-watch-rules'

/**
 * The conversation draws a watch's wake as one row with the news in a few
 * words. The row reads the news back from the host's own text, so this runs
 * the host's template (`wakeText`) through the reader: a change to either
 * side that the other does not follow fails here.
 */

const PR = { number: 42, url: 'https://github.com/solus/app/pull/42', headSha: 'abcdef123' }

function failed(name: string): CheckItem {
  return { id: name, name, conclusion: 'failure', inFlight: false, detailsUrl: null, appName: null, startedAt: null, completedAt: null }
}

function wake(news: WatchNews[], end: Parameters<typeof wakeText>[2] = null) {
  return pullRequestWatchWake(wakeText(PR, news, end))
}

describe('pull request watch wake', () => {
  test('reads the pull request and each kind of news from the host text', () => {
    const read = wake([
      { kind: 'checks-failed', checks: [failed('build'), failed('lint')] },
      { kind: 'remarks', remarks: [{ id: 'a', kind: 'comment', author: 'reviewer', body: 'Please rename this', at: '2026-10-07T12:01:00Z' }] },
    ])
    expect(read).toEqual({
      number: 42,
      url: PR.url,
      news: [{ kind: 'checks-failed', count: 2 }, { kind: 'remarks', count: 1 }],
      ended: false,
      attention: true,
    })
    expect(pullRequestWatchWakeSummary(read!)).toBe('2 checks failed, 1 new comment')
  })

  test('all clear is quiet; a conflict or a close needs the agent', () => {
    // WHY: the row's glyph takes a colour only when the agent must act. Green
    // news with a red glyph would send the reader to a row that needs nothing.
    const passed = wake([{ kind: 'checks-passed', checks: ['build'] }])
    expect(passed).toMatchObject({ news: [{ kind: 'checks-passed', count: 1 }], attention: false, ended: false })
    expect(pullRequestWatchWakeSummary(passed!)).toBe('1 required check passed')
    expect(wake([{ kind: 'conflicting' }])).toMatchObject({ news: [{ kind: 'conflicting', count: null }], attention: true })
    expect(pullRequestWatchWakeSummary(wake([{ kind: 'closed' }], 'closed')!)).toBe('closed, stopped watching')
  })

  test('an ended watch says so, including one the host could not read', () => {
    const limit = wake([{ kind: 'remarks', remarks: [] }], 'remark-limit')
    expect(limit).toMatchObject({ news: [{ kind: 'remarks', count: 0 }], ended: true })
    expect(pullRequestWatchWakeSummary(limit!)).toBe('new comments, stopped watching')
    const unreadable = wake([], 'unreadable')
    expect(unreadable).toMatchObject({ number: 42, url: PR.url, news: [], ended: true, attention: true })
    expect(pullRequestWatchWakeSummary(unreadable!)).toBe('could not be read, stopped watching')
  })

  test('counts every check and remark past the list limit the host writes', () => {
    // WHY: the folded row shows the counts as figures beside each icon. A
    // count read short of the host's "and N more" tells the reader less is
    // wrong than is.
    const checks = Array.from({ length: 13 }, (_, index) => failed(`job ${index}`))
    const passedNames = ['build', 'test (ubuntu-latest, 20)', 'test (macos, 22)', ...Array.from({ length: 10 }, (_, index) => `lint ${index}`)]
    const read = wake([
      { kind: 'checks-failed', checks },
      { kind: 'checks-passed', checks: passedNames },
      { kind: 'all-checks-passed', checks: ['deploy preview (web, staging)', 'docs'] },
      { kind: 'no-checks', minutes: 15 },
    ])
    expect(read!.news).toEqual([
      { kind: 'checks-failed', count: 13 },
      { kind: 'checks-passed', count: 13 },
      { kind: 'all-checks-passed', count: 2 },
      { kind: 'no-checks', count: 15 },
    ])
    expect(read!.attention).toBe(true)
  })

  test('marks give each piece of news a figure and a distinct tone', () => {
    const read = wake(
      [
        { kind: 'checks-failed', checks: [failed('build')] },
        { kind: 'remarks', remarks: [{ id: 'a', kind: 'review', author: 'reviewer', body: 'Looks good', at: '2026-10-07T12:01:00Z' }] },
        { kind: 'no-checks', minutes: 20 },
      ],
      'remark-limit',
    )
    expect(pullRequestWatchWakeMarks(read!)).toEqual([
      { kind: 'checks-failed', figure: '1', tone: 'failing' },
      { kind: 'remarks', figure: '1', tone: 'review' },
      { kind: 'no-checks', figure: '20m', tone: 'pending' },
      { kind: 'stopped', figure: '', tone: 'quiet' },
    ])
    expect(pullRequestWatchWakeMarks(wake([{ kind: 'checks-passed', checks: ['build', 'test'] }])!)).toEqual([
      { kind: 'checks-passed', figure: '2', tone: 'passing' },
    ])
  })

  test("a person's prompt is never a wake", () => {
    expect(pullRequestWatchWake('Update the pull request description, please.')).toBeNull()
    expect(pullRequestWatchWake('Solus is watching for you')).toBeNull()
    expect(pullRequestWatchWake('')).toBeNull()
  })
})
