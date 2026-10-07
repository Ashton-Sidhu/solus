import { describe, expect, test } from 'bun:test'
import { buildWatchFingerprintsQuery, decodeWatchFingerprints } from '@solus/server/providers/github/watch-fingerprints'

function pullRequest(overrides: { headRefOid?: string; checkRuns?: Array<{ state: string; count: number }>; commentEdit?: string | null; comments?: number } = {}) {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    headRefOid: overrides.headRefOid ?? 'head-1',
    comments: { totalCount: overrides.comments ?? 2, nodes: [{ lastEditedAt: overrides.commentEdit ?? null }] },
    reviews: { totalCount: 1, nodes: [{ lastEditedAt: null }] },
    reviewThreads: { totalCount: 3 },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
      checkRunCountsByState: overrides.checkRuns ?? [{ state: 'IN_PROGRESS', count: 1 }, { state: 'SUCCESS', count: 2 }, { state: 'FAILURE', count: 0 }],
      statusContextCountsByState: [],
    } } } }] },
  }
}

describe('PR watch fingerprints', () => {
  test('one query reads every number of a repository by alias', () => {
    const query = buildWatchFingerprintsQuery([7, 12])
    expect(query).toContain('p7: pullRequest(number: 7)')
    expect(query).toContain('p12: pullRequest(number: 12)')
    expect(() => buildWatchFingerprintsQuery([0])).toThrow()
  })

  test('status moves with the head and the checks; remarks move with comments and edits', () => {
    const base = decodeWatchFingerprints({ repository: { p7: pullRequest() } }, [7]).get(7)
    const sameCountsReordered = decodeWatchFingerprints({ repository: { p7: pullRequest({ checkRuns: [{ state: 'SUCCESS', count: 2 }, { state: 'IN_PROGRESS', count: 1 }] }) } }, [7]).get(7)
    const finished = decodeWatchFingerprints({ repository: { p7: pullRequest({ checkRuns: [{ state: 'SUCCESS', count: 3 }] }) } }, [7]).get(7)
    const pushed = decodeWatchFingerprints({ repository: { p7: pullRequest({ headRefOid: 'head-2' }) } }, [7]).get(7)
    const edited = decodeWatchFingerprints({ repository: { p7: pullRequest({ commentEdit: '2026-10-07T12:00:00Z' }) } }, [7]).get(7)
    const commented = decodeWatchFingerprints({ repository: { p7: pullRequest({ comments: 3 }) } }, [7]).get(7)

    expect(sameCountsReordered).toEqual(base)
    expect(finished?.status).not.toBe(base?.status)
    expect(pushed?.status).not.toBe(base?.status)
    expect(edited?.remarks).not.toBe(base?.remarks)
    expect(edited?.status).toBe(base?.status)
    expect(commented?.remarks).not.toBe(base?.remarks)
  })

  test('a number GitHub did not answer, or answered in an unknown shape, is absent', () => {
    const fingerprints = decodeWatchFingerprints({ repository: { p7: pullRequest(), p8: null, p9: { state: 'OPEN' } } }, [7, 8, 9])
    expect([...fingerprints.keys()]).toEqual([7])
  })
})
