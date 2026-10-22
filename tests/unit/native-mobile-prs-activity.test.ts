import { describe, expect, test } from 'bun:test'
import type { PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import { DEFAULT_ACTIVITY_FILTER, filterPullRequestActivity } from '../../apps/mobile/src/features/prs/lib/pull-request-activity'
import { isPullRequestTestFile } from '../../apps/mobile/src/features/prs/lib/pull-request-file-filters'

// The Activity filter hides noise, never a person's discussion; the Files
// filter hides tests by path, never a source file that only sounds like one.

const comment = (id: string, author: string, extra: Partial<PrConversationItem> = {}): PrConversationItem =>
  ({ id, author, createdAt: '2026-10-01T00:00:00Z', kind: 'comment', body: 'text', ...extra } as PrConversationItem)
const thread = (id: string, authors: string[], isResolved = false): ReviewThread => ({
  id, filePath: 'a.ts', line: 1, side: 'RIGHT', isResolved, isOutdated: false,
  comments: authors.map((author, index) => ({ id: `${id}-${index}`, author, body: 'x', createdAt: '' })),
})

describe('pull request activity filter (ported from T3)', () => {
  const activity = {
    comments: [comment('c1', 'ada'), comment('c2', 'ci[bot]'), comment('c3', 'ada', { kind: 'review', reviewState: 'DISMISSED' } as Partial<PrConversationItem>)],
    threads: [thread('t1', ['ada', 'ci[bot]']), thread('t2', ['ci[bot]']), thread('t3', ['ada'], true)],
    commits: [{ sha: 'abc', message: 'm', author: 'ada', committedAt: '' }],
  }

  test('the default hides bots, resolved threads, and dismissed reviews, and counts them', () => {
    const { activity: shown, hiddenCount } = filterPullRequestActivity(activity, DEFAULT_ACTIVITY_FILTER)
    expect(shown.comments.map((item) => item.id)).toEqual(['c1'])
    expect(shown.threads.map((item) => item.id)).toEqual(['t1'])
    expect(shown.commits).toHaveLength(1)
    expect(hiddenCount).toBe(4)
  })

  test('commits only and comments only', () => {
    expect(filterPullRequestActivity(activity, { ...DEFAULT_ACTIVITY_FILTER, kind: 'commits' }).activity).toEqual({ comments: [], threads: [], commits: activity.commits })
    expect(filterPullRequestActivity(activity, { ...DEFAULT_ACTIVITY_FILTER, kind: 'comments', bots: true, resolved: true }).activity.commits).toEqual([])
  })
})

test('recognizes test files across common languages, and not source names', () => {
  const tests = ['src/app.test.ts', 'src/__tests__/app.ts', 'tests/helpers/fixtures.json', 'e2e/login.ts', 'src/app.test.ts.snap', 'test_app.py', 'internal/app_test.go', 'spec/app_spec.rb', 'AppTests.swift', 'AppSpec.java', 'src\\__tests__\\app.ts']
  expect(tests.filter(isPullRequestTestFile)).toEqual(tests)
  expect(['src/testing.ts', 'src/contest.ts', 'latest/app.ts', 'tests.ts', 'specification.md', 'AppTest.ts'].filter(isPullRequestTestFile)).toEqual([])
})
