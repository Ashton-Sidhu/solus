import { afterEach, describe, expect, test } from 'bun:test'
import type { PullRequestSummary } from '../../src/shared/providers'
import type { IpcContext } from '../../src/shared/types'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const ctx = {
  session: { projectPath: '/repo', workingDirectory: '/repo' },
  window: {},
  settings: {},
  statusBar: {},
} as IpcContext

function listItem(): PullRequestSummary {
  return {
    number: 33,
    title: 'Keep host selection stable',
    headSha: 'head-33',
    author: 'sidhu',
    authorAvatarUrl: '',
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    draft: false,
    labels: [],
    additions: 0,
    deletions: 0,
  }
}

function installWindow(prGetEfforts: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      solus: {
        prList: async () => ({ items: [listItem()], page: 1, hasMore: false }),
        prGetEfforts,
        prChecks: async () => { throw new Error('not relevant') },
        prGuideMetadata: async () => { throw new Error('not relevant') },
      },
    },
  })
}

function installStateRune(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
}

describe('PR list effort metadata', () => {
  test('keeps diff totals when a later list refresh recreates the same PR head', async () => {
    // WHY: GitHub list responses omit diff totals. Once the visible-row fetch
    // enriches a head, refreshing the list must not replace those facts with 0/0.
    installStateRune()
    let effortCalls = 0
    installWindow(async () => {
      effortCalls++
      return [{
        number: 33,
        headSha: 'head-33',
        additions: 71_029,
        deletions: 22_450,
        effort: { band: 'involved', minutes: 60, signals: ['large'] },
      }]
    })
    const { PrsStore } = await import('../../src/renderer/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    await store.loadAll(ctx)
    await store.loadEfforts(ctx, [33])
    await store.loadAll(ctx, { force: true })
    await store.loadEfforts(ctx, [33])

    expect(store.get(33)?.additions).toBe(71_029)
    expect(store.get(33)?.deletions).toBe(22_450)
    expect(effortCalls).toBe(1)
  })

  test('does not cache an unavailable enrichment as successfully loaded', async () => {
    // WHY: a transient host failure must remain retryable instead of pinning a
    // real PR to the list endpoint's placeholder 0/0 for the store lifetime.
    installStateRune()
    let effortCalls = 0
    installWindow(async () => {
      effortCalls++
      return effortCalls === 1
        ? [{ number: 33, headSha: 'head-33' }]
        : [{
            number: 33,
            headSha: 'head-33',
            additions: 12,
            deletions: 4,
            effort: { band: 'quick', minutes: 4, signals: ['tiny'] },
          }]
    })
    const { PrsStore } = await import('../../src/renderer/contexts/prs/prs.store.svelte')
    const store = new PrsStore()

    await store.loadAll(ctx)
    await store.loadEfforts(ctx, [33])
    await store.loadEfforts(ctx, [33])

    expect(store.get(33)?.additions).toBe(12)
    expect(store.get(33)?.deletions).toBe(4)
    expect(effortCalls).toBe(2)
  })
})
