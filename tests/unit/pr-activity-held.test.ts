import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { PrCommit, PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import type { IpcContext } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'
import type { PrReviewDeps } from '@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte'

// The pull request holds its activity as last read. The mirrors under it only
// pace round trips and forget an answer after thirty seconds, so before this a
// review opened again a minute later re-drew every skeleton and rebuilt a
// timeline of hundreds of cards from nothing. These tests say what is kept,
// and that the review and the Activity feed share one copy of the threads.

interface RuneGlobals {
  $state?: unknown
  $derived?: unknown
}
const previousState = (globalThis as unknown as RuneGlobals).$state
const previousDerived = (globalThis as unknown as RuneGlobals).$derived

beforeEach(() => {
  ;(globalThis as unknown as RuneGlobals).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;(globalThis as unknown as RuneGlobals).$derived = Object.assign(
    <T>(value: T) => value,
    { by: <T>(fn: () => T) => fn() },
  )
})

afterEach(() => {
  setSystemTime()
  if (previousState === undefined) delete (globalThis as unknown as RuneGlobals).$state
  else (globalThis as unknown as RuneGlobals).$state = previousState
  if (previousDerived === undefined) delete (globalThis as unknown as RuneGlobals).$derived
  else (globalThis as unknown as RuneGlobals).$derived = previousDerived
})

const ctx = {
  session: { projectPath: '/repos/a', workingDirectory: '/repos/a' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

const NO_CHECKS = {
  prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
  prGuideMetadata: async () => null,
}

function thread(id: string): ReviewThread {
  return {
    id,
    filePath: 'src/a.ts',
    line: 1,
    side: 'RIGHT',
    isResolved: false,
    isOutdated: false,
    comments: [],
  }
}

const commit: PrCommit = { sha: 'a'.repeat(40), message: 'First', author: 'author', committedAt: '2026-01-01T10:00:00Z' }
const comment = { kind: 'comment', id: 'c1', body: 'Looks good', author: 'reviewer', createdAt: '2026-01-01T11:00:00Z' } as PrConversationItem

async function pullRequestOver(api: ReturnType<typeof asHostApi>) {
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore().get(api, 'host-a', ctx).get(65)
}

describe('a pull request keeps its activity as last read', () => {
  test('a surface that mounts after the mirror window paints the last answer at once', async () => {
    setSystemTime(new Date('2026-09-30T10:00:00Z'))
    let commentReads = 0
    const api = asHostApi({
      prListCommits: async () => [commit],
      prListComments: async () => {
        commentReads += 1
        return commentReads === 1 ? [comment] : [comment, { ...comment, id: 'c2' }]
      },
      prChangedFiles: async () => [],
      ...NO_CHECKS,
    })
    const pullRequest = await pullRequestOver(api)
    await pullRequest.loadCommits()
    await pullRequest.loadComments()
    await pullRequest.loadChangedFiles()

    // Past the mirror's thirty seconds: the mirror has nothing fresh to give.
    setSystemTime(new Date('2026-09-30T10:05:00Z'))
    const held = pullRequest.cachedActivity()
    expect(held.commits).toEqual([commit])
    expect(held.comments).toEqual([comment])
    expect(held.changedFiles).toEqual([])

    // The re-read the surface makes anyway replaces the held answer.
    await pullRequest.loadComments()
    expect(commentReads).toBe(2)
    expect(pullRequest.cachedActivity().comments?.map((item) => item.id)).toEqual(['c1', 'c2'])
  })

  test('a failed re-read keeps what is already shown', async () => {
    setSystemTime(new Date('2026-09-30T10:00:00Z'))
    let fail = false
    const api = asHostApi({
      prListComments: async () => {
        if (fail) throw new Error('offline')
        return [comment]
      },
      ...NO_CHECKS,
    })
    const pullRequest = await pullRequestOver(api)
    await pullRequest.loadComments()

    setSystemTime(new Date('2026-09-30T10:05:00Z'))
    fail = true
    await expect(pullRequest.loadComments()).rejects.toThrow('offline')
    expect(pullRequest.cachedActivity().comments).toEqual([comment])
  })
})

describe('the review reads the pull request’s threads', () => {
  test('the review and the Activity feed hold one copy, so a reply in one is in the other', async () => {
    const api = asHostApi({
      prListThreads: async () => [thread('t1'), thread('t2')],
      ...NO_CHECKS,
    })
    const pullRequest = await pullRequestOver(api)
    const { PrReviewState } = await import('@solus/workspace-ui/components/pr-review/lib/pr-review.store.svelte')
    const unused = () => {
      throw new Error('not relevant')
    }
    const deps: PrReviewDeps = {
      getApi: unused,
      fallbackCtx: () => ctx,
      ctxForDirectory: unused,
      threadSource: () => pullRequest,
      loadDiff: unused,
      prepareCheckout: unused,
      loadInterdiff: unused,
      diffStats: unused,
      replyThread: unused,
      resolveThread: unused,
    }
    const review = new PrReviewState(65, deps)

    expect(review.threads).toEqual([])
    review.loadThreads()
    await pullRequest.loadThreads()

    expect(review.threads).toBe(pullRequest.threads!)
    review.threads[0].isResolved = true
    expect(pullRequest.threads?.[0].isResolved).toBe(true)
    expect(review.unresolvedCount).toBe(1)
  })
})
