import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { DispositionPoster } from '@solus/workspace-ui/components/review-mode/lib/review-session-core'

const testGlobal = globalThis as unknown as { $state?: unknown; document?: unknown }
const previousState = testGlobal.$state
const previousDocument = testGlobal.document

beforeAll(() => {
  testGlobal.$state = <T>(value: T): T => value
  testGlobal.document ??= {}
})

afterAll(() => {
  if (previousState === undefined) delete testGlobal.$state
  else testGlobal.$state = previousState
  if (previousDocument === undefined) delete testGlobal.document
})

const poster: DispositionPoster = { post: async () => {} }

describe('ReviewSessionStore entering a pull request', () => {
  test('announces each pull request once, whichever command made it current', async () => {
    // WHY: Review Mode prepares a PR's worktree when the PR becomes current.
    // Every command that moves the queue must say so, and none may say it
    // twice, or a PR is prepared twice or never.
    const { ReviewSessionStore } = await import('@solus/workspace-ui/components/review-mode/review-session.store.svelte')
    const store = new ReviewSessionStore()
    const entered: number[] = []

    store.start({ numbers: [101, 102, 103], poster, onEnter: (number) => entered.push(number), visibilitySource: null })
    expect(entered).toEqual([101])

    store.next()
    store.visit(2)
    store.visit(2)
    store.prev()
    expect(entered).toEqual([101, 102, 103, 102])

    // A disposition advances the queue on its own; that is an entry too.
    store.dispose(102, 'approved')
    expect(entered).toEqual([101, 102, 103, 102, 103])

    // Reading state is not a move.
    store.heartbeat()
    expect(entered).toEqual([101, 102, 103, 102, 103])
    store.detach()
  })

  test('a new queue announces its first pull request even when it is the same one', async () => {
    const { ReviewSessionStore } = await import('@solus/workspace-ui/components/review-mode/review-session.store.svelte')
    const store = new ReviewSessionStore()
    const entered: number[] = []
    const onEnter = (number: number) => entered.push(number)

    store.start({ numbers: [101], poster, onEnter, visibilitySource: null })
    store.start({ numbers: [101, 102], poster, onEnter, visibilitySource: null })

    expect(entered).toEqual([101, 101])
    store.detach()
  })
})
