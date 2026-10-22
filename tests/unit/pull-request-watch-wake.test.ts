import { describe, expect, test } from 'bun:test'
import type { CheckItem } from '@solus/contracts/checks-types'
import { pullRequestWatchWake, pullRequestWatchWakeSummary } from '@solus/client-core/pull-request-watch-wake'
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
      news: ['checks-failed', 'remarks'],
      ended: false,
      attention: true,
    })
    expect(pullRequestWatchWakeSummary(read!)).toBe('checks failed, new comments')
  })

  test('all clear is quiet; a conflict or a close needs the agent', () => {
    // WHY: the row's glyph takes a colour only when the agent must act. Green
    // news with a red glyph would send the reader to a row that needs nothing.
    const passed = wake([{ kind: 'checks-passed', checks: ['build'] }])
    expect(passed).toMatchObject({ news: ['checks-passed'], attention: false, ended: false })
    expect(pullRequestWatchWakeSummary(passed!)).toBe('checks passed')
    expect(wake([{ kind: 'conflicting' }])).toMatchObject({ news: ['conflicting'], attention: true })
    expect(pullRequestWatchWakeSummary(wake([{ kind: 'closed' }], 'closed')!)).toBe('closed, stopped watching')
  })

  test('an ended watch says so, including one the host could not read', () => {
    const limit = wake([{ kind: 'remarks', remarks: [] }], 'remark-limit')
    expect(limit).toMatchObject({ news: ['remarks'], ended: true })
    expect(pullRequestWatchWakeSummary(limit!)).toBe('new comments, stopped watching')
    const unreadable = wake([], 'unreadable')
    expect(unreadable).toMatchObject({ number: 42, url: PR.url, news: [], ended: true, attention: true })
    expect(pullRequestWatchWakeSummary(unreadable!)).toBe('could not be read, stopped watching')
  })

  test("a person's prompt is never a wake", () => {
    expect(pullRequestWatchWake('Update the pull request description, please.')).toBeNull()
    expect(pullRequestWatchWake('Solus is watching for you')).toBeNull()
    expect(pullRequestWatchWake('')).toBeNull()
  })
})
