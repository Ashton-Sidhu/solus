import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { IpcContext } from '@solus/contracts/types'
import type { PrReviewTarget } from '@solus/contracts/providers'

/**
 * A pull request link opens its review at once. The click must not wait on
 * the code host: the pane appears first and fills when the review target
 * lands. What the client already knows decides the rest — a link to a
 * repository this project does not read goes to the browser without asking
 * the host, and a pull request the host refuses closes and opens its page.
 */

mock.module('@solus/workspace-ui/lib/analytics', () => ({ track: () => {} }))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousWindow = (globalThis as unknown as { window?: unknown }).window
const openedExternally: string[] = []
let PrReviewActions: typeof import('@solus/workspace-ui/contexts/workspace/pr-review-actions')['PrReviewActions']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value, raw: <T>(value: T) => value },
  )
  ;({ PrReviewActions } = await import('@solus/workspace-ui/contexts/workspace/pr-review-actions'))
  // `localApi` reads the bridge at call time, so it is stubbed only after the
  // import: modules loaded above probe a real window when it exists.
  ;(globalThis as unknown as { window: unknown }).window = {
    solus: { openExternal: (url: string) => { openedExternally.push(url) } },
  }
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: unknown }).window
  else (globalThis as unknown as { window: unknown }).window = previousWindow
})

beforeEach(() => {
  openedExternally.length = 0
})

const LINK = 'https://github.com/owner/repo/pull/7'
const OTHER_LINK = 'https://github.com/elsewhere/tool/pull/3'

function harness(opts: { projectRepository?: string | null } = {}) {
  const events: string[] = []
  let answer!: { resolve: (target: PrReviewTarget) => void; reject: (error: Error) => void }
  const ctx = { session: { projectPath: '/code/repo', workingDirectory: '/code/repo' } } as IpcContext
  const project = {
    repositoryKey: opts.projectRepository === undefined ? 'github.com/owner/repo' : opts.projectRepository,
    prFor: () => undefined,
    get: () => ({ prefetch: () => events.push('prefetch') }),
  }
  const workspace = {
    ctx,
    serverIdForContext: () => 'local',
    apiForContext: () => ({}),
    ctxForDirectory: () => ctx,
    pullRequests: {
      view: { tab: 'activity' },
      projects: { at: () => project, get: () => project },
    },
    router: {
      navigate: (ref: { params: { number: number } }) => events.push(`navigate:${ref.params.number}`),
      resolve: () => {
        events.push('resolve')
        return new Promise<PrReviewTarget>((resolve, reject) => { answer = { resolve, reject } })
      },
      dropResolved: () => events.push('drop'),
      closeSurfacesWhere: () => events.push('close'),
    },
  }
  const actions = new PrReviewActions(workspace as never)
  return { actions, events, answer: () => answer }
}

describe('opening a pull request link', () => {
  test('the pane opens before the code host answers', async () => {
    const { actions, events, answer } = harness()
    const open = actions.openPullRequest({ number: 7, url: LINK })

    expect(events).toEqual(['navigate:7', 'prefetch', 'resolve'])
    answer().resolve({ number: 7 } as PrReviewTarget)
    await open
    expect(openedExternally).toEqual([])
  })

  test('a link to a repository this project does not read opens in the browser without a host request', async () => {
    const { actions, events } = harness()
    await actions.openPullRequest({ number: 3, url: OTHER_LINK })

    expect(events).toEqual([])
    expect(openedExternally).toEqual([OTHER_LINK])
  })

  test('before the project knows its repository, the host decides', async () => {
    const { actions, events, answer } = harness({ projectRepository: null })
    const open = actions.openPullRequest({ number: 3, url: OTHER_LINK })

    expect(events[0]).toBe('navigate:3')
    answer().reject(new Error('This link belongs to elsewhere/tool, not owner/repo'))
    await open
    expect(events).toContain('close')
    expect(openedExternally).toEqual([OTHER_LINK])
  })

  test('a pull request the host refuses closes its pane and opens its page', async () => {
    const { actions, events, answer } = harness()
    const open = actions.openPullRequest({ number: 7, url: LINK })
    answer().reject(new Error('Resource not accessible by integration'))
    await open

    expect(events).toEqual(['navigate:7', 'prefetch', 'resolve', 'drop', 'close'])
    expect(openedExternally).toEqual([LINK])
  })
})

describe('resting the pointer on a pull request link', () => {
  test('reads the review target and Activity without opening a pane', () => {
    const { actions, events } = harness()
    actions.warmPullRequest({ number: 7, url: LINK })

    expect(events).toEqual(['resolve', 'prefetch'])
  })

  test('reads nothing for a repository this project does not read', () => {
    const { actions, events } = harness()
    actions.warmPullRequest({ number: 3, url: OTHER_LINK })

    expect(events).toEqual([])
  })
})
