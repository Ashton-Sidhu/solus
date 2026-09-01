import { describe, expect, test } from 'bun:test'
import {
  needsDiscoveredPrLink,
  prLinkDiscoveryAttempts,
  prLinkDiscoveryKey,
  type PrLinkDiscoveryInput,
} from '@solus/workspace-ui/contexts/workspace/pr-link-discovery'

function input(overrides: Partial<PrLinkDiscoveryInput> = {}): PrLinkDiscoveryInput {
  return {
    taskId: 'task-1',
    serverId: 'host-a',
    projectKey: '/repo',
    prNumbers: [],
    prUrls: [],
    branches: ['feature'],
    originSessionId: 'session-1',
    ...overrides,
  }
}

describe('prLinkDiscoveryKey', () => {
  test('is stable when task order changes', () => {
    // WHY: sidebar lifecycle updates can reorder rows. The same discovery
    // inputs must not start another host request.
    const first = input()
    const second = input({ taskId: 'task-2', branches: ['other'] })
    expect(prLinkDiscoveryKey([first, second])).toBe(prLinkDiscoveryKey([second, first]))
  })

  test('changes when a branch changes', () => {
    expect(prLinkDiscoveryKey([input({ branches: ['main'] })]))
      .not.toBe(prLinkDiscoveryKey([input({ branches: ['feature'] })]))
  })

  test('changes when the linked PR changes', () => {
    expect(prLinkDiscoveryKey([input({ prNumbers: [] })]))
      .not.toBe(prLinkDiscoveryKey([input({ prNumbers: [42, 43] })]))
  })
})

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

describe('needsDiscoveredPrLink', () => {
  const observed = { number: 65, url: 'https://github.com/acme/solus/pull/65' }

  test('does not re-send a pull request the task already records', () => {
    // WHY: the host answers every link write with a task detail payload, and
    // that payload is one of discovery's own inputs. Writing an edge the task
    // already holds makes each pass schedule the next one, which is what turned
    // one mounted checkout into thousands of `tasksLink` calls.
    expect(needsDiscoveredPrLink([{ number: 65, url: observed.url }], observed)).toBe(false)
  })

  test('ignores a link another session established for the same pull request', () => {
    // WHY: two mounted checkouts on one PR must not trade the row: the second
    // observer adds nothing the task does not already record.
    expect(needsDiscoveredPrLink([{
      number: 65,
      url: observed.url,
      createdBy: 'system',
      originSessionId: 'other-session',
    }], observed)).toBe(false)
  })

  test('writes when the task records the same number in another repository', () => {
    // WHY: PR numbers only identify a pull request together with its repo.
    expect(needsDiscoveredPrLink([{
      number: 65,
      url: 'https://github.com/acme/other/pull/65',
    }], observed)).toBe(true)
  })

  test('writes when the task records no url for that number', () => {
    // WHY: a migrated or snapshot-only edge cannot be confirmed as the same PR,
    // so discovery still repairs it.
    expect(needsDiscoveredPrLink([{ number: 65 }], observed)).toBe(true)
  })
})
