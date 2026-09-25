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
  const store = new ReviewLensStore((listener) => events.subscribe('review.lensChanged', (event) => listener(HOST, event)), () => () => {})
  store.follow()
  const subject = { api, serverId: HOST, ctx, target: { kind: 'branch' as const }, scopeKey: '/repo' }
  await store.load(subject)
  return { store, events, subject, reads: () => calls }
}

/** `loadPrRevisions` detaches its context with `$state.snapshot`. */
function withSnapshot() {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
}

describe('ReviewLensStore', () => {
  test('a lens that existed on first read is not unread; a newer one that arrives by event is', async () => {
    const { store, events, subject } = await setup([
      snapshot({ job: { kind: 'generate', status: 'ready', updatedAt: 1 } }),
      snapshot({ current: version('Second'), revision: 9, job: { kind: 'generate', status: 'ready', updatedAt: 2 } }),
    ])
    expect(store.isUnread(subject)).toBe(false)
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/repo', key: 'feature', target: { kind: 'branch' }, job: { kind: 'generate', status: 'ready', updatedAt: 2 }, revision: 9 }, occurredAt: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.entryFor(subject)?.snapshot?.current?.lens.title).toBe('Second')
    expect(store.isUnread(subject)).toBe(true)
    store.markSeen(subject)
    expect(store.isUnread(subject)).toBe(false)
  })

  test('a job-only event updates the job without reading the lens again', async () => {
    const { store, events, subject, reads } = await setup([snapshot()])
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/repo', key: 'feature', target: { kind: 'branch' }, job: { kind: 'edit', status: 'generating', step: 'analyzing', updatedAt: 3 }, revision: 5 }, occurredAt: 3 })
    expect(store.entryFor(subject)?.snapshot?.job).toMatchObject({ kind: 'edit', status: 'generating', step: 'analyzing' })
    expect(reads()).toBe(1)
  })

  test('an event for another lens is ignored', async () => {
    const { store, events, subject } = await setup([snapshot()])
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: '/other', key: 'feature', target: { kind: 'branch' }, job: { kind: 'generate', status: 'failed', updatedAt: 9 }, revision: 99 }, occurredAt: 9 })
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
    const store = new ReviewLensStore(() => () => {}, () => () => {})
    const api = { readReviewLens: async () => null } as unknown as typeof window.solus
    const subject = { api, serverId: HOST, ctx, target: { kind: 'branch' as const }, scopeKey: '/repo' }
    await store.load(subject)
    expect(store.entryFor(subject)).toMatchObject({ snapshot: null, loaded: true, loading: false })
  })

  // The PR list and the ready toast have no pane open, so they read jobs the
  // store follows on every host.
  const pr = { kind: 'pr' as const, host: 'github.com', owner: 'acme', repo: 'app', number: 7 }
  const prEvent = (status: 'queued' | 'generating' | 'ready', updatedAt: number, revision = 1) => ({
    type: 'review.lensChanged' as const,
    payload: { repoRoot: 'github.com/acme/app', key: 'pr-7', target: { ...pr, headSha: 'h2' }, job: { kind: 'generate' as const, status, updatedAt }, revision },
    occurredAt: updatedAt,
  })

  test('a PR job shows on its row with no pane open, and a ready one clears once opened', async () => {
    const { store, events } = await setup([snapshot()])
    events.receive(prEvent('generating', 10))
    // The row asks by pull request alone: a new head must not hide the job.
    expect(store.pullRequestJobFor(HOST, pr)?.status).toBe('generating')
    events.receive(prEvent('ready', 11, 2))
    expect(store.pullRequestJobFor(HOST, pr)?.status).toBe('ready')
    store.markSeen({ serverId: HOST, scopeKey: 'pr', target: pr })
    expect(store.pullRequestJobFor(HOST, pr)).toBeNull()
  })

  test('the PR list knows a saved lens from one probe, and a live event keeps it current', async () => {
    const { store, events } = await setup([snapshot()])
    withSnapshot()
    const other = { ...pr, number: 8 }
    let probes = 0
    const api = { prLensRevisions: async (_ctx: unknown, targets: unknown[]) => { probes++; return targets.map((_, i) => (i === 0 ? 3 : 0)) } } as unknown as typeof window.solus
    await store.loadPrRevisions(api, HOST, ctx, [pr, other])
    expect(store.hasSavedPrLens(HOST, pr)).toBe(true)
    expect(store.hasSavedPrLens(HOST, other)).toBe(false)
    // One probe per PR: a second list load does not ask again.
    await store.loadPrRevisions(api, HOST, ctx, [pr, other])
    expect(probes).toBe(1)
    // A lens made after the probe arrives as an event.
    events.receive({ type: 'review.lensChanged', payload: { repoRoot: 'x', key: 'pr-8', target: other, job: null, revision: 9 }, occurredAt: 9 })
    expect(store.hasSavedPrLens(HOST, other)).toBe(true)
  })

  test('a failed PR lens probe is asked again on the next list load', async () => {
    const { store } = await setup([snapshot()])
    withSnapshot()
    let fail = true
    const api = { prLensRevisions: async () => { if (fail) throw new Error('offline'); return [5] } } as unknown as typeof window.solus
    await store.loadPrRevisions(api, HOST, ctx, [pr])
    expect(store.hasSavedPrLens(HOST, pr)).toBe(false)
    fail = false
    await store.loadPrRevisions(api, HOST, ctx, [pr])
    expect(store.hasSavedPrLens(HOST, pr)).toBe(true)
  })

  test('ready notifies once, only for a run seen live', async () => {
    const { store, events } = await setup([snapshot()])
    const ready: number[] = []
    store.onReady((_serverId, event) => ready.push(event.job!.updatedAt))
    // A ready job re-sent by a comment change, with no run seen, is old news.
    events.receive(prEvent('ready', 5, 1))
    events.receive(prEvent('queued', 10, 1))
    events.receive(prEvent('generating', 11, 1))
    events.receive(prEvent('ready', 12, 2))
    events.receive(prEvent('ready', 12, 3))
    expect(ready).toEqual([12])
  })
})
