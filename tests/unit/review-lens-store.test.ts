import { afterEach, describe, expect, test } from 'bun:test'
import type { ReviewLensSnapshot, ReviewLensVersion } from '@solus/contracts/review'
import type { IpcContext } from '@solus/contracts/types'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'

// The store follows `review.lensChanged`, which never carries HTML: a job-only
// event updates the job in place, and a newer revision reads the snapshot again.

const previousState = (globalThis as unknown as { $state?: unknown }).$state
afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const HOST = 'host-a'
const ctx = { session: {} } as IpcContext

function version(title: string): ReviewLensVersion {
  return {
    lens: {
      version: 1, key: 'feature', target: { kind: 'branch' }, headSha: 'h', baseSha: 'b', changeFingerprint: 'f',
      generatedAt: '2026-09-25T00:00:00Z', source: { name: title, prompt: title }, edits: [], title, html: `<p>${title}</p>`,
    },
    comments: [],
  }
}

function snapshot(overrides: Partial<ReviewLensSnapshot> = {}): ReviewLensSnapshot {
  return {
    repoRoot: '/repo', key: 'feature', target: { kind: 'branch' }, current: version('First'),
    hasPrevious: false, outdated: false, job: null, revision: 5, ...overrides,
  }
}

async function setup(reads: ReviewLensSnapshot[]) {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  const { ReviewLensStore } = await import('@solus/workspace-ui/components/review/review-lens.store.svelte')
  const events = new HostEventSubscriber()
  let calls = 0
  const api = {
    readReviewLens: async () => reads[Math.min(calls++, reads.length - 1)],
    updateReviewLensComments: async () => ({ comments: [{ id: 'c1', pin: { x: 0, y: 0 }, label: '1', body: 'Hi', createdAt: 1 }], revision: 6 }),
  } as unknown as typeof window.solus
  const store = new ReviewLensStore(() => events, () => () => {})
  const subject = { api, serverId: HOST, ctx, target: { kind: 'branch' as const }, scopeKey: '/repo' }
  await store.load(subject)
  return { store, events, subject, reads: () => calls }
}

describe('ReviewLensStore', () => {
  test('a lens that existed on first read is not unread; a newer one that arrives by event is', async () => {
    const { store, events, subject } = await setup([
      snapshot({ job: { kind: 'generate', status: 'ready', updatedAt: 1 } }),
      snapshot({ current: version('Second'), revision: 9, job: { kind: 'generate', status: 'ready', updatedAt: 2 } }),
    ])
    expect(store.isUnread(subject)).toBe(false)
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/repo', key: 'feature', job: { kind: 'generate', status: 'ready', updatedAt: 2 }, revision: 9 }, occurredAt: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.entryFor(subject)?.snapshot?.current?.lens.title).toBe('Second')
    expect(store.isUnread(subject)).toBe(true)
    store.markSeen(subject)
    expect(store.isUnread(subject)).toBe(false)
  })

  test('a job-only event updates the job without reading the lens again', async () => {
    const { store, events, subject, reads } = await setup([snapshot()])
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/repo', key: 'feature', job: { kind: 'edit', status: 'generating', step: 'analyzing', updatedAt: 3 }, revision: 5 }, occurredAt: 3 })
    expect(store.entryFor(subject)?.snapshot?.job).toMatchObject({ kind: 'edit', status: 'generating', step: 'analyzing' })
    expect(reads()).toBe(1)
  })

  test('an event for another lens is ignored', async () => {
    const { store, events, subject } = await setup([snapshot()])
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/other', key: 'feature', job: { kind: 'generate', status: 'failed', updatedAt: 9 }, revision: 99 }, occurredAt: 9 })
    expect(store.entryFor(subject)?.snapshot?.job).toBeNull()
  })

  test('a comment change applies its comments and revision without reading the HTML again', async () => {
    const { store, subject, reads } = await setup([snapshot()])
    await store.changeComments(subject, { kind: 'add', comment: { pin: { x: 0, y: 0 }, label: '1', body: 'Hi' } })
    expect(store.entryFor(subject)?.snapshot?.current?.comments.map((comment) => comment.body)).toEqual(['Hi'])
    expect(store.entryFor(subject)?.snapshot?.revision).toBe(6)
    expect(reads()).toBe(1)
  })

  test('a host that has no checkout reads as loaded, not as loading forever', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { ReviewLensStore } = await import('@solus/workspace-ui/components/review/review-lens.store.svelte')
    const store = new ReviewLensStore(() => new HostEventSubscriber(), () => () => {})
    const api = { readReviewLens: async () => null } as unknown as typeof window.solus
    const subject = { api, serverId: HOST, ctx, target: { kind: 'branch' as const }, scopeKey: '/repo' }
    await store.load(subject)
    expect(store.entryFor(subject)).toMatchObject({ snapshot: null, loaded: true, loading: false })
  })
})
