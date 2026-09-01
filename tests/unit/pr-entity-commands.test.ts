import { afterEach, describe, expect, test } from 'bun:test'
import type { PrConversationItem, ReviewThread } from '@solus/contracts/providers'
import type { IpcContext, PrMergeResult } from '@solus/contracts/types'
import { asHostApi } from '@solus/client-core/host-api'

import { pullRequestFixture } from './__fixtures__/pull-request'

// These commands change a pull request, so what they return has to reach the
// index every surface reads. Before they lived on the entity, the merge button
// posted the merge itself and handed the result up through three components;
// the pull request reached the index only if each of them remembered to pass
// it on. `solus/no-pr-context-escapes` now rejects that call shape, and these
// tests say what the entity does instead.

const previousState = (globalThis as unknown as { $state?: unknown }).$state

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function ctxFor(projectPath: string): IpcContext {
  return {
    session: { projectPath, workingDirectory: projectPath },
    window: {},
    settings: {},
    statusBar: {},
  } as IpcContext
}

const NO_CHECKS = {
  prChecks: async () => ({ repo: { host: 'github.com', owner: 'acme', repo: 'a' }, checks: [] }),
  prGuideMetadata: async () => null,
}

async function projectPrs(api: ReturnType<typeof asHostApi>) {
  const { PrsStore } = await import('@solus/workspace-ui/contexts/prs/prs.store.svelte')
  return new PrsStore().get(api, 'host-a', ctxFor('/repos/a'))
}

describe('a merge indexes what the pull request became', () => {
  test('a pre-merge refresh clears the host cache before it replaces the indexed detail', async () => {
    installStateRune()
    const calls: string[] = []
    const refreshed = pullRequestFixture(65, { headSha: 'sha-from-host' })
    const api = asHostApi({
      prInvalidate: async () => {
        calls.push('invalidate')
      },
      prGetDetail: async () => {
        calls.push('detail')
        return refreshed
      },
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    project.absorb(pullRequestFixture(65, { headSha: 'sha-from-list' }))

    await project.get(65).refreshDetail()

    expect(calls).toEqual(['invalidate', 'detail'])
    expect(project.prFor(65)?.headSha).toBe('sha-from-host')
  })

  test('the merged pull request reaches the index without the caller passing it on', async () => {
    installStateRune()
    const merged = pullRequestFixture(65, { state: 'merged', title: 'Landed' })
    const api = asHostApi({
      prMerge: async (): Promise<PrMergeResult> => ({ merged: true, detail: merged }),
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    project.absorb(pullRequestFixture(65, { state: 'open', title: 'Landed' }))

    await project.get(65).merge('squash')

    // The caller did nothing with the return value. A surface reading the index
    // still sees the merge, which is the whole point of moving the call here.
    expect(project.prFor(65)?.state).toBe('merged')
  })

  test('the head the index holds is the concurrency token, so a stale caller cannot pick one', async () => {
    installStateRune()
    let sentHeadSha: string | null = null
    const api = asHostApi({
      prMerge: async (_ctx: IpcContext, _number: number, _method: string, expectedHeadSha: string) => {
        sentHeadSha = expectedHeadSha
        return { merged: false, message: 'refused' }
      },
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    project.absorb(pullRequestFixture(65, { headSha: 'sha-from-the-index' }))

    await project.get(65).merge('squash')

    expect(sentHeadSha).toBe('sha-from-the-index')
  })

  test('a pull request nothing has read yet cannot be merged against a guessed head', async () => {
    installStateRune()
    let called = false
    const api = asHostApi({
      prMerge: async () => {
        called = true
        return { merged: true }
      },
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)

    // No facts, so no head to check the merge against. Refusing locally is
    // honest; sending an empty head would ask the host to merge whatever is
    // there now, which is the race the token exists to prevent.
    await expect(project.get(65).merge('squash')).rejects.toThrow()
    expect(called).toBe(false)
  })
})

describe('a write drops what it made wrong', () => {
  test('a reply makes the next read of the threads ask the host again', async () => {
    installStateRune()
    let threadReads = 0
    const threads: ReviewThread[] = []
    const api = asHostApi({
      prListThreads: async (): Promise<ReviewThread[]> => {
        threadReads += 1
        return threads
      },
      prReplyThread: async () => ({ id: 'c1', body: 'ok' }),
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    const pullRequest = project.get(65)

    await pullRequest.loadThreads()
    await pullRequest.loadThreads()
    // Two reads, one request: the mirror answered the second.
    expect(threadReads).toBe(1)

    await pullRequest.replyToThread('t1', 'looks good')
    await pullRequest.loadThreads()

    // The reply changed the threads, so the mirrored answer was dropped rather
    // than kept until it happened to expire.
    expect(threadReads).toBe(2)
  })

  test('resolving a thread drops the mirrored threads too', async () => {
    installStateRune()
    let threadReads = 0
    const api = asHostApi({
      prListThreads: async (): Promise<ReviewThread[]> => {
        threadReads += 1
        return []
      },
      prResolveThread: async () => undefined,
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    const pullRequest = project.get(65)

    await pullRequest.loadThreads()
    await pullRequest.setThreadResolved('t1', true)
    await pullRequest.loadThreads()

    expect(threadReads).toBe(2)
  })

  test('posting a comment drops the mirrored conversation', async () => {
    installStateRune()
    let commentReads = 0
    const api = asHostApi({
      prListComments: async (): Promise<PrConversationItem[]> => {
        commentReads += 1
        return []
      },
      prAddIssueComment: async () => undefined,
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    const pullRequest = project.get(65)

    await pullRequest.loadComments()
    await pullRequest.addComment('a note')
    await pullRequest.loadComments()

    // The caller does not have to force the re-read, so it cannot forget to.
    expect(commentReads).toBe(2)
  })

  test('a submitted review drops both the threads and the conversation it changed', async () => {
    installStateRune()
    let threadReads = 0
    let commentReads = 0
    const api = asHostApi({
      prListThreads: async (): Promise<ReviewThread[]> => {
        threadReads += 1
        return []
      },
      prListComments: async (): Promise<PrConversationItem[]> => {
        commentReads += 1
        return []
      },
      prSubmitReview: async () => undefined,
      ...NO_CHECKS,
    })

    const project = await projectPrs(api)
    const pullRequest = project.get(65)

    await pullRequest.loadThreads()
    await pullRequest.loadComments()
    await pullRequest.submitReview({
      body: 'ship it',
      event: 'APPROVE',
      commitId: 'sha-65',
      baseSha: 'base-65',
      comments: [],
    })
    await pullRequest.loadThreads()
    await pullRequest.loadComments()

    // A review body joins the conversation and its comments become threads, so
    // leaving either mirrored would show the surface a review that is not there.
    expect(threadReads).toBe(2)
    expect(commentReads).toBe(2)
  })
})
