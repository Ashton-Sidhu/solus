import { describe, expect, test } from 'bun:test'
import { prLinkDiscoveryAttempts } from '@solus/workspace-ui/contexts/workspace/pr-link-discovery'

describe('prLinkDiscoveryAttempts', () => {
  test('keeps every durable task attempt regardless of sidebar presentation', () => {
    // WHY: hiding or projecting a session elsewhere is view state. It must not
    // make that attached session's branch disappear from task-to-PR detection.
    expect(prLinkDiscoveryAttempts([
      { sessionId: 'older-hidden', branch: 'fix/older', isolatedCheckout: true, linkedAt: 1 },
      { sessionId: 'newer-visible', branch: 'fix/newer', isolatedCheckout: true, linkedAt: 2 },
    ], () => undefined)).toEqual([
      { sessionId: 'newer-visible', branchName: 'fix/newer', isolatedCheckout: true },
      { sessionId: 'older-hidden', branchName: 'fix/older', isolatedCheckout: true },
    ])
  })

  test('uses a mounted session live branch before its persisted branch', () => {
    // WHY: checkout can change while the tab is mounted, before the session
    // index refreshes the durable task snapshot.
    expect(prLinkDiscoveryAttempts([
      { sessionId: 'mounted', branch: 'stale-branch', isolatedCheckout: true, linkedAt: 1 },
    ], (sessionId) => sessionId === 'mounted' ? 'live-branch' : undefined)).toEqual([
      { sessionId: 'mounted', branchName: 'live-branch', isolatedCheckout: true },
    ])
  })

  test('a branch seen in a shared clone cannot claim a pull request', () => {
    // WHY: Git state is held per working directory, so every attempt open on
    // one clone reports whichever branch the developer last checked out. That
    // is a fact about the clone; treating it as the session's own attached one
    // feature branch to 33 unrelated tasks, most of them long finished.
    expect(prLinkDiscoveryAttempts([
      { sessionId: 'in-clone', branch: 'feature/today', isolatedCheckout: false, linkedAt: 1 },
    ], () => undefined)).toEqual([
      { sessionId: 'in-clone', branchName: 'feature/today', isolatedCheckout: false },
    ])
  })

  test('an attempt nothing can answer for claims nothing', () => {
    // WHY: an unindexed or optimistic attempt leaves the checkout unknown. An
    // unproven claim has to behave like no claim, not like a worktree.
    expect(prLinkDiscoveryAttempts([
      { sessionId: 'unindexed', branch: 'feature/unknown', linkedAt: 1 },
    ], () => undefined)).toEqual([
      { sessionId: 'unindexed', branchName: 'feature/unknown', isolatedCheckout: false },
    ])
  })
})
